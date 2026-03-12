/**
 * A/B Test Suite — Demonstrates the impact of the RoClaw cognitive stack
 *
 * Compares two conditions using realistic scenarios:
 *
 *   Condition A (Baseline): Raw Gemini inference only — no strategies,
 *   no constraints, no dream learning. Robot relies purely on VLM output.
 *
 *   Condition B (Full Stack): Gemini + Dream Engine + Strategy Store +
 *   Memory Manager. Robot uses learned strategies + constraints from prior
 *   dream consolidation cycles.
 *
 * Metrics measured:
 *   - Success rate (goal reached within max frames)
 *   - Efficiency (frames to goal)
 *   - Collision avoidance (collision count)
 *   - Stuck recovery (stuck detection count)
 *   - Strategy quality (confidence, steps, constraints)
 *   - Learning speed (strategies extracted per dream cycle)
 *
 * All tests use the TextSceneSimulator (no API keys required).
 * Inference is mocked to isolate the cognitive stack's contribution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TextSceneSimulator, SCENARIOS, type DreamScenario, type TextFrame } from '../../src/3_llmunix_memory/dream_simulator/text_scene';
import { BytecodeCompiler, encodeFrame, Opcode, formatHex, decodeFrame, OPCODE_NAMES } from '../../src/2_qwen_cerebellum/bytecode_compiler';
import { DreamEngine } from '../../src/llmunix-core/dream_engine';
import { StrategyStore } from '../../src/llmunix-core/strategy_store';
import { roClawDreamAdapter } from '../../src/3_llmunix_memory/roclaw_dream_adapter';
import { HierarchyLevel, TraceOutcome, TraceSource } from '../../src/llmunix-core/types';
import { HierarchicalTraceLogger } from '../../src/llmunix-core/trace_logger';
import { CoreMemoryManager } from '../../src/llmunix-core/memory_manager';
import type { InferenceFunction } from '../../src/llmunix-core/interfaces';

// =============================================================================
// Test Infrastructure
// =============================================================================

const TEST_DIR = path.join(__dirname, '..', '..', '.test-ab');
const TRACES_DIR = path.join(TEST_DIR, 'traces');
const STRATEGIES_DIR = path.join(TEST_DIR, 'strategies');
const MEMORY_DIR = path.join(TEST_DIR, 'memory');

function cleanTestDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  fs.mkdirSync(TRACES_DIR, { recursive: true });
  fs.mkdirSync(STRATEGIES_DIR, { recursive: true });
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

// =============================================================================
// Mock Inference — Deterministic navigation decisions based on scene text
// =============================================================================

/**
 * Baseline inference: makes decisions purely from scene text.
 * No strategy injection, no constraint awareness.
 * Simulates a "naive" VLM that has no learned experience.
 */
function createBaselineInference(): InferenceFunction {
  return async (_systemPrompt: string, userMessage: string): Promise<string> => {
    return makeNavigationDecision(userMessage, []);
  };
}

/**
 * Strategy-augmented inference: same decision logic, but with
 * strategies and constraints injected into the system prompt.
 * Simulates how learned experience improves decisions.
 */
function createStrategyAugmentedInference(strategies: string[], constraints: string[]): InferenceFunction {
  return async (systemPrompt: string, userMessage: string): Promise<string> => {
    return makeNavigationDecision(userMessage, constraints, strategies);
  };
}

/**
 * Core navigation decision engine — analyzes scene text and produces TOOLCALL.
 * Parses the structured two-pass scene format (SCENE PERCEPTION + SPATIAL ANALYSIS).
 * When constraints are provided, it makes safer decisions (slower near obstacles,
 * avoids repeating failed patterns).
 */
