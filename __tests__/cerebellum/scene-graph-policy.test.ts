import { SceneGraphPolicy } from '../../src/2_qwen_cerebellum/scene_graph_policy';
import { BytecodeCompiler, Opcode, decodeFrame, FRAME_SIZE } from '../../src/2_qwen_cerebellum/bytecode_compiler';
import { SceneGraph } from '../../src/3_llmunix_memory/scene_graph';
import { ReactiveController } from '../../src/1_openclaw_cortex/reactive_controller';
import type { InferenceFunction } from '../../src/llmunix-core/interfaces';
import type { ArenaConfig } from '../../src/2_qwen_cerebellum/vision_projector';
import type { TelemetrySnapshot } from '../../src/2_qwen_cerebellum/perception_policy';

// =============================================================================
// Helpers
// =============================================================================

const ARENA: ArenaConfig = { widthCm: 300, heightCm: 200 };

/** Build a valid Gemini scene JSON response with roclaw + objects. */
function makeSceneJson(objects: Array<{
  label: string;
  box_2d: [number, number, number, number];
  heading_estimate?: string;
}>): string {
  return JSON.stringify({ objects });
}

/** Standard two-object scene: robot at left, red cube at right. */
const STANDARD_SCENE = makeSceneJson([
  { label: 'roclaw', box_2d: [400, 100, 600, 200], heading_estimate: 'RIGHT' },
  { label: 'red cube', box_2d: [400, 700, 600, 800] },
]);

/** Scene with no objects (empty). */
const EMPTY_SCENE = makeSceneJson([]);

/** Scene with robot only — no targets. */
const ROBOT_ONLY_SCENE = makeSceneJson([
  { label: 'roclaw', box_2d: [400, 100, 600, 200], heading_estimate: 'RIGHT' },
]);

/** Scene with robot and target to the side (requiring rotation). */
const SIDE_TARGET_SCENE = makeSceneJson([
  { label: 'roclaw', box_2d: [400, 400, 600, 600], heading_estimate: 'RIGHT' },
  { label: 'red cube', box_2d: [100, 400, 200, 600] }, // above robot (Y is lower = up in image = lower Y in arena)
]);

/** Scene with robot nearly on top of target (arrival). */
const ARRIVAL_SCENE = makeSceneJson([
  { label: 'roclaw', box_2d: [480, 500, 520, 540], heading_estimate: 'RIGHT' },
  { label: 'red cube', box_2d: [485, 505, 515, 535] },
]);

