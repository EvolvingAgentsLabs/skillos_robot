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
import { HierarchyLevel, TraceOutcome } from '../../llmunix-core/types';
import { BytecodeCompiler, formatHex, encodeFrame, Opcode, OPCODE_NAMES } from '../../2_qwen_cerebellum/bytecode_compiler';
import { TextSceneSimulator, type DreamScenario, type TextFrame } from './text_scene';
import { DreamInferenceRouter, type DreamInferenceMode, type DreamInferenceRouterConfig } from './dream_inference_router';

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
  inferenceMode: DreamInferenceMode;
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
  /** Inference mode */
  inferenceMode: DreamInferenceMode;
  /** OpenRouter API key */
  openRouterApiKey?: string;
  /** Google API key */
  googleApiKey?: string;
  /** Directory to write traces */
  tracesDir: string;
  /** Whether to print live progress */
  verbose: boolean;
  /** Claude model for dream simulation */
  claudeModel?: string;
  /** Gemini model */
  geminiModel?: string;
  /** Number of consecutive identical opcodes to consider "stuck" */
  stuckThreshold?: number;
  /** Max consecutive stuck detections before aborting */
  maxStuckRetries?: number;
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

  constructor(config: RunnerConfig) {
    this.config = config;
    this.stuckThreshold = config.stuckThreshold ?? 6;
    this.maxStuckRetries = config.maxStuckRetries ?? 3;

    this.compiler = new BytecodeCompiler('fewshot');

    const routerConfig: DreamInferenceRouterConfig = {
      mode: config.inferenceMode,
      openRouterApiKey: config.openRouterApiKey,
      googleApiKey: config.googleApiKey,
      claudeModel: config.claudeModel,
      geminiModel: config.geminiModel,
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
      console.log(`Mode: ${this.config.inferenceMode}`);
    }

    const frameLog: FrameLogEntry[] = [];
    let collisionCount = 0;
    let stuckCount = 0;
    let consecutiveIdentical = 0;
    let lastOpcode = -1;
    let goalReached = false;
    let abortReason = '';

    // Get initial frame
    let currentFrame = sim.renderFrame();

    // Build system prompt (tool-calling mode for text scenes)
    const systemPrompt = this.compiler.getToolCallingSystemPrompt(scenario.goal);

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

      // Stuck detection
      if (opcode === lastOpcode && opcode !== Opcode.STOP) {
        consecutiveIdentical++;
      } else {
        consecutiveIdentical = 0;
      }
      lastOpcode = opcode;

      if (consecutiveIdentical >= this.stuckThreshold) {
        stuckCount++;
        consecutiveIdentical = 0;
        if (this.config.verbose) {
          console.log(`  [!] Stuck detected (${stuckCount}/${this.maxStuckRetries})`);
        }
        if (stuckCount >= this.maxStuckRetries) {
          abortReason = `Stuck: ${stuckCount} consecutive stuck detections (${this.stuckThreshold} identical opcodes each)`;
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
      inferenceMode: this.config.inferenceMode,
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
          inferenceMode: this.config.inferenceMode,
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

    // Include last 3 frames as "temporal context" (text-based video clip)
    const recentFrames = history.slice(-3);
    if (recentFrames.length > 0) {
      parts.push(`PREVIOUS FRAMES (${recentFrames.length} frames, oldest first):`);
      for (const f of recentFrames) {
        parts.push(`--- Frame ${f.frameIndex} ---`);
        parts.push(f.sceneText);
        parts.push(`Last action: ${f.opcodeName}`);
      }
      parts.push('');
    }

    parts.push(`CURRENT FRAME (frame ${currentFrame.frameIndex}):`);
    parts.push(currentFrame.sceneText);
    parts.push('');
    parts.push('What is your next motor command? Output exactly one TOOLCALL.');

    return parts.join('\n');
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