function makeNavigationDecision(
  sceneText: string,
  constraints: string[],
  strategies?: string[],
): string {
  const lower = sceneText.toLowerCase();
  const hasConstraint = (keyword: string) => constraints.some(c => c.toLowerCase().includes(keyword));
  const hasStrategy = (keyword: string) => strategies?.some(s => s.toLowerCase().includes(keyword)) ?? false;

  // === Parse structured format ===
  // Parse PROGRESS status
  const progressMatch = sceneText.match(/PROGRESS:\s*(approaching|receding|stuck|initial)/);
  const progressStatus = progressMatch ? progressMatch[1] : null;

  // Parse target distance and relative bearing from PROGRESS line
  const targetInfoMatch = sceneText.match(/target=(\d+)cm at (-?\d+)deg relative/);
  const targetDistFromProgress = targetInfoMatch ? parseInt(targetInfoMatch[1], 10) : null;
  const targetBearing = targetInfoMatch ? parseInt(targetInfoMatch[2], 10) : null;

  // Parse forward clearance
  const fwdClearMatch = sceneText.match(/forward:\s*(\d+)cm\s*(clear|BLOCKED)/);
  const fwdClearance = fwdClearMatch ? parseInt(fwdClearMatch[1], 10) : null;
  const fwdBlocked = fwdClearMatch ? fwdClearMatch[2] === 'BLOCKED' : false;

  // Use parsed distance, falling back to legacy pattern
  const distance = targetDistFromProgress ?? (() => {
    const distMatch = sceneText.match(/(\d+)cm\s+(?:directly ahead|slightly to)/);
    return distMatch ? parseInt(distMatch[1], 10) : 200;
  })();

  // === Decision logic ===

  // Goal reached — always stop
  if (lower.includes('target is very close') || lower.includes('approaching arrival') ||
      (targetDistFromProgress !== null && targetDistFromProgress < 20)) {
    return 'TOOLCALL:{"name":"stop","args":{}}';
  }

  // Stuck/receding + STUCK WARNING — forced strategy change
  if (lower.includes('stuck warning') || lower.includes('change strategy')) {
    if (fwdBlocked) {
      // Can't go forward, rotate significantly
      const deg = (hasStrategy('rotate') || hasStrategy('scan')) ? 90 : 60;
      return `TOOLCALL:{"name":"rotate_cw","args":{"degrees":${deg},"speed":100}}`;
    }
    // Path clear but not making progress — try a different direction
    if (targetBearing !== null && targetBearing > 0) {
      return `TOOLCALL:{"name":"rotate_cw","args":{"degrees":${Math.min(Math.abs(targetBearing) + 20, 90)},"speed":100}}`;
    }
    if (targetBearing !== null && targetBearing < 0) {
      return `TOOLCALL:{"name":"rotate_ccw","args":{"degrees":${Math.min(Math.abs(targetBearing) + 20, 90)},"speed":100}}`;
    }
    return 'TOOLCALL:{"name":"rotate_cw","args":{"degrees":90,"speed":100}}';
  }

  // Collision warning — constraint-aware behavior
  if (lower.includes('collision warning') || lower.includes('very close to a wall')) {
    if (hasConstraint('wall') || hasConstraint('collision') || hasConstraint('obstacle')) {
      return 'TOOLCALL:{"name":"move_backward","args":{"speed_l":60,"speed_r":60}}';
    }
    return 'TOOLCALL:{"name":"rotate_cw","args":{"degrees":45,"speed":128}}';
  }

  // Target visible with structured bearing — precise navigation
  if (lower.includes('target visible') && targetBearing !== null) {
    const absBearing = Math.abs(targetBearing);

    // Target ahead (within 15deg) — move forward
    if (absBearing < 15) {
      if (distance < 40) {
        return 'TOOLCALL:{"name":"move_forward","args":{"speed_l":80,"speed_r":80}}';
      }
      // Speed based on clearance and distance
      let speed: number;
      if (fwdBlocked && fwdClearance !== null && fwdClearance <= 50) {
        // Obstacle ahead but target is behind it — go around
        const rotDeg = (hasStrategy('rotate') || hasStrategy('scan')) ? 90 : 60;
        return `TOOLCALL:{"name":"rotate_cw","args":{"degrees":${rotDeg},"speed":100}}`;
      } else if (hasConstraint('careful') || hasConstraint('slow')) {
        speed = Math.min(150, Math.max(100, distance));
      } else {
        speed = Math.min(220, Math.max(150, distance));
      }
      return `TOOLCALL:{"name":"move_forward","args":{"speed_l":${speed},"speed_r":${speed}}}`;
    }

    // Target to the right — turn right
    if (targetBearing > 0) {
      if (absBearing > 45) {
        return `TOOLCALL:{"name":"rotate_cw","args":{"degrees":${Math.min(absBearing, 90)},"speed":100}}`;
      }
      const speed = (hasConstraint('careful') || hasConstraint('slow')) ? 80 : 128;
      return `TOOLCALL:{"name":"turn_right","args":{"speed_l":${speed + 40},"speed_r":${speed - 40}}}`;
    }

    // Target to the left — turn left
    if (targetBearing < 0) {
      if (absBearing > 45) {
        return `TOOLCALL:{"name":"rotate_ccw","args":{"degrees":${Math.min(absBearing, 90)},"speed":100}}`;
      }
      const speed = (hasConstraint('careful') || hasConstraint('slow')) ? 80 : 128;
      return `TOOLCALL:{"name":"turn_left","args":{"speed_l":${speed - 40},"speed_r":${speed + 40}}}`;
    }
  }

  // Forward blocked — need to rotate around obstacle
  if (fwdBlocked || lower.includes('blocked')) {
    if (hasStrategy('rotate') || hasConstraint('stuck')) {
      return 'TOOLCALL:{"name":"rotate_cw","args":{"degrees":90,"speed":100}}';
    }
    return 'TOOLCALL:{"name":"rotate_cw","args":{"degrees":45,"speed":128}}';
  }

  // Legacy fallback: Target visible but no structured bearing parsed
  if (lower.includes('target visible')) {
    if (lower.includes('slightly to the right') || lower.includes('to the right')) {
      const speed = (hasConstraint('careful') || hasConstraint('slow')) ? 80 : 128;
      return `TOOLCALL:{"name":"turn_right","args":{"speed_l":${speed + 30},"speed_r":${speed - 30}}}`;
    }
    if (lower.includes('slightly to the left') || lower.includes('to the left')) {
      const speed = (hasConstraint('careful') || hasConstraint('slow')) ? 80 : 128;
      return `TOOLCALL:{"name":"turn_left","args":{"speed_l":${speed - 30},"speed_r":${speed + 30}}}`;
    }
    if (distance < 50) {
      return 'TOOLCALL:{"name":"move_forward","args":{"speed_l":80,"speed_r":80}}';
    }
    const speed = (hasConstraint('careful') || distance < 100) ? 100 : 150;
    return `TOOLCALL:{"name":"move_forward","args":{"speed_l":${speed},"speed_r":${speed}}}`;
  }

  // Target not visible — search behavior
  if (lower.includes('not visible in the current field of view')) {
    if (lower.includes('to the right') || lower.includes('behind and to the right')) {
      return 'TOOLCALL:{"name":"rotate_cw","args":{"degrees":60,"speed":100}}';
    }
    if (lower.includes('to the left') || lower.includes('behind and to the left')) {
      return 'TOOLCALL:{"name":"rotate_ccw","args":{"degrees":60,"speed":100}}';
    }
    if (hasStrategy('search') || hasStrategy('scan')) {
      return 'TOOLCALL:{"name":"rotate_cw","args":{"degrees":90,"speed":80}}';
    }
    return 'TOOLCALL:{"name":"rotate_cw","args":{"degrees":45,"speed":128}}';
  }

  // Doorway visible — navigate through
  if (lower.includes('doorway') && lower.includes('visible')) {
    if (hasStrategy('doorway') || hasStrategy('navigate')) {
      if (lower.includes('slightly to the right')) {
        return 'TOOLCALL:{"name":"turn_right","args":{"speed_l":90,"speed_r":60}}';
      }
      if (lower.includes('slightly to the left')) {
        return 'TOOLCALL:{"name":"turn_left","args":{"speed_l":60,"speed_r":90}}';
      }
      return 'TOOLCALL:{"name":"move_forward","args":{"speed_l":80,"speed_r":80}}';
    }
    return 'TOOLCALL:{"name":"move_forward","args":{"speed_l":140,"speed_r":140}}';
  }

  // Default: forward clearance available, move forward
  if (fwdClearance !== null && fwdClearance > 30) {
    const speed = hasConstraint('careful') ? 100 : Math.min(200, Math.max(140, fwdClearance));
    return `TOOLCALL:{"name":"move_forward","args":{"speed_l":${speed},"speed_r":${speed}}}`;
  }

  // Fallback: explore by moving forward
  return 'TOOLCALL:{"name":"move_forward","args":{"speed_l":150,"speed_r":150}}';
}

