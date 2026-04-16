/**
 * Tests for ShadowPerceptionLoop — read-only sidecar that validates the
 * scene-graph pipeline against actual VLM bytecodes.
 */

import { ShadowPerceptionLoop, type DivergenceInfo, type TelemetryProvider } from '../../src/2_qwen_cerebellum/shadow_perception_loop';
import { BytecodeCompiler, encodeFrame, Opcode } from '../../src/2_qwen_cerebellum/bytecode_compiler';
import { SceneGraph } from '../../src/3_llmunix_memory/scene_graph';
import { ReactiveController, type ControllerGoal } from '../../src/1_openclaw_cortex/reactive_controller';
import type { ArenaConfig } from '../../src/2_qwen_cerebellum/vision_projector';

// =============================================================================
// Fixtures
// =============================================================================

const ARENA: ArenaConfig = { widthCm: 300, heightCm: 200 };

/**
 * Valid Gemini scene response: robot heading RIGHT at image center-top,
 * red cube in the center-bottom area.
 *
 * box_2d is [ymin, xmin, ymax, xmax] in 0-1000 normalized coords.
 *   roclaw:   ymin=100, xmin=400, ymax=200, xmax=600 -> center ~(150,150) in arena cm
 *   red cube: ymin=700, xmin=400, ymax=800, xmax=600 -> center ~(150,150) in arena cm
 *
 * Arena 300x200 means scale = 0.3 cm/unit (X) and 0.2 cm/unit (Y).
 *   roclaw center:   x = (400+600)/2 * 0.3 = 150,  y = (100+200)/2 * 0.2 = 30
 *   red cube center: x = (400+600)/2 * 0.3 = 150,  y = (700+800)/2 * 0.2 = 150
 */
const VALID_SCENE_JSON = JSON.stringify({
  objects: [
    { label: 'roclaw', box_2d: [100, 400, 200, 600], heading_estimate: 'RIGHT' },
    { label: 'red cube', box_2d: [700, 400, 800, 600] },
  ],
});

/**
 * Scene JSON that places robot at (45, 100) heading 0 deg (RIGHT), target at (225, 100).
 * With these positions and heading 0 (pointing +X), the controller should decide
 * MOVE_FORWARD with cruiseSpeed 200 because:
 *   - distance = 180 cm (> arrivalThreshold 8, > approachDistance 30)
 *   - bearing  = atan2(0, 180) = 0 deg (< turnThreshold 15)
 *
 * box_2d coords (reverse-engineering from arena 300x200):
 *   Robot at (45, 100):  xCenter=45 -> xNorm=45/0.3=150, yCenter=100 -> yNorm=100/0.2=500
 *     box_2d: [480, 130, 520, 170]  (small box centered at 150, 500)
 *   Target at (225, 100): xCenter=225 -> xNorm=225/0.3=750, yCenter=100 -> yNorm=100/0.2=500
 *     box_2d: [480, 730, 520, 770]
 */
const AGREEMENT_SCENE_JSON = JSON.stringify({
  objects: [
    { label: 'roclaw', box_2d: [480, 130, 520, 170], heading_estimate: 'RIGHT' },
    { label: 'red cube', box_2d: [480, 730, 520, 770] },
  ],
});

/** A dummy base64 frame string (content doesn't matter, only the mock infer uses it). */
const DUMMY_FRAME = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';

/** MOVE_FORWARD at speed 200 (what the VLM "sent"). */
const VLM_FORWARD_200 = encodeFrame({ opcode: Opcode.MOVE_FORWARD, paramLeft: 200, paramRight: 200 });

/** STOP frame (differs from most controller decisions). */
const VLM_STOP = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });

/** TURN_RIGHT at speed 100 — a bytecode that will usually diverge from the controller. */
const VLM_TURN_RIGHT = encodeFrame({ opcode: Opcode.TURN_RIGHT, paramLeft: 100, paramRight: 50 });

// =============================================================================
// Helpers
// =============================================================================

/** Create a fresh ShadowPerceptionLoop with the given mock infer function and optional config. */
function createLoop(
  mockInfer: jest.Mock,
  config: { frameSkip?: number } = {},
) {
  const graph = new SceneGraph();
  const controller = new ReactiveController();
  const compiler = new BytecodeCompiler('fewshot');
  const loop = new ShadowPerceptionLoop(graph, controller, compiler, mockInfer, ARENA, config);
  return { loop, graph, controller, compiler };
}

/** Flush pending microtasks (gives processing guard time to release). */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// =============================================================================
// Tests
// =============================================================================

