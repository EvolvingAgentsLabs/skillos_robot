/**
 * Dream Scenario Runner — Executes dream scenarios and produces traces
 *
 * Runs the full perception-action loop in a text-simulated environment:
 *
 * 1. TextSceneSimulator renders a text frame of the current scene
 * 2. DreamInferenceRouter processes the text scene as if it were camera frames
 * 3. BytecodeCompiler compiles the VLM output into a 6-byte command
 * 4. TextSceneSimulator applies the command and advances kinematics
 * 5. Repeat until goal reached, timeout, or stuck
 *
 * After each scenario, the runner writes hierarchical traces that the
 * DreamEngine can process for strategy consolidation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { HierarchyLevel, TraceOutcome, TraceSource } from '../../llmunix-core/types';
import { BytecodeCompiler, formatHex, encodeFrame, Opcode, OPCODE_NAMES } from '../../2_qwen_cerebellum/bytecode_compiler';
import { TextSceneSimulator, type DreamScenario, type TextFrame } from './text_scene';
import { DreamInferenceRouter, type DreamInferenceRouterConfig } from './dream_inference_router';

// =============================================================================
// Types
// =============================================================================

export interface ScenarioResult {
  scenarioId: string;
  title: string;
  outcome: TraceOutcome;
  reason: string;
  framesExecuted: number;
  maxFrames: number;
  finalPose: { x: number; y: number; heading: number };
  finalTargetDistance: number | null;
  goalReached: boolean;
  collisionCount: number;
  stuckCount: number;
  inferenceMode: 'gemini';
  durationMs: number;
  /** Per-frame log for trace generation */
  frameLog: FrameLogEntry[];
}

export interface FrameLogEntry {
  frameIndex: number;
  sceneText: string;
  vlmOutput: string;
  bytecodeHex: string;
  opcodeName: string;
  pose: { x: number; y: number; heading: number };
  targetDistance: number | null;
  collision: boolean;
}

export interface RunnerConfig {
  /** Inference mode — always 'gemini' */
  inferenceMode?: 'gemini';
  /** Google API key (required) */
  googleApiKey?: string;
  /** Directory to write traces */
  tracesDir: string;
  /** Whether to print live progress */
  verbose: boolean;
  /** Gemini model for image-based inference (robotics-er) */
  geminiModel?: string;
  /** Gemini model for text-only inference (flash-lite). Defaults to geminiModel. */
  textModel?: string;
  /** Number of consecutive identical opcodes to consider "stuck" */
  stuckThreshold?: number;
  /** Max consecutive stuck detections before aborting */
  maxStuckRetries?: number;
  /** Minimum spatial progress (cm) required to avoid stuck detection */
  stuckProgressThresholdCm?: number;
  /** Strategy steps to inject into the system prompt (Full Stack condition) */
  strategies?: string[];
  /** Negative constraints to inject into the system prompt (Full Stack condition) */
  constraints?: string[];
}

// =============================================================================
// Scenario Runner
// =============================================================================

const STOP_FRAME = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });

export class DreamScenarioRunner {
  private router: DreamInferenceRouter;
  private compiler: BytecodeCompiler;
  private config: RunnerConfig;
  private stuckThreshold: number;
  private maxStuckRetries: number;
  private stuckProgressThresholdCm: number;

  constructor(config: RunnerConfig) {
    this.config = config;
    this.stuckThreshold = config.stuckThreshold ?? 6;
    this.maxStuckRetries = config.maxStuckRetries ?? 3;
    this.stuckProgressThresholdCm = config.stuckProgressThresholdCm ?? 2.0;

    this.compiler = new BytecodeCompiler('fewshot');

    const routerConfig: DreamInferenceRouterConfig = {
      googleApiKey: config.googleApiKey,
      geminiModel: config.geminiModel,
      textModel: config.textModel,
      maxTokens: 128,
      temperature: 0.1,
      timeoutMs: 15000,
    };
    this.router = new DreamInferenceRouter(routerConfig);
  }