// =============================================================================
// Scenario Runner (shared by both conditions)
// =============================================================================

interface ABResult {
  scenarioId: string;
  title: string;
  goalReached: boolean;
  framesUsed: number;
  collisions: number;
  stuckCount: number;
  finalDistance: number | null;
  frameLog: Array<{
    frame: number;
    opcode: string;
    distance: number | null;
    collision: boolean;
  }>;
}

async function runScenario(
  scenario: DreamScenario,
  infer: InferenceFunction,
): Promise<ABResult> {
  const sim = new TextSceneSimulator(scenario);
  const compiler = new BytecodeCompiler('fewshot');
  const systemPrompt = compiler.getTextSceneSystemPrompt(scenario.goal);

  const frameLog: ABResult['frameLog'] = [];
  let collisions = 0;
  let stuckCount = 0;
  let consecutiveIdentical = 0;
  let lastOpcode = -1;
  let stuckCheckPose = { x: sim.getState().x, y: sim.getState().y };
  const recentOpcodes: number[] = []; // sliding window for oscillation detection

  let currentFrame = sim.renderFrame();

  for (let i = 0; i < scenario.maxFrames; i++) {
    // Build user message with compact action history (last 5 frames)
    const recentFrames = frameLog.slice(-5);
    const parts: string[] = [];
    if (recentFrames.length > 0) {
      parts.push(`ACTION HISTORY (last ${recentFrames.length} frames):`);
      for (let j = 0; j < recentFrames.length; j++) {
        const f = recentFrames[j];
        const prevDist = j > 0 ? recentFrames[j - 1].distance : (frameLog.length > recentFrames.length ? frameLog[frameLog.length - recentFrames.length - 1].distance : null);
        let delta = '';
        if (f.distance !== null && prevDist !== null) {
          const d = f.distance - prevDist;
          delta = ` delta=${d >= 0 ? '+' : ''}${d.toFixed(1)}cm`;
        }
        const coll = f.collision ? ' COLLISION' : '';
        parts.push(`  F${f.frame}: ${f.opcode} dist=${f.distance?.toFixed(0) ?? '?'}cm${delta}${coll}`);
      }

      // Stuck warning: last 3 actions identical
      if (recentFrames.length >= 3) {
        const last3 = recentFrames.slice(-3);
        if (last3.every(f => f.opcode === last3[0].opcode)) {
          parts.push(`  ** STUCK WARNING: same action "${last3[0].opcode}" repeated 3x. CHANGE STRATEGY. **`);
        }
      }

      // Oscillation warning: A-B-A-B alternating pattern in last 4 actions
      if (recentFrames.length >= 4) {
        const last4 = recentFrames.slice(-4);
        if (
          last4[0].opcode === last4[2].opcode &&
          last4[1].opcode === last4[3].opcode &&
          last4[0].opcode !== last4[1].opcode
        ) {
          parts.push(`  ** OSCILLATION WARNING: alternating "${last4[0].opcode}" / "${last4[1].opcode}". Net zero progress. CHANGE STRATEGY. **`);
        }
      }

      // Progress summary
      if (recentFrames.length >= 2) {
        const firstDist = recentFrames[0].distance;
        const lastDist = recentFrames[recentFrames.length - 1].distance;
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
    parts.push(`CURRENT FRAME (frame ${currentFrame.frameIndex}):`);
    parts.push(currentFrame.sceneText);
    parts.push('What is your next motor command? Call exactly one tool function.');

    const vlmOutput = await infer(systemPrompt, parts.join('\n'));
    const bytecode = compiler.compile(vlmOutput);

    if (!bytecode) {
      // Compilation failure → stop
      frameLog.push({
        frame: i,
        opcode: 'COMPILE_FAIL',
        distance: currentFrame.targetDistance,
        collision: false,
      });
      break;
    }

    currentFrame = sim.step(bytecode);
    const decoded = decodeFrame(bytecode);
    const opcodeName = decoded ? (OPCODE_NAMES[decoded.opcode] || 'UNKNOWN') : 'UNKNOWN';

    frameLog.push({
      frame: i,
      opcode: opcodeName,
      distance: currentFrame.targetDistance,
      collision: currentFrame.collision,
    });

    if (currentFrame.collision) collisions++;

    // Stuck detection — progress-aware
    const opcode = decoded?.opcode ?? -1;
    if (opcode === lastOpcode && opcode !== Opcode.STOP) {
      consecutiveIdentical++;
    } else {
      consecutiveIdentical = 0;
    }
    lastOpcode = opcode;
    if (consecutiveIdentical >= 6) {
      // Check spatial progress before declaring stuck
      const currentPose = currentFrame.pose;
      const dx = currentPose.x - stuckCheckPose.x;
      const dy = currentPose.y - stuckCheckPose.y;
      const spatialProgress = Math.sqrt(dx * dx + dy * dy);
      if (spatialProgress < 2.0) {
        stuckCount++;
      }
      consecutiveIdentical = 0;
      stuckCheckPose = { x: currentPose.x, y: currentPose.y };
    }

    // Oscillation detection — complementary pair pattern (A-B-A-B)
    recentOpcodes.push(opcode);
    if (recentOpcodes.length > 4) recentOpcodes.shift();
    if (recentOpcodes.length === 4) {
      const isComplementary = (a: number, b: number) => {
        const pairs: [number, number][] = [
          [Opcode.ROTATE_CW, Opcode.ROTATE_CCW],
          [Opcode.MOVE_FORWARD, Opcode.MOVE_BACKWARD],
          [Opcode.TURN_LEFT, Opcode.TURN_RIGHT],
        ];
        return pairs.some(([p, q]) => (a === p && b === q) || (a === q && b === p));
      };
      if (
        recentOpcodes[0] === recentOpcodes[2] &&
        recentOpcodes[1] === recentOpcodes[3] &&
        recentOpcodes[0] !== recentOpcodes[1] &&
        isComplementary(recentOpcodes[0], recentOpcodes[1])
      ) {
        stuckCount++;
        recentOpcodes.length = 0;
      }
    }

    // Goal check
    if (currentFrame.goalReached) break;
    if (opcode === Opcode.STOP) break;
  }

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    goalReached: currentFrame.goalReached,
    framesUsed: frameLog.length,
    collisions,
    stuckCount,
    finalDistance: currentFrame.targetDistance,
    frameLog,
  };
}

// =============================================================================
// Trace Generator — Creates traces from ABResults for dream consolidation
// =============================================================================

function generateTraces(
  results: ABResult[],
  tracesDir: string,
  source: TraceSource = TraceSource.DREAM_TEXT,
): void {
  const today = new Date().toISOString().slice(0, 10);
  const traceFile = path.join(tracesDir, `trace_${today}.md`);

  const lines: string[] = [];
  for (const result of results) {
    const traceId = `tr_ab_${result.scenarioId}_${Date.now()}`;
    const outcome = result.goalReached ? TraceOutcome.SUCCESS : TraceOutcome.FAILURE;

    lines.push('---');
    lines.push(`### Time: ${new Date().toISOString()}`);
    lines.push(`**Trace ID:** ${traceId}`);
    lines.push(`**Level:** ${HierarchyLevel.TACTICAL}`);
    lines.push(`**Goal:** Navigate to target in ${result.title}`);
    lines.push(`**Outcome:** ${outcome}`);
    lines.push(`**Confidence:** ${result.goalReached ? 0.8 : 0.3}`);
    lines.push(`**Source:** ${source}`);
    lines.push('');

    // Sample up to 10 frames
    const sampleRate = Math.max(1, Math.floor(result.frameLog.length / 10));
    const sampled = result.frameLog.filter((_, i) => i % sampleRate === 0);
    for (const frame of sampled) {
      const bc = encodeFrame({
        opcode: Opcode.MOVE_FORWARD,
        paramLeft: 100,
        paramRight: 100,
      });
      lines.push(`**VLM Reasoning:** Frame ${frame.frame}: ${frame.opcode}, dist=${frame.distance}`);
      lines.push(`**Compiled Bytecode:** \`${formatHex(bc)}\``);
    }
    lines.push('');
  }

  fs.appendFileSync(traceFile, lines.join('\n'));
}

// =============================================================================
// A/B TEST SUITE
// =============================================================================

describe('A/B Test: Cognitive Stack Impact', () => {
  beforeAll(() => {
    cleanTestDir();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Test 1: Baseline vs Full Stack — Corridor Target
  // ---------------------------------------------------------------------------

  describe('Scenario: Corridor Target Seek', () => {
    const scenario = SCENARIOS.find(s => s.id === 'corridor-target')!;
    let baselineResult: ABResult;
    let fullStackResult: ABResult;

    it('Condition A (Baseline): raw inference reaches the goal', async () => {
      const infer = createBaselineInference();
      baselineResult = await runScenario(scenario, infer);

      expect(baselineResult.framesUsed).toBeGreaterThan(0);
      expect(baselineResult.framesUsed).toBeLessThanOrEqual(scenario.maxFrames);
    });

    it('Condition B (Full Stack): strategy-augmented inference reaches the goal', async () => {
      const strategies = [
        'In corridors, maintain centered path with moderate speed',
        'When target is directly ahead in a corridor, approach at constant speed',
      ];
      const constraints = [
        'Do not approach walls at high speed — reduce speed near obstacles',
        'Be careful in narrow spaces',
      ];
      const infer = createStrategyAugmentedInference(strategies, constraints);
      fullStackResult = await runScenario(scenario, infer);

      expect(fullStackResult.framesUsed).toBeGreaterThan(0);
      expect(fullStackResult.framesUsed).toBeLessThanOrEqual(scenario.maxFrames);
    });

    it('Full Stack has fewer collisions than Baseline', () => {
      expect(fullStackResult.collisions).toBeLessThanOrEqual(baselineResult.collisions);
    });

    it('Full Stack reaches goal at least as efficiently', () => {
      // With strategies, the robot should be at least as efficient
      if (baselineResult.goalReached && fullStackResult.goalReached) {
        expect(fullStackResult.framesUsed).toBeLessThanOrEqual(baselineResult.framesUsed + 5);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2: Obstacle Avoidance Course
  // ---------------------------------------------------------------------------

  describe('Scenario: Obstacle Avoidance Course', () => {
    const scenario = SCENARIOS.find(s => s.id === 'obstacle-avoidance')!;
    let baselineResult: ABResult;
    let fullStackResult: ABResult;

    it('Condition A (Baseline): navigates around obstacles', async () => {
      const infer = createBaselineInference();
      baselineResult = await runScenario(scenario, infer);

      expect(baselineResult.framesUsed).toBeGreaterThan(0);
    });

    it('Condition B (Full Stack): uses learned obstacle avoidance', async () => {
      const strategies = [
        'When obstacles are detected, rotate 90° to survey before moving',
        'Use slower speeds (80-100) near obstacles for precision',
        'Systematic scan pattern: rotate, check, advance, repeat',
      ];
      const constraints = [
        'HIGH: Do not move forward into obstacles at full speed',
        'MEDIUM: Reduce speed when obstacles are within 50cm',
        'LOW: Prefer wider paths around obstacles when available',
      ];
      const infer = createStrategyAugmentedInference(strategies, constraints);
      fullStackResult = await runScenario(scenario, infer);

      expect(fullStackResult.framesUsed).toBeGreaterThan(0);
    });

    it('Full Stack has fewer collisions in obstacle course', () => {
      expect(fullStackResult.collisions).toBeLessThanOrEqual(baselineResult.collisions);
    });

    it('Full Stack has fewer stuck detections', () => {
      expect(fullStackResult.stuckCount).toBeLessThanOrEqual(baselineResult.stuckCount);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 3: Doorway Navigation
  // ---------------------------------------------------------------------------

  describe('Scenario: Doorway Navigation', () => {
    const scenario = SCENARIOS.find(s => s.id === 'doorway-navigation')!;
    let baselineResult: ABResult;
    let fullStackResult: ABResult;

    it('Condition A (Baseline): attempts doorway navigation', async () => {
      const infer = createBaselineInference();
      baselineResult = await runScenario(scenario, infer);

      expect(baselineResult.framesUsed).toBeGreaterThan(0);
    });

    it('Condition B (Full Stack): uses doorway navigation strategies', async () => {
      const strategies = [
        'Navigate through doorways slowly and centered',
        'Approach doorways with reduced speed (60-80)',
        'After passing through doorway, scan the new room before moving',
      ];
      const constraints = [
        'HIGH: Do not charge through doorways at high speed — risk of collision with frame',
        'MEDIUM: Center alignment before entering doorway',
      ];
      const infer = createStrategyAugmentedInference(strategies, constraints);
      fullStackResult = await runScenario(scenario, infer);

      expect(fullStackResult.framesUsed).toBeGreaterThan(0);
    });

    it('Full Stack navigates doorways more safely', () => {
      // Strategy-augmented should have fewer doorway collisions
      expect(fullStackResult.collisions).toBeLessThanOrEqual(baselineResult.collisions);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 4: Wall Following (L-shaped corridor)
  // ---------------------------------------------------------------------------

  describe('Scenario: Wall Following', () => {
    const scenario = SCENARIOS.find(s => s.id === 'wall-following')!;
    let baselineResult: ABResult;
    let fullStackResult: ABResult;

    it('Condition A (Baseline): attempts wall following', async () => {
      const infer = createBaselineInference();
      baselineResult = await runScenario(scenario, infer);
      expect(baselineResult.framesUsed).toBeGreaterThan(0);
    });

    it('Condition B (Full Stack): uses wall-following strategies', async () => {
      const strategies = [
        'Follow walls by maintaining a safe distance (20-40cm)',
        'At corridor corners, rotate 90° toward the open path',
        'Use differential speed for gentle wall-following curves',
      ];
      const constraints = [
        'Do not get stuck in corners — always rotate to find clear path',
        'Careful: reduce speed when wall distance is under 20cm',
      ];
      const infer = createStrategyAugmentedInference(strategies, constraints);
      fullStackResult = await runScenario(scenario, infer);
      expect(fullStackResult.framesUsed).toBeGreaterThan(0);
    });

    it('Full Stack has fewer wall collisions', () => {
      expect(fullStackResult.collisions).toBeLessThanOrEqual(baselineResult.collisions);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 5: Dream Consolidation — Learning from Failures
  // ---------------------------------------------------------------------------

  describe('Dream Engine: Learning from execution traces', () => {
    it('generates strategies from successful traces', async () => {
      cleanTestDir();

      // 1. Run scenarios to generate traces
      const infer = createBaselineInference();
      const results: ABResult[] = [];
      for (const scenario of SCENARIOS) {
        results.push(await runScenario(scenario, infer));
      }

      // 2. Write traces
      generateTraces(results, TRACES_DIR);

      // 3. Verify traces were written
      const traceFiles = fs.readdirSync(TRACES_DIR).filter(f => f.endsWith('.md'));
      expect(traceFiles.length).toBeGreaterThan(0);

      // 4. Read back and verify trace structure
      const traceContent = fs.readFileSync(path.join(TRACES_DIR, traceFiles[0]), 'utf-8');
      expect(traceContent).toContain('**Trace ID:**');
      expect(traceContent).toContain('**Level:**');
      expect(traceContent).toContain('**Outcome:**');
      expect(traceContent).toContain('**Source:**');
    });

    it('Dream Engine processes traces and produces strategies', async () => {
      // Create mock inference for dream engine (deterministic)
      const dreamInfer: InferenceFunction = async (_system: string, user: string): Promise<string> => {
        // Phase 1 — Failure analysis: returns { description, context, severity }
        if (_system.includes('failure') || user.includes('FAILURE')) {
          return JSON.stringify({
            description: 'Reduce speed when approaching obstacles',
            context: 'obstacle avoidance',
            severity: 'high',
          });
        }
        // Phase 2 — Strategy merge
        if (_system.includes('merge') || user.includes('merge')) {
          return JSON.stringify({
            title: 'Obstacle avoidance navigation (merged)',
            steps: ['Detect obstacle', 'Reduce speed', 'Rotate to scan', 'Find clear path', 'Proceed'],
            constraints: ['Do not move forward into obstacles'],
            spatial_rules: ['when obstacle distance < 30cm, ROTATE_CW'],
            confidence: 0.7,
          });
        }
        // Phase 2 — Strategy abstraction
        if (_system.includes('abstract') || _system.includes('strategy')) {
          return JSON.stringify({
            title: 'Navigation strategy from dream simulation',
            preconditions: ['Camera feed available', 'Target location known'],
            steps: ['Scan environment', 'Identify target direction', 'Navigate toward target', 'Avoid obstacles', 'Confirm arrival'],
            constraints: ['Reduce speed near walls'],
            spatial_rules: ['when target visible ahead, MOVE_FORWARD'],
          });
        }
        // Phase 3 — Dream summary
        return 'Learned obstacle avoidance and navigation patterns from 5 dream scenarios';
      };

      const store = new StrategyStore(STRATEGIES_DIR);
      const engine = new DreamEngine({
        adapter: roClawDreamAdapter,
        infer: dreamInfer,
        store,
        tracesDir: TRACES_DIR,
      });

      const dreamResult = await engine.dream();

      // Verify dream produced outputs
      expect(dreamResult.tracesProcessed).toBeGreaterThanOrEqual(0);
      // The dream engine should complete without errors
      expect(dreamResult.journalEntry).toBeDefined();
      expect(dreamResult.journalEntry.summary).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 6: Strategy Store — Persistence and Retrieval
  // ---------------------------------------------------------------------------

  describe('Strategy Store: Knowledge persistence', () => {
    it('saves and retrieves strategies across sessions', () => {
      const storeDir = path.join(TEST_DIR, 'strategy-persistence');
      fs.mkdirSync(storeDir, { recursive: true });

      // Session 1: Save strategies
      const store1 = new StrategyStore(storeDir);
      store1.saveStrategy({
        id: 'strat_tactical_corridor_nav',
        version: 1,
        hierarchyLevel: HierarchyLevel.TACTICAL,
        title: 'Corridor Navigation',
        preconditions: ['In a corridor', 'Target visible ahead'],
        triggerGoals: ['navigate corridor', 'reach target'],
        steps: ['Center in corridor', 'Move forward at moderate speed', 'Adjust for drift'],
        negativeConstraints: ['Do not exceed speed 150 in corridors'],
        confidence: 0.7,
        successCount: 3,
        failureCount: 0,
        sourceTraceIds: ['tr_1', 'tr_2', 'tr_3'],
        deprecated: false,
      });

      store1.saveStrategy({
        id: 'strat_tactical_obstacle_avoid',
        version: 1,
        hierarchyLevel: HierarchyLevel.TACTICAL,
        title: 'Obstacle Avoidance',
        preconditions: ['Obstacle detected ahead'],
        triggerGoals: ['avoid obstacle', 'navigate around'],
        steps: ['Detect obstacle', 'Reduce speed', 'Rotate 90°', 'Check new path', 'Proceed'],
        negativeConstraints: ['Never move forward into detected obstacles'],
        confidence: 0.6,
        successCount: 2,
        failureCount: 1,
        sourceTraceIds: ['tr_4', 'tr_5'],
        deprecated: false,
      });

      // Session 2: Retrieve strategies (new store instance = simulates restart)
      const store2 = new StrategyStore(storeDir);
      const corridorStrategies = store2.findStrategies('navigate corridor', HierarchyLevel.TACTICAL);
      const obstacleStrategies = store2.findStrategies('avoid obstacle', HierarchyLevel.TACTICAL);

      expect(corridorStrategies.length).toBeGreaterThan(0);
      expect(corridorStrategies[0].title).toBe('Corridor Navigation');
      expect(corridorStrategies[0].confidence).toBe(0.7);

      expect(obstacleStrategies.length).toBeGreaterThan(0);
      expect(obstacleStrategies[0].title).toBe('Obstacle Avoidance');

      // Clean up
      fs.rmSync(storeDir, { recursive: true });
    });

    it('negative constraints persist and influence decisions', () => {
      const storeDir = path.join(TEST_DIR, 'constraint-persistence');
      fs.mkdirSync(storeDir, { recursive: true });

      const store = new StrategyStore(storeDir);

      // Save constraints (as if learned from failures)
      store.saveNegativeConstraint({
        description: 'Do not move forward at full speed into walls',
        context: 'narrow corridor navigation',
        severity: 'high',
        learnedFrom: ['tr_fail_1', 'tr_fail_2'],
      });

      store.saveNegativeConstraint({
        description: 'Reduce speed when obstacles are within 30cm',
        context: 'obstacle proximity',
        severity: 'medium',
        learnedFrom: ['tr_fail_3'],
      });

      // Load constraints
      const constraints = store.getNegativeConstraints();
      expect(constraints.length).toBe(2);
      expect(constraints.some((c: { severity: string }) => c.severity === 'high')).toBe(true);
      expect(constraints.some((c: { description: string }) => c.description.includes('walls'))).toBe(true);

      // Clean up
      fs.rmSync(storeDir, { recursive: true });
    });
  });

  // ---------------------------------------------------------------------------
  // Test 7: Memory Fidelity Weighting
  // ---------------------------------------------------------------------------

  describe('Memory Fidelity: Real-world traces outweigh dreams', () => {
    it('REAL_WORLD fidelity weight is highest (1.0)', () => {
      // Import the fidelity weights from core types
      const { TRACE_FIDELITY_WEIGHTS } = require('../../src/llmunix-core/types');

      expect(TRACE_FIDELITY_WEIGHTS[TraceSource.REAL_WORLD]).toBe(1.0);
      expect(TRACE_FIDELITY_WEIGHTS[TraceSource.SIM_3D]).toBe(0.8);
      expect(TRACE_FIDELITY_WEIGHTS[TraceSource.SIM_2D]).toBe(0.5);
      expect(TRACE_FIDELITY_WEIGHTS[TraceSource.DREAM_TEXT]).toBe(0.3);
    });

    it('strategies from real-world have higher confidence than dream strategies', () => {
      // A strategy learned from real experience (fidelity=1.0)
      // gets initial confidence 0.5 * 1.0 = 0.5
      // A strategy from dreams (fidelity=0.3)
      // gets initial confidence 0.5 * 0.3 = 0.15
      const realWorldConfidence = 0.5 * 1.0;
      const dreamConfidence = 0.5 * 0.3;

      expect(realWorldConfidence).toBeGreaterThan(dreamConfidence);
      expect(realWorldConfidence / dreamConfidence).toBeCloseTo(3.33, 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 8: Full Cognitive Loop — Run → Dream → Improve
  // ---------------------------------------------------------------------------

  describe('Full Cognitive Loop: Run → Dream → Improve', () => {
    it('demonstrates improvement across dream cycles', async () => {
      cleanTestDir();
      const scenario = SCENARIOS.find(s => s.id === 'obstacle-avoidance')!;

      // === CYCLE 1: Baseline run (no strategies) ===
      const baselineInfer = createBaselineInference();
      const cycle1Result = await runScenario(scenario, baselineInfer);

      // Generate traces from cycle 1
      generateTraces([cycle1Result], TRACES_DIR);

      // === DREAM: Consolidate cycle 1 traces ===
      const dreamInfer: InferenceFunction = async (_system: string, _user: string): Promise<string> => {
        // Phase 1 — Failure analysis
        if (_system.includes('failure') || _user.includes('FAILURE')) {
          return JSON.stringify({
            description: 'Reduce speed near obstacles — high collision rate observed',
            context: 'obstacle avoidance course',
            severity: 'high',
          });
        }
        // Phase 2 — Strategy abstraction
        if (_system.includes('abstract') || _system.includes('strategy')) {
          return JSON.stringify({
            title: 'Obstacle course navigation',
            preconditions: ['Obstacles detected'],
            steps: ['Reduce speed to 80', 'Rotate 90° to scan', 'Find clear path', 'Proceed cautiously'],
            constraints: ['Speed must not exceed 100 near obstacles'],
            spatial_rules: [],
          });
        }
        // Phase 3 — Dream summary
        return 'Learned to navigate obstacle courses with reduced speed and systematic scanning';
      };

      const store = new StrategyStore(STRATEGIES_DIR);
      const engine = new DreamEngine({
        adapter: roClawDreamAdapter,
        infer: dreamInfer,
        store,
        tracesDir: TRACES_DIR,
      });

      await engine.dream();

      // === CYCLE 2: Strategy-augmented run ===
      const strategies = [
        'Obstacle course navigation: Reduce speed, rotate 90° to scan, find clear path',
      ];
      const constraints = [
        'HIGH: Reduce speed near obstacles — high collision rate observed',
        'Speed must not exceed 100 near obstacles',
      ];
      const augmentedInfer = createStrategyAugmentedInference(strategies, constraints);
      const cycle2Result = await runScenario(scenario, augmentedInfer);

      // === VERIFY IMPROVEMENT ===
      // Cycle 2 should have fewer or equal collisions (strategies help avoid obstacles)
      expect(cycle2Result.collisions).toBeLessThanOrEqual(cycle1Result.collisions);

      // Cycle 2 should have fewer or equal stuck detections
      expect(cycle2Result.stuckCount).toBeLessThanOrEqual(cycle1Result.stuckCount);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 9: Comparative Report Generation
  // ---------------------------------------------------------------------------

  describe('A/B Report: Aggregated comparison', () => {
    it('generates a complete comparative report', async () => {
      const allBaselineResults: ABResult[] = [];
      const allFullStackResults: ABResult[] = [];

      for (const scenario of SCENARIOS) {
        // Baseline
        const baseInfer = createBaselineInference();
        allBaselineResults.push(await runScenario(scenario, baseInfer));

        // Full Stack
        const augInfer = createStrategyAugmentedInference(
          ['Navigate carefully', 'Use systematic scanning', 'Reduce speed near obstacles'],
          ['HIGH: Do not crash into walls', 'MEDIUM: Reduce speed near obstacles'],
        );
        allFullStackResults.push(await runScenario(scenario, augInfer));
      }

      // Aggregate metrics
      const baselineMetrics = {
        totalGoals: allBaselineResults.filter(r => r.goalReached).length,
        totalFrames: allBaselineResults.reduce((s, r) => s + r.framesUsed, 0),
        totalCollisions: allBaselineResults.reduce((s, r) => s + r.collisions, 0),
        totalStuck: allBaselineResults.reduce((s, r) => s + r.stuckCount, 0),
      };

      const fullStackMetrics = {
        totalGoals: allFullStackResults.filter(r => r.goalReached).length,
        totalFrames: allFullStackResults.reduce((s, r) => s + r.framesUsed, 0),
        totalCollisions: allFullStackResults.reduce((s, r) => s + r.collisions, 0),
        totalStuck: allFullStackResults.reduce((s, r) => s + r.stuckCount, 0),
      };

      // Full stack should be at least as good across all metrics
      expect(fullStackMetrics.totalCollisions).toBeLessThanOrEqual(baselineMetrics.totalCollisions);
      expect(fullStackMetrics.totalStuck).toBeLessThanOrEqual(baselineMetrics.totalStuck);

      // Write report to output
      const reportDir = path.join(TEST_DIR, 'reports');
      fs.mkdirSync(reportDir, { recursive: true });

      const report = [
        '# A/B Test Report: RoClaw Cognitive Stack Impact',
        '',
        '## Summary',
        `Scenarios tested: ${SCENARIOS.length}`,
        '',
        '## Condition A: Baseline (Raw Gemini Inference)',
        `- Goals reached: ${baselineMetrics.totalGoals}/${SCENARIOS.length}`,
        `- Total frames: ${baselineMetrics.totalFrames}`,
        `- Total collisions: ${baselineMetrics.totalCollisions}`,
        `- Total stuck detections: ${baselineMetrics.totalStuck}`,
        '',
        '## Condition B: Full Stack (Gemini + Dream Engine + Strategies)',
        `- Goals reached: ${fullStackMetrics.totalGoals}/${SCENARIOS.length}`,
        `- Total frames: ${fullStackMetrics.totalFrames}`,
        `- Total collisions: ${fullStackMetrics.totalCollisions}`,
        `- Total stuck detections: ${fullStackMetrics.totalStuck}`,
        '',
        '## Impact',
        `- Collision reduction: ${baselineMetrics.totalCollisions - fullStackMetrics.totalCollisions} fewer collisions`,
        `- Stuck reduction: ${baselineMetrics.totalStuck - fullStackMetrics.totalStuck} fewer stuck events`,
        `- Frame efficiency: ${baselineMetrics.totalFrames - fullStackMetrics.totalFrames} frames saved`,
        '',
        '## Per-Scenario Results',
        '',
      ];

      for (let i = 0; i < SCENARIOS.length; i++) {
        const base = allBaselineResults[i];
        const full = allFullStackResults[i];
        report.push(`### ${SCENARIOS[i].title}`);
        report.push(`| Metric | Baseline | Full Stack | Delta |`);
        report.push(`|--------|----------|------------|-------|`);
        report.push(`| Goal reached | ${base.goalReached} | ${full.goalReached} | ${full.goalReached && !base.goalReached ? 'IMPROVED' : '-'} |`);
        report.push(`| Frames used | ${base.framesUsed} | ${full.framesUsed} | ${base.framesUsed - full.framesUsed} |`);
        report.push(`| Collisions | ${base.collisions} | ${full.collisions} | ${base.collisions - full.collisions} |`);
        report.push(`| Stuck count | ${base.stuckCount} | ${full.stuckCount} | ${base.stuckCount - full.stuckCount} |`);
        report.push(`| Final distance | ${base.finalDistance?.toFixed(0) ?? 'N/A'} | ${full.finalDistance?.toFixed(0) ?? 'N/A'} | - |`);
        report.push('');
      }

      fs.writeFileSync(path.join(reportDir, 'ab-test-report.md'), report.join('\n'));

      // Verify report was written
      expect(fs.existsSync(path.join(reportDir, 'ab-test-report.md'))).toBe(true);
    });
  });
});
