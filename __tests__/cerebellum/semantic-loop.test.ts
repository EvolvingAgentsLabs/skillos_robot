import { SemanticLoop, type PerceptionEvent } from '../../src/brain/perception/semantic_loop';
import { SceneGraph } from '../../src/brain/memory/scene_graph';
import { BytecodeCompiler } from '../../src/control/bytecode_compiler';
import type { InferenceFunction } from '../../src/brain/inference/inference';
import type { ArenaConfig } from '../../src/brain/perception/vision_projector';

describe('SemanticLoop', () => {
  let graph: SceneGraph;
  let compiler: BytecodeCompiler;
  let mockInfer: jest.Mock;
  let loop: SemanticLoop;
  const arena: ArenaConfig = { widthCm: 300, heightCm: 200 };

  beforeEach(() => {
    graph = new SceneGraph();
    compiler = new BytecodeCompiler('fewshot');
    mockInfer = jest.fn<Promise<string>, [string, string, string[] | undefined]>();

    loop = new SemanticLoop(graph, mockInfer as InferenceFunction, compiler, arena, {
      intervalMs: 50, // Fast for tests
    });
  });

  afterEach(() => {
    loop.stop();
  });

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  test('starts and stops correctly', () => {
    expect(loop.isRunning()).toBe(false);
    loop.start();
    expect(loop.isRunning()).toBe(true);
    loop.stop();
    expect(loop.isRunning()).toBe(false);
  });

  test('start is idempotent', () => {
    loop.start();
    loop.start(); // No-op
    expect(loop.isRunning()).toBe(true);
    loop.stop();
  });

  // ===========================================================================
  // Goal management
  // ===========================================================================

  test('default goal', () => {
    expect(loop.getGoal()).toBe('explore and avoid obstacles');
  });

  test('setGoal updates goal', () => {
    loop.setGoal('navigate to the red cube');
    expect(loop.getGoal()).toBe('navigate to the red cube');
  });

  // ===========================================================================
  // Constraints
  // ===========================================================================

  test('constraints default to empty', () => {
    expect(loop.getConstraints()).toEqual([]);
  });

  test('setConstraints updates constraints', () => {
    loop.setConstraints(['stay close to walls', 'avoid the table']);
    expect(loop.getConstraints()).toEqual(['stay close to walls', 'avoid the table']);
  });

  // ===========================================================================
  // Frame feeding
  // ===========================================================================

  test('feedFrame stores frames', () => {
    loop.feedFrame('frame1');
    loop.feedFrame('frame2');
    expect(loop.getFrameHistory()).toEqual(['frame1', 'frame2']);
    expect(loop.getLatestFrame()).toBe('frame2');
  });

  test('frame buffer respects history size', () => {
    const smallLoop = new SemanticLoop(graph, mockInfer as InferenceFunction, compiler, arena, {
      intervalMs: 50,
      frameHistorySize: 2,
    });
    smallLoop.feedFrame('a');
    smallLoop.feedFrame('b');
    smallLoop.feedFrame('c');
    expect(smallLoop.getFrameHistory()).toEqual(['b', 'c']);
    smallLoop.stop();
  });

  test('getLatestFrame returns empty string when no frames', () => {
    expect(loop.getLatestFrame()).toBe('');
  });

  // ===========================================================================
  // Perception cycle
  // ===========================================================================

  test('emits perception event on successful VLM call', async () => {
    // Mock VLM response with a detected object
    mockInfer.mockResolvedValue(JSON.stringify({
      objects: [
        { label: 'red cube', box_2d: [100, 200, 300, 400] },
      ],
    }));

    const events: PerceptionEvent[] = [];
    loop.on('perception', (e: PerceptionEvent) => events.push(e));

    loop.feedFrame('test-frame-base64');
    loop.start();

    // Wait for at least one perception cycle
    await new Promise(resolve => setTimeout(resolve, 120));
    loop.stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].objects.length).toBe(1);
    expect(events[0].objects[0].label).toBe('red cube');
    expect(events[0].inferenceMs).toBeGreaterThanOrEqual(0);
  });

  test('skips tick when no frames available', async () => {
    // No frames fed — inference should never be called
    loop.start();
    await new Promise(resolve => setTimeout(resolve, 120));
    loop.stop();

    expect(mockInfer).not.toHaveBeenCalled();
  });

  test('skips tick during back-pressure (VLM in-flight)', async () => {
    // Make VLM call take longer than the interval
    mockInfer.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      return JSON.stringify({ objects: [] });
    });

    loop.feedFrame('frame');
    loop.start();

    // Wait for 2 intervals but VLM takes 200ms
    await new Promise(resolve => setTimeout(resolve, 160));
    loop.stop();

    // Should only have been called once (back-pressure skips second tick)
    expect(mockInfer).toHaveBeenCalledTimes(1);
  });

  test('handles VLM inference errors gracefully', async () => {
    mockInfer.mockRejectedValue(new Error('VLM timeout'));

    const errors: Error[] = [];
    loop.on('error', (e: Error) => errors.push(e));

    loop.feedFrame('frame');
    loop.start();
    await new Promise(resolve => setTimeout(resolve, 120));
    loop.stop();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    const stats = loop.getStats();
    expect(stats.inferenceErrors).toBeGreaterThanOrEqual(1);
  });

  test('handles empty/unparseable VLM response gracefully', async () => {
    mockInfer.mockResolvedValue('this is not json');

    const events: PerceptionEvent[] = [];
    loop.on('perception', (e: PerceptionEvent) => events.push(e));

    loop.feedFrame('frame');
    loop.start();
    await new Promise(resolve => setTimeout(resolve, 120));
    loop.stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].objects).toEqual([]);
  });

  // ===========================================================================
  // Goal resolution
  // ===========================================================================

  test('resolves goal to explore when no objects in graph', async () => {
    mockInfer.mockResolvedValue(JSON.stringify({ objects: [] }));

    loop.setGoal('navigate to the red cube');
    loop.feedFrame('frame');

    const events: PerceptionEvent[] = [];
    loop.on('perception', (e: PerceptionEvent) => events.push(e));

    loop.start();
    await new Promise(resolve => setTimeout(resolve, 120));
    loop.stop();

    expect(events[0].resolvedGoal.kind).toBe('explore');
    expect(loop.getResolvedGoal().kind).toBe('explore');
  });

  test('resolves goal to node when matching object detected', async () => {
    mockInfer.mockResolvedValue(JSON.stringify({
      objects: [
        { label: 'red cube', box_2d: [400, 400, 600, 600] },
      ],
    }));

    loop.setGoal('navigate to the red cube');
    loop.feedFrame('frame');

    const events: PerceptionEvent[] = [];
    loop.on('perception', (e: PerceptionEvent) => events.push(e));

    loop.start();
    await new Promise(resolve => setTimeout(resolve, 120));
    loop.stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    const goal = events[0].resolvedGoal;
    expect(goal.kind).toBe('node');
  });

  // ===========================================================================
  // Stats
  // ===========================================================================

  test('stats track perception cycles', async () => {
    mockInfer.mockResolvedValue(JSON.stringify({
      objects: [{ label: 'box', box_2d: [0, 0, 100, 100] }],
    }));

    loop.feedFrame('frame');
    loop.start();
    await new Promise(resolve => setTimeout(resolve, 120));
    loop.stop();

    const stats = loop.getStats();
    expect(stats.perceptionCycles).toBeGreaterThanOrEqual(1);
    expect(stats.objectsDetected).toBeGreaterThanOrEqual(1);
    expect(stats.avgInferenceMs).toBeGreaterThanOrEqual(0);
    expect(stats.running).toBe(false);
  });
});