describe('ShadowPerceptionLoop', () => {
  // Suppress logger output during tests
  beforeAll(() => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Constructor
  // -------------------------------------------------------------------------
  test('1. Constructor creates instance without errors', () => {
    const mockInfer = jest.fn();
    const { loop } = createLoop(mockInfer);
    expect(loop).toBeInstanceOf(ShadowPerceptionLoop);
    const stats = loop.getStats();
    expect(stats.framesReceived).toBe(0);
    expect(stats.framesProcessed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 2. onFrame with valid inference populates SceneGraph
  // -------------------------------------------------------------------------
  test('2. onFrame with valid inference populates SceneGraph (graph.size > 1)', async () => {
    const mockInfer = jest.fn().mockResolvedValue(VALID_SCENE_JSON);
    const { loop, graph } = createLoop(mockInfer);
    loop.setGoalText('navigate to the red cube');

    // Default frameSkip=2: first call (frameCount=1) is skipped, second (frameCount=2) processes
    await loop.onFrame(DUMMY_FRAME, VLM_TURN_RIGHT); // frame 1 — skipped
    await loop.onFrame(DUMMY_FRAME, VLM_TURN_RIGHT); // frame 2 — processed

    // SceneGraph should now have roclaw + red cube
    expect(graph.size()).toBeGreaterThan(1);
    expect(mockInfer).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 3. Divergence: controller disagrees with VLM bytecode
  // -------------------------------------------------------------------------
  test('3. onFrame emits divergence when controller disagrees with VLM bytecode', async () => {
    const mockInfer = jest.fn().mockResolvedValue(VALID_SCENE_JSON);
    const { loop } = createLoop(mockInfer);
    loop.setGoalText('navigate to the red cube');

    const divergencePromise = new Promise<DivergenceInfo>(resolve => {
      loop.on('divergence', resolve);
    });

    // VLM_STOP will likely diverge from controller's decision (robot is far from target)
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // skipped (frame 1)
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // processed (frame 2)

    const info = await divergencePromise;
    expect(info).toBeDefined();
    expect(info.vlmHex).toBeDefined();
    expect(info.controllerHex).toBeDefined();
    expect(info.vlmHex).not.toBe(info.controllerHex);
    expect(loop.getStats().divergences).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. Agreement: controller agrees with VLM bytecode
  // -------------------------------------------------------------------------
  test('4. onFrame emits agreement when bytecodes match', async () => {
    // Use the agreement scene: robot at (45,100) heading 0, target at (225,100).
    // Controller will decide MOVE_FORWARD with cruiseSpeed=200.
    const mockInfer = jest.fn().mockResolvedValue(AGREEMENT_SCENE_JSON);
    const { loop } = createLoop(mockInfer);
    loop.setGoalText('navigate to the red cube');

    const agreementPromise = new Promise<{ action: string; objectCount: number }>(resolve => {
      loop.on('agreement', resolve);
    });

    await loop.onFrame(DUMMY_FRAME, VLM_FORWARD_200); // skipped
    await loop.onFrame(DUMMY_FRAME, VLM_FORWARD_200); // processed

    const info = await agreementPromise;
    expect(info).toBeDefined();
    expect(info.action).toBe('move_forward');
    expect(info.objectCount).toBe(2);
    expect(loop.getStats().agreements).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 5. Frame skip — default frameSkip=2 skips every other frame
  // -------------------------------------------------------------------------
  test('5. Frame skip: default frameSkip=2 means every 2nd frame is processed', async () => {
    const mockInfer = jest.fn().mockResolvedValue(VALID_SCENE_JSON);
    const { loop } = createLoop(mockInfer);
    loop.setGoalText('navigate to the red cube');

    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // frame 1 — skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // frame 2 — processed
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // frame 3 — skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // frame 4 — processed

    expect(mockInfer).toHaveBeenCalledTimes(2);
    expect(loop.getStats().framesReceived).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 6. Frame skip configurable
  // -------------------------------------------------------------------------
  test('6. Frame skip configurable: frameSkip=3 processes every 3rd frame', async () => {
    const mockInfer = jest.fn().mockResolvedValue(VALID_SCENE_JSON);
    const { loop } = createLoop(mockInfer, { frameSkip: 3 });
    loop.setGoalText('navigate to the red cube');

    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // frame 1 — skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // frame 2 — skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // frame 3 — processed
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // frame 4 — skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // frame 5 — skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // frame 6 — processed

    expect(mockInfer).toHaveBeenCalledTimes(2);
    expect(loop.getStats().framesReceived).toBe(6);
  });

  // -------------------------------------------------------------------------
  // 7. Read-only: no transmitter.send calls (shadow loop never transmits)
  // -------------------------------------------------------------------------
  test('7. Shadow loop is read-only: infer is called but no external send occurs', async () => {
    const mockInfer = jest.fn().mockResolvedValue(VALID_SCENE_JSON);
    const mockSend = jest.fn();
    const { loop } = createLoop(mockInfer);
    loop.setGoalText('navigate to the red cube');

    // Monkey-patch a hypothetical send method to prove it is never called
    (loop as any).send = mockSend;

    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // processed

    // The mock infer was called (proving perception ran)
    expect(mockInfer).toHaveBeenCalledTimes(1);
    // But no external send was invoked
    expect(mockSend).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8. Parse failure: infer returns invalid JSON
  // -------------------------------------------------------------------------
  test('8. Parse failure: invalid JSON from infer increments parseFailures', async () => {
    const mockInfer = jest.fn().mockResolvedValue('this is not json at all {{{');
    const { loop } = createLoop(mockInfer);
    loop.setGoalText('navigate to the red cube');

    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // processed

    expect(loop.getStats().parseFailures).toBe(1);
    expect(loop.getStats().framesProcessed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 9. Inference error: infer rejects
  // -------------------------------------------------------------------------
  test('9. Inference error: rejected infer increments inferenceErrors', async () => {
    const mockInfer = jest.fn().mockRejectedValue(new Error('API timeout'));
    const { loop } = createLoop(mockInfer);
    loop.setGoalText('navigate to the red cube');

    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // processed (error caught)

    expect(loop.getStats().inferenceErrors).toBe(1);
    expect(loop.getStats().framesProcessed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 10. setGoal explicitly overrides text-based resolution
  // -------------------------------------------------------------------------
  test('10. setGoal explicitly sets controller goal', async () => {
    const mockInfer = jest.fn().mockResolvedValue(VALID_SCENE_JSON);
    const { loop, controller } = createLoop(mockInfer);

    // Set an explicit point goal (not using text resolution)
    const explicitGoal: ControllerGoal = { kind: 'point', x: 250, y: 150 };
    loop.setGoal(explicitGoal);

    // Spy on controller.decide to capture the goal it receives
    const decideSpy = jest.spyOn(controller, 'decide');

    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // processed

    expect(decideSpy).toHaveBeenCalledTimes(1);
    const calledGoal = decideSpy.mock.calls[0][1];
    expect(calledGoal).toEqual(explicitGoal);
  });

  // -------------------------------------------------------------------------
  // 11. setGoalText fuzzy-resolves goal from SceneGraph after projection
  // -------------------------------------------------------------------------
  test('11. setGoalText resolves goal from SceneGraph after projection', async () => {
    const mockInfer = jest.fn().mockResolvedValue(VALID_SCENE_JSON);
    const { loop, controller } = createLoop(mockInfer);

    // Use text goal — should fuzzy-match "red cube" in the projected scene
    loop.setGoalText('navigate to the red cube');

    const decideSpy = jest.spyOn(controller, 'decide');

    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // processed

    expect(decideSpy).toHaveBeenCalledTimes(1);
    const calledGoal = decideSpy.mock.calls[0][1];
    // The resolved goal should be a node reference to the "red cube" node
    expect(calledGoal).toHaveProperty('kind', 'node');
    expect((calledGoal as { kind: 'node'; id: string }).id).toMatch(/red_cube/);
  });

  // -------------------------------------------------------------------------
  // 12. Telemetry provider overrides robot pose
  // -------------------------------------------------------------------------
  test('12. Telemetry provider overrides robot pose from projection', async () => {
    const mockInfer = jest.fn().mockResolvedValue(VALID_SCENE_JSON);
    const { loop, graph } = createLoop(mockInfer);
    loop.setGoalText('navigate to the red cube');

    // Set up a telemetry provider that places the robot at (99, 88) heading 45 deg
    const headingRad = (45 * Math.PI) / 180;
    const telemetryProvider: TelemetryProvider = {
      getLastTelemetry: () => ({ pose: { x: 99, y: 88, h: headingRad } }),
    };
    loop.setTelemetryProvider(telemetryProvider);

    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // processed

    // After processing, robot pose should reflect telemetry, not projection
    expect(graph.robot.position[0]).toBeCloseTo(99, 0);
    expect(graph.robot.position[1]).toBeCloseTo(88, 0);
    expect(graph.robot.getHeadingDegrees()).toBeCloseTo(45, 0);
  });

  // -------------------------------------------------------------------------
  // 13. Stats tracking across multiple frames
  // -------------------------------------------------------------------------
  test('13. Stats track framesReceived, framesProcessed, divergences, agreements', async () => {
    // First call: agreement scene, second call: default scene (divergence)
    const mockInfer = jest.fn()
      .mockResolvedValueOnce(AGREEMENT_SCENE_JSON)
      .mockResolvedValueOnce(VALID_SCENE_JSON);
    const { loop } = createLoop(mockInfer);
    loop.setGoalText('navigate to the red cube');

    // Frames 1-2: agreement (MOVE_FORWARD matches controller)
    await loop.onFrame(DUMMY_FRAME, VLM_FORWARD_200); // frame 1 — skipped
    await loop.onFrame(DUMMY_FRAME, VLM_FORWARD_200); // frame 2 — processed (agreement)

    // Frames 3-4: divergence (STOP while robot is far from target)
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // frame 3 — skipped
    await loop.onFrame(DUMMY_FRAME, VLM_STOP); // frame 4 — processed (divergence)

    const stats = loop.getStats();
    expect(stats.framesReceived).toBe(4);
    expect(stats.framesProcessed).toBe(2);
    expect(stats.agreements).toBe(1);
    expect(stats.divergences).toBe(1);
    expect(stats.parseFailures).toBe(0);
    expect(stats.inferenceErrors).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 14. Processing guard: does not process while previous frame is in-flight
  // -------------------------------------------------------------------------
  test('14. Does not process while previous frame is still processing (processing guard)', async () => {
    // Create a slow infer that we can control
    let resolveInfer: (value: string) => void;
    const slowInferPromise = new Promise<string>(resolve => {
      resolveInfer = resolve;
    });
    const mockInfer = jest.fn().mockReturnValue(slowInferPromise);
    const { loop } = createLoop(mockInfer);
    loop.setGoalText('navigate to the red cube');

    // Frame 1: skipped (frameSkip=2)
    await loop.onFrame(DUMMY_FRAME, VLM_STOP);

    // Frame 2: starts processing (does NOT await — we start it, don't resolve yet)
    const frame2Promise = loop.onFrame(DUMMY_FRAME, VLM_STOP);

    // Frame 3: skipped by frameSkip
    await loop.onFrame(DUMMY_FRAME, VLM_STOP);

    // Frame 4: should be eligible (frameCount=4, 4%2==0) but blocked by processing guard
    const frame4Promise = loop.onFrame(DUMMY_FRAME, VLM_STOP);

    // At this point, frame 2 is still in-flight. infer should only have been called once.
    expect(mockInfer).toHaveBeenCalledTimes(1);

    // Resolve the slow inference
    resolveInfer!(VALID_SCENE_JSON);
    await frame2Promise;
    await frame4Promise;

    // Still only 1 call — frame 4 was dropped by the guard
    expect(mockInfer).toHaveBeenCalledTimes(1);
    expect(loop.getStats().framesReceived).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 15. Divergence event contains correct info fields
  // -------------------------------------------------------------------------
  test('15. Divergence event contains all required DivergenceInfo fields', async () => {
    const mockInfer = jest.fn().mockResolvedValue(VALID_SCENE_JSON);
    const { loop } = createLoop(mockInfer);
    loop.setGoalText('navigate to the red cube');

    const divergencePromise = new Promise<DivergenceInfo>(resolve => {
      loop.on('divergence', resolve);
    });

    // VLM_TURN_RIGHT will diverge from the controller decision
    await loop.onFrame(DUMMY_FRAME, VLM_TURN_RIGHT); // skipped
    await loop.onFrame(DUMMY_FRAME, VLM_TURN_RIGHT); // processed

    const info = await divergencePromise;

    // Check all DivergenceInfo fields are present and typed correctly
    expect(typeof info.action).toBe('string');
    expect(info.action.length).toBeGreaterThan(0);
    expect(typeof info.reason).toBe('string');
    expect(info.reason.length).toBeGreaterThan(0);
    expect(typeof info.vlmHex).toBe('string');
    expect(info.vlmHex).toMatch(/^[0-9A-F]{2}(\s[0-9A-F]{2}){5}$/); // 6 hex bytes
    expect(typeof info.controllerHex).toBe('string');
    expect(info.controllerHex).toMatch(/^[0-9A-F]{2}(\s[0-9A-F]{2}){5}$/);
    expect(typeof info.distanceCm).toBe('number');
    expect(info.distanceCm).toBeGreaterThan(0);
    expect(typeof info.bearingDeg).toBe('number');
    expect(typeof info.objectCount).toBe('number');
    expect(info.objectCount).toBe(2); // roclaw + red cube
  });
});