describe('SceneGraphPolicy', () => {
  let compiler: BytecodeCompiler;
  let graph: SceneGraph;
  let controller: ReactiveController;
  let mockPerceptionInfer: jest.Mock;

  beforeEach(() => {
    compiler = new BytecodeCompiler('fewshot');
    graph = new SceneGraph();
    controller = new ReactiveController();
    mockPerceptionInfer = jest.fn<Promise<string>, [string, string, string[] | undefined]>();
    mockPerceptionInfer.mockResolvedValue(STANDARD_SCENE);
  });

  function makePolicy(): SceneGraphPolicy {
    return new SceneGraphPolicy(graph, controller, mockPerceptionInfer as InferenceFunction, compiler, ARENA);
  }

  // ===========================================================================
  // 1. Calls perception infer with OVERHEAD_SCENE_PROMPT
  // ===========================================================================

  test('calls perception infer with OVERHEAD_SCENE_PROMPT', async () => {
    const policy = makePolicy();

    await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    expect(mockPerceptionInfer).toHaveBeenCalledTimes(1);
    const [prompt, userMsg, frames] = mockPerceptionInfer.mock.calls[0];
    // The prompt is from getOverheadScenePrompt — should have perception-specific text
    expect(prompt).toContain('spatial perception engine');
    expect(prompt).toContain('OVERHEAD');
    expect(prompt).toContain('navigate to the red cube');
    expect(prompt).toContain('box_2d');
    expect(userMsg).toBe('Detect all objects in this overhead view.');
    expect(frames).toEqual(['base64frame']);
  });

  // ===========================================================================
  // 2. Parses Gemini JSON and populates SceneGraph
  // ===========================================================================

  test('parses Gemini JSON and populates SceneGraph', async () => {
    const policy = makePolicy();

    await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    // Robot should be projected into the graph
    expect(graph.robot.position[0]).toBeGreaterThan(0);
    expect(graph.robot.position[1]).toBeGreaterThan(0);

    // Red cube should be in the graph as an obstacle
    const obstacles = graph.getObstacles();
    expect(obstacles.length).toBeGreaterThanOrEqual(1);
    const cube = obstacles.find(n => n.label === 'red cube');
    expect(cube).toBeDefined();
  });

  // ===========================================================================
  // 3. Controller decides MOVE_FORWARD when target is ahead
  // ===========================================================================

  test('controller decides MOVE_FORWARD when target is ahead', async () => {
    const policy = makePolicy();

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    // Standard scene: robot at left facing RIGHT, cube at right -> move forward
    expect(result.bytecode).not.toBeNull();
    const decoded = decodeFrame(result.bytecode!);
    expect(decoded).not.toBeNull();
    expect(decoded!.opcode).toBe(Opcode.MOVE_FORWARD);
    expect(result.metadata?.action).toBe('move_forward');
  });

  // ===========================================================================
  // 4. Controller decides ROTATE when target is to the side
  // ===========================================================================

  test('controller decides ROTATE when target is to the side', async () => {
    mockPerceptionInfer.mockResolvedValue(SIDE_TARGET_SCENE);
    const policy = makePolicy();

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    expect(result.bytecode).not.toBeNull();
    const decoded = decodeFrame(result.bytecode!);
    expect(decoded).not.toBeNull();
    // Target is to the side, so controller should rotate
    const isRotation = decoded!.opcode === Opcode.ROTATE_CW || decoded!.opcode === Opcode.ROTATE_CCW;
    expect(isRotation).toBe(true);
    expect(
      result.metadata?.action === 'rotate_cw' || result.metadata?.action === 'rotate_ccw'
    ).toBe(true);
  });

  // ===========================================================================
  // 5. Returns STOP when arrived at target
  // ===========================================================================

  test('returns STOP when arrived at target', async () => {
    mockPerceptionInfer.mockResolvedValue(ARRIVAL_SCENE);
    controller = new ReactiveController({ arrivalThresholdCm: 10 });
    const policy = new SceneGraphPolicy(graph, controller, mockPerceptionInfer as InferenceFunction, compiler, ARENA);

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    expect(result.bytecode).not.toBeNull();
    const decoded = decodeFrame(result.bytecode!);
    expect(decoded).not.toBeNull();
    expect(decoded!.opcode).toBe(Opcode.STOP);
    expect(result.metadata?.action).toBe('arrived');
  });

  // ===========================================================================
  // 6. Returns STOP when no objects parsed (safety fallback)
  // ===========================================================================

  test('returns STOP when no objects parsed (safety fallback)', async () => {
    mockPerceptionInfer.mockResolvedValue('totally invalid garbage response');
    const policy = makePolicy();

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    expect(result.bytecode).not.toBeNull();
    const decoded = decodeFrame(result.bytecode!);
    expect(decoded).not.toBeNull();
    expect(decoded!.opcode).toBe(Opcode.STOP);
    expect(result.metadata?.objectCount).toBe(0);
    expect(result.metadata?.action).toBe('parse_failure');
  });

  // ===========================================================================
  // 7. Returns STOP when goal unresolved (no matching node)
  // ===========================================================================

  test('returns STOP when goal unresolved (no matching node)', async () => {
    mockPerceptionInfer.mockResolvedValue(ROBOT_ONLY_SCENE);
    const policy = makePolicy();

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    // Robot-only scene has no "red cube" node for the goal to match
    expect(result.bytecode).not.toBeNull();
    const decoded = decodeFrame(result.bytecode!);
    expect(decoded).not.toBeNull();
    expect(decoded!.opcode).toBe(Opcode.STOP);
    expect(result.metadata?.action).toBe('no_target');
  });

  // ===========================================================================
  // 8. Telemetry overrides vision-based robot pose
  // ===========================================================================

  test('telemetry overrides vision-based robot pose', async () => {
    const policy = makePolicy();

    const telemetry: TelemetrySnapshot = {
      pose: { x: 99.0, y: 77.0, h: Math.PI / 2 }, // 90 degrees
    };

    await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      telemetry,
      [],
    );

    // After processFrame, the robot pose should be overridden by telemetry
    expect(graph.robot.position[0]).toBeCloseTo(99.0, 1);
    expect(graph.robot.position[1]).toBeCloseTo(77.0, 1);
    expect(graph.robot.getHeadingDegrees()).toBeCloseTo(90, 1);
  });

  // ===========================================================================
  // 9. Metadata includes objectCount and action
  // ===========================================================================

  test('metadata includes objectCount and action', async () => {
    const policy = makePolicy();

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    expect(result.metadata).toBeDefined();
    // Standard scene has 2 objects (roclaw + red cube), but roclaw updates robot
    // and red cube is projected as an obstacle. objectCount should reflect parsed count.
    expect(typeof result.metadata!.objectCount).toBe('number');
    expect(result.metadata!.objectCount).toBe(2);
    expect(typeof result.metadata!.action).toBe('string');
  });

  // ===========================================================================
  // 10. Constraints are appended to prompt
  // ===========================================================================

  test('constraints are appended to prompt', async () => {
    const policy = makePolicy();

    await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      ['Stay 20cm from walls', 'Prefer left turns'],
    );

    expect(mockPerceptionInfer).toHaveBeenCalledTimes(1);
    const [prompt] = mockPerceptionInfer.mock.calls[0];
    expect(prompt).toContain('ADDITIONAL CONTEXT:');
    expect(prompt).toContain('- Stay 20cm from walls');
    expect(prompt).toContain('- Prefer left turns');
  });

  // ===========================================================================
  // 11. vlmOutput is JSON string of detected objects
  // ===========================================================================

  test('vlmOutput is JSON string of detected objects', async () => {
    const policy = makePolicy();

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    // vlmOutput should be the JSON.stringify'd array of GeminiObject[]
    const parsed = JSON.parse(result.vlmOutput);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].label).toBe('roclaw');
    expect(parsed[1].label).toBe('red cube');
  });

  // ===========================================================================
  // 12. Multiple objects projected correctly
  // ===========================================================================

  test('multiple objects projected correctly', async () => {
    const threeObjectScene = makeSceneJson([
      { label: 'roclaw', box_2d: [400, 100, 600, 200], heading_estimate: 'RIGHT' },
      { label: 'red cube', box_2d: [400, 700, 600, 800] },
      { label: 'blue box', box_2d: [100, 400, 200, 500] },
    ]);
    mockPerceptionInfer.mockResolvedValue(threeObjectScene);
    const policy = makePolicy();

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    // Should have robot + 2 obstacles
    const obstacles = graph.getObstacles();
    expect(obstacles.length).toBe(2);
    const labels = obstacles.map(n => n.label).sort();
    expect(labels).toEqual(['blue box', 'red cube']);
    expect(result.metadata?.objectCount).toBe(3);
  });

  // ===========================================================================
  // 13. Object identity: same-label objects within matchRadius reuse node ID
  // ===========================================================================

  test('object identity: same-label objects within matchRadius reuse node ID', async () => {
    const policy = makePolicy();

    // First frame: red cube at position (225, 100) in arena
    await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    const firstCube = graph.getObstacles().find(n => n.label === 'red cube');
    expect(firstCube).toBeDefined();
    const firstId = firstCube!.id;

    // Second frame: red cube moved slightly (within default matchRadius of 30cm)
    const slightlyMovedScene = makeSceneJson([
      { label: 'roclaw', box_2d: [400, 100, 600, 200], heading_estimate: 'RIGHT' },
      { label: 'red cube', box_2d: [400, 710, 600, 810] }, // slightly shifted
    ]);
    mockPerceptionInfer.mockResolvedValue(slightlyMovedScene);

    await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    // Should reuse the same node ID (object identity preserved)
    const secondCube = graph.getObstacles().find(n => n.label === 'red cube');
    expect(secondCube).toBeDefined();
    expect(secondCube!.id).toBe(firstId);
  });

  // ===========================================================================
  // 14. Goal resolution: "navigate to the red cube" matches node "red cube"
  // ===========================================================================

  test('goal resolution: "navigate to the red cube" matches node "red cube"', async () => {
    const policy = makePolicy();

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    // If goal resolved, the controller should produce a movement command (not 'no_target')
    expect(result.metadata?.action).not.toBe('no_target');
    // The action should be either move_forward, rotate_*, or arrived
    expect(['move_forward', 'rotate_cw', 'rotate_ccw', 'arrived']).toContain(
      result.metadata?.action
    );
  });

  // ===========================================================================
  // 15. Full pipeline: perceive -> project -> decide -> return bytecode
  // ===========================================================================

  test('full pipeline: perceive -> project -> decide -> return bytecode', async () => {
    const policy = makePolicy();

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    // 1. Perception was called
    expect(mockPerceptionInfer).toHaveBeenCalledTimes(1);

    // 2. Graph was populated
    expect(graph.robot.position[0]).toBeGreaterThan(0);
    expect(graph.getObstacles().length).toBeGreaterThanOrEqual(1);

    // 3. Bytecode was produced
    expect(result.bytecode).not.toBeNull();
    expect(result.bytecode!.length).toBe(FRAME_SIZE);

    // 4. Frame is valid (start and end markers)
    expect(result.bytecode![0]).toBe(0xAA);
    expect(result.bytecode![5]).toBe(0xFF);

    // 5. Decodes cleanly
    const decoded = decodeFrame(result.bytecode!);
    expect(decoded).not.toBeNull();

    // 6. VLM output is parseable
    const parsedOutput = JSON.parse(result.vlmOutput);
    expect(Array.isArray(parsedOutput)).toBe(true);

    // 7. Metadata is present
    expect(result.metadata).toBeDefined();
    expect(typeof result.metadata!.objectCount).toBe('number');
    expect(typeof result.metadata!.action).toBe('string');
  });
});