  /**
   * Run a single dream scenario.
   */
  async runScenario(scenario: DreamScenario): Promise<ScenarioResult> {
    const startTime = Date.now();
    const sim = new TextSceneSimulator(scenario);

    if (this.config.verbose) {
      console.log(`\n--- Dream Scenario: ${scenario.title} ---`);
      console.log(`Goal: ${scenario.goal}`);
      console.log(`Mode: gemini`);
    }

    const frameLog: FrameLogEntry[] = [];
    let collisionCount = 0;
    let stuckCount = 0;
    let consecutiveIdentical = 0;
    let lastOpcode = -1;
    let goalReached = false;
    let abortReason = '';
    let stuckCheckPose = { x: sim.getState().x, y: sim.getState().y };
    const recentOpcodes: number[] = []; // sliding window for oscillation detection

    // Get initial frame
    let currentFrame = sim.renderFrame();

    // Build system prompt (text-scene mode for dream simulation)
    let systemPrompt = this.compiler.getTextSceneSystemPrompt(scenario.goal);

    // Inject strategies and constraints (Full Stack condition)
    if (this.config.strategies && this.config.strategies.length > 0) {
      systemPrompt += '\n\n## Learned Navigation Strategies\n';
      for (const step of this.config.strategies) {
        systemPrompt += `- ${step}\n`;
      }
    }
    if (this.config.constraints && this.config.constraints.length > 0) {
      systemPrompt += '\n\n## Negative Constraints (NEVER do these)\n';
      for (const c of this.config.constraints) {
        systemPrompt += `- ${c}\n`;
      }
    }

    for (let i = 0; i < scenario.maxFrames; i++) {
      // Build the user message with scene context + frame history
      const userMessage = this.buildUserMessage(currentFrame, frameLog);

      // Inference
      let vlmOutput: string;
      try {
        vlmOutput = await this.router.infer(systemPrompt, userMessage);
      } catch (err) {
        vlmOutput = 'TOOLCALL:{"name":"stop","args":{}}';
        if (this.config.verbose) {
          console.log(`  [!] Inference error at frame ${i}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Compile to bytecode
      let bytecode = this.compiler.compile(vlmOutput);
      if (!bytecode) {
        bytecode = STOP_FRAME;
        if (this.config.verbose) {
          console.log(`  [!] Compilation failed at frame ${i}, using STOP`);
        }
      }

      // Apply to simulator
      currentFrame = sim.step(bytecode);

      // Extract opcode for stuck detection
      const opcode = bytecode[1];
      const opcodeName = OPCODE_NAMES[opcode] || `0x${opcode.toString(16).toUpperCase()}`;

      // Log frame
      frameLog.push({
        frameIndex: i,
        sceneText: currentFrame.sceneText,
        vlmOutput: vlmOutput.slice(0, 200),
        bytecodeHex: formatHex(bytecode),
        opcodeName,
        pose: { ...currentFrame.pose },
        targetDistance: currentFrame.targetDistance,
        collision: currentFrame.collision,
      });

      if (currentFrame.collision) collisionCount++;

      // Stuck detection — progress-aware
      if (opcode === lastOpcode && opcode !== Opcode.STOP) {
        consecutiveIdentical++;
      } else {
        consecutiveIdentical = 0;
      }
      lastOpcode = opcode;

      if (consecutiveIdentical >= this.stuckThreshold) {
        // Check spatial progress before declaring stuck
        const currentPose = currentFrame.pose;
        const dx = currentPose.x - stuckCheckPose.x;
        const dy = currentPose.y - stuckCheckPose.y;
        const spatialProgress = Math.sqrt(dx * dx + dy * dy);

        if (spatialProgress < this.stuckProgressThresholdCm) {
          // Truly stuck — no spatial progress
          stuckCount++;
          consecutiveIdentical = 0;
          if (this.config.verbose) {
            console.log(`  [!] Stuck detected (${stuckCount}/${this.maxStuckRetries}) — progress: ${spatialProgress.toFixed(1)}cm`);
          }
          if (stuckCount >= this.maxStuckRetries) {
            abortReason = `Stuck: ${stuckCount} consecutive stuck detections (${this.stuckThreshold} identical opcodes, <${this.stuckProgressThresholdCm}cm progress)`;
            break;
          }
        } else {
          // Making spatial progress despite identical opcodes — not stuck
          consecutiveIdentical = 0;
          if (this.config.verbose) {
            console.log(`  [i] Same opcode ${this.stuckThreshold}x but making progress (${spatialProgress.toFixed(1)}cm) — not stuck`);
          }
        }
        stuckCheckPose = { x: currentPose.x, y: currentPose.y };
      }

      // Oscillation detection — complementary pair pattern (A-B-A-B)
      recentOpcodes.push(opcode);
      if (recentOpcodes.length > 4) recentOpcodes.shift();
      if (recentOpcodes.length === 4 && this.isOscillating(recentOpcodes)) {
        stuckCount++;
        recentOpcodes.length = 0; // reset window
        if (this.config.verbose) {
          console.log(`  [!] Oscillation detected (${stuckCount}/${this.maxStuckRetries})`);
        }
        if (stuckCount >= this.maxStuckRetries) {
          abortReason = `Oscillation: ${stuckCount} oscillation detections (alternating complementary opcodes)`;
          break;
        }
      }

      // Goal check
      if (currentFrame.goalReached) {
        goalReached = true;
        if (this.config.verbose) {
          console.log(`  [*] Goal reached at frame ${i}!`);
        }
        break;
      }

      // STOP opcode = arrival declaration
      if (opcode === Opcode.STOP) {
        if (currentFrame.targetDistance !== null && currentFrame.targetDistance <= scenario.goalThresholdCm * 1.5) {
          goalReached = true;
          if (this.config.verbose) {
            console.log(`  [*] Arrival declared at frame ${i} (distance: ${currentFrame.targetDistance?.toFixed(1)}cm)`);
          }
        } else {
          if (this.config.verbose) {
            console.log(`  [?] STOP issued but target distance ${currentFrame.targetDistance?.toFixed(1)}cm > threshold`);
          }
        }
        break;
      }

      if (this.config.verbose && i % 5 === 0) {
        const dist = currentFrame.targetDistance?.toFixed(0) ?? '?';
        console.log(`  Frame ${i}: ${opcodeName} | pose=(${currentFrame.pose.x}, ${currentFrame.pose.y}, ${currentFrame.pose.heading}°) | dist=${dist}cm`);
      }
    }

    const durationMs = Date.now() - startTime;
    const framesExecuted = frameLog.length;

    // Determine outcome
    let outcome: TraceOutcome;
    let reason: string;

    if (goalReached) {
      outcome = TraceOutcome.SUCCESS;
      reason = `Goal reached at frame ${framesExecuted} (distance: ${currentFrame.targetDistance?.toFixed(1)}cm)`;
    } else if (abortReason) {
      outcome = TraceOutcome.FAILURE;
      reason = abortReason;
    } else if (framesExecuted >= scenario.maxFrames) {
      outcome = TraceOutcome.FAILURE;
      reason = `Timeout: ${scenario.maxFrames} frames exceeded`;
    } else {
      outcome = TraceOutcome.PARTIAL;
      reason = `Ended at frame ${framesExecuted}`;
    }

    if (this.config.verbose) {
      console.log(`  Result: ${outcome} — ${reason}`);
      console.log(`  Collisions: ${collisionCount}, Stuck: ${stuckCount}, Duration: ${durationMs}ms`);
    }

    const result: ScenarioResult = {
      scenarioId: scenario.id,
      title: scenario.title,
      outcome,
      reason,
      framesExecuted,
      maxFrames: scenario.maxFrames,
      finalPose: { ...currentFrame.pose },
      finalTargetDistance: currentFrame.targetDistance,
      goalReached,
      collisionCount,
      stuckCount,
      inferenceMode: 'gemini',
      durationMs,
      frameLog,
    };

    // Write traces
    this.writeTraces(scenario, result);

    return result;
  }

  /**
   * Run all provided scenarios and return results.
   */
  async runAll(scenarios: DreamScenario[]): Promise<ScenarioResult[]> {
    const results: ScenarioResult[] = [];

    for (const scenario of scenarios) {
      try {
        const result = await this.runScenario(scenario);
        results.push(result);
      } catch (err) {
        console.error(`Scenario "${scenario.title}" failed with error: ${err instanceof Error ? err.message : String(err)}`);
        results.push({
          scenarioId: scenario.id,
          title: scenario.title,
          outcome: TraceOutcome.FAILURE,
          reason: `Error: ${err instanceof Error ? err.message : String(err)}`,
          framesExecuted: 0,
          maxFrames: scenario.maxFrames,
          finalPose: { ...scenario.startPose },
          finalTargetDistance: null,
          goalReached: false,
          collisionCount: 0,
          stuckCount: 0,
          inferenceMode: 'gemini',
          durationMs: 0,
          frameLog: [],
        });
      }
    }

    return results;
  }

  /** Get inference router stats */
  getInferenceStats() {
    return this.router.getStats();
  }

  // ---------------------------------------------------------------------------
  // User message construction
  // ---------------------------------------------------------------------------

  private buildUserMessage(currentFrame: TextFrame, history: FrameLogEntry[]): string {
    const parts: string[] = [];

    // Compact action history (last 5 frames: action + distance delta + collision)
    const recentFrames = history.slice(-5);
    if (recentFrames.length > 0) {
      parts.push(`ACTION HISTORY (last ${recentFrames.length} frames):`);
      for (let i = 0; i < recentFrames.length; i++) {
        const f = recentFrames[i];
        const prevDist = i > 0 ? recentFrames[i - 1].targetDistance : (history.length > recentFrames.length ? history[history.length - recentFrames.length - 1].targetDistance : null);
        let delta = '';
        if (f.targetDistance !== null && prevDist !== null) {
          const d = f.targetDistance - prevDist;
          delta = ` delta=${d >= 0 ? '+' : ''}${d.toFixed(1)}cm`;
        }
        const coll = f.collision ? ' COLLISION' : '';
        parts.push(`  F${f.frameIndex}: ${f.opcodeName} dist=${f.targetDistance?.toFixed(0) ?? '?'}cm${delta}${coll}`);
      }

      // Stuck warning: last 3 actions identical
      if (recentFrames.length >= 3) {
        const last3 = recentFrames.slice(-3);
        if (last3.every(f => f.opcodeName === last3[0].opcodeName)) {
          parts.push(`  ** STUCK WARNING: same action "${last3[0].opcodeName}" repeated 3x. CHANGE STRATEGY. **`);
        }
      }

      // Oscillation warning: A-B-A-B alternating pattern in last 4 actions
      if (recentFrames.length >= 4) {
        const last4 = recentFrames.slice(-4);
        if (
          last4[0].opcodeName === last4[2].opcodeName &&
          last4[1].opcodeName === last4[3].opcodeName &&
          last4[0].opcodeName !== last4[1].opcodeName
        ) {
          parts.push(`  ** OSCILLATION WARNING: alternating "${last4[0].opcodeName}" / "${last4[1].opcodeName}". Net zero progress. CHANGE STRATEGY. **`);
        }
      }

      // Progress summary
      if (recentFrames.length >= 2) {
        const firstDist = recentFrames[0].targetDistance;
        const lastDist = recentFrames[recentFrames.length - 1].targetDistance;
        if (firstDist !== null && lastDist !== null) {
          const totalDelta = lastDist - firstDist;
          if (totalDelta < -2) {
            parts.push(`  Progress: Good, ${Math.abs(totalDelta).toFixed(0)}cm closer over last ${recentFrames.length} frames.`);
          } else if (totalDelta > 2) {
            parts.push(`  Progress: MOVING AWAY. ${totalDelta.toFixed(0)}cm farther. CHANGE STRATEGY.`);
          } else {
            parts.push(`  Progress: NOT making progress. CHANGE STRATEGY.`);
          }
        }
      }

      parts.push('');
    }

    // Current frame: full two-pass scene text
    parts.push(`CURRENT FRAME (frame ${currentFrame.frameIndex}):`);
    parts.push(currentFrame.sceneText);
    parts.push('');
    parts.push('What is your next motor command? Call exactly one tool function.');

    return parts.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Oscillation detection helpers
  // ---------------------------------------------------------------------------

  /** Check if a 4-opcode window shows A-B-A-B oscillation pattern */
  private isOscillating(opcodes: number[]): boolean {
    if (opcodes.length < 4) return false;
    return (
      opcodes[0] === opcodes[2] &&
      opcodes[1] === opcodes[3] &&
      opcodes[0] !== opcodes[1] &&
      this.isComplementaryPair(opcodes[0], opcodes[1])
    );
  }

  /** Check if two opcodes are complementary (would cancel each other out) */
  private isComplementaryPair(a: number, b: number): boolean {
    const pairs: [number, number][] = [
      [Opcode.ROTATE_CW, Opcode.ROTATE_CCW],
      [Opcode.MOVE_FORWARD, Opcode.MOVE_BACKWARD],
      [Opcode.TURN_LEFT, Opcode.TURN_RIGHT],
    ];
    return pairs.some(([p, q]) => (a === p && b === q) || (a === q && b === p));
  }

  // ---------------------------------------------------------------------------
  // Trace writing
  // ---------------------------------------------------------------------------

  private writeTraces(scenario: DreamScenario, result: ScenarioResult): void {
    if (!fs.existsSync(this.config.tracesDir)) {
      fs.mkdirSync(this.config.tracesDir, { recursive: true });
    }

    const today = new Date().toISOString().slice(0, 10);
    const traceFile = path.join(this.config.tracesDir, `trace_${today}.md`);

    const now = new Date().toISOString();
    const traceId = `tr_dream_${scenario.id}_${Date.now()}`;
    const parentTraceId = `tr_dream_session_${today}`;

    const lines: string[] = [];

    // Write GOAL-level trace for the scenario
    lines.push('---');
    lines.push(`### Time: ${now}`);
    lines.push(`**Trace ID:** ${traceId}`);
    lines.push(`**Level:** ${HierarchyLevel.GOAL}`);
    lines.push(`**Parent:** ${parentTraceId}`);
    lines.push(`**Goal:** [DREAM] ${scenario.goal}`);
    lines.push(`**Scene:** ${scenario.description}`);
    lines.push(`**Outcome:** ${result.outcome}`);
    lines.push(`**Reason:** ${result.reason}`);
    lines.push(`**Duration:** ${result.durationMs}`);
    lines.push(`**Confidence:** ${result.goalReached ? 0.8 : 0.3}`);
    lines.push(`**Strategy:** dream_${scenario.id}`);
    lines.push(`**Source:** ${TraceSource.DREAM_TEXT}`);
    lines.push('');

    // Write individual frame actions as VLM/Bytecode entries
    // Sample up to 20 frames to keep traces manageable
    const sampleRate = Math.max(1, Math.floor(result.frameLog.length / 20));
    const sampledFrames = result.frameLog.filter((_, i) => i % sampleRate === 0 || i === result.frameLog.length - 1);

    for (const frame of sampledFrames) {
      lines.push(`**VLM Reasoning:** ${frame.vlmOutput}`);
      lines.push(`**Compiled Bytecode:** \`${frame.bytecodeHex}\``);
    }

    lines.push('');

    // Append to trace file
    fs.appendFileSync(traceFile, lines.join('\n'));
  }
}

// =============================================================================
// Report Generation
// =============================================================================

export function generateDreamReport(results: ScenarioResult[]): string {
  const lines: string[] = [];
  lines.push('=== Dream Simulation Report ===\n');

  const successes = results.filter(r => r.outcome === TraceOutcome.SUCCESS).length;
  const failures = results.filter(r => r.outcome === TraceOutcome.FAILURE).length;
  const partials = results.filter(r => r.outcome === TraceOutcome.PARTIAL).length;
  const totalFrames = results.reduce((s, r) => s + r.framesExecuted, 0);
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

  lines.push(`Scenarios: ${results.length} total, ${successes} success, ${failures} failure, ${partials} partial`);
  lines.push(`Total frames: ${totalFrames}`);
  lines.push(`Total time: ${(totalMs / 1000).toFixed(1)}s`);
  lines.push('');

  for (const r of results) {
    const icon = r.outcome === TraceOutcome.SUCCESS ? '[OK]' : r.outcome === TraceOutcome.FAILURE ? '[FAIL]' : '[PART]';
    lines.push(`${icon} ${r.title}`);
    lines.push(`    ${r.reason}`);
    lines.push(`    Frames: ${r.framesExecuted}/${r.maxFrames} | Collisions: ${r.collisionCount} | Stuck: ${r.stuckCount}`);
    lines.push(`    Final pose: (${r.finalPose.x}, ${r.finalPose.y}, ${r.finalPose.heading}°) | Target dist: ${r.finalTargetDistance?.toFixed(1) ?? 'N/A'}cm`);
    lines.push(`    Mode: ${r.inferenceMode} | Duration: ${r.durationMs}ms`);
    lines.push('');
  }

  return lines.join('\n');
}
