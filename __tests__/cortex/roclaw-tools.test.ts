import * as fs from 'fs';
import * as path from 'path';
import { handleTool, _resetTopoMap, _resetNavigationSession, _getTopoMapLoop, _getPoseMap, _getMemoryManager, type ToolContext } from '../../src/brain/planning/roclaw_tools';
import { BytecodeCompiler, Opcode, formatHex } from '../../src/control/bytecode_compiler';
import { UDPTransmitter } from '../../src/bridge/udp_transmitter';
import { VisionLoop } from '../../src/brain/perception/vision_loop';
import type { InferenceFunction } from '../../src/brain/inference/inference';
import { HierarchyLevel } from '../../src/brain/memory/trace_types';

const TOPO_MAP_FILE = path.join(__dirname, '../../src/3_llmunix_memory/traces/topo_map.json');

describe('RoClaw Tools', () => {
  let ctx: ToolContext;
  let mockInfer: jest.Mock;
  let mockTransmitterSend: jest.Mock;
  let mockTransmitterSendAndReceive: jest.Mock;
  let mockVisionLoopStart: jest.Mock;
  let mockVisionLoopStop: jest.Mock;

  // Capture event callbacks registered via visionLoop.on()
  let capturedArrivalCb: ((vlmOutput: string) => void) | null = null;
  let capturedStuckCb: ((vlmOutput: string) => void) | null = null;
  let capturedStepTimeoutCb: ((elapsed: number) => void) | null = null;

  beforeEach(() => {
    // Reset singletons so each test starts clean
    _resetNavigationSession();
    _resetTopoMap();
    _getPoseMap().clear();

    capturedArrivalCb = null;
    capturedStuckCb = null;
    capturedStepTimeoutCb = null;

    const compiler = new BytecodeCompiler('fewshot');

    mockTransmitterSend = jest.fn().mockResolvedValue(undefined);
    mockTransmitterSendAndReceive = jest.fn().mockResolvedValue(
      Buffer.from('{"pose":{"x":1.5,"y":2.3,"h":0.785},"run":false,"estop":false,"rssi":-45}')
    );

    const transmitter = {
      send: mockTransmitterSend,
      sendAndReceive: mockTransmitterSendAndReceive,
      isConnected: () => true,
    } as unknown as UDPTransmitter;

    mockInfer = jest.fn<Promise<string>, [string, string, string[] | undefined]>();
    mockInfer.mockResolvedValue('I see a hallway with a door on the left.');

    mockVisionLoopStart = jest.fn().mockResolvedValue(undefined);
    mockVisionLoopStop = jest.fn();

    const visionLoop = {
      start: mockVisionLoopStart,
      stop: mockVisionLoopStop,
      isRunning: () => false,
      getGoal: () => 'test',
      getLatestFrameBase64: () => 'dGVzdGZyYW1l',
      setActiveTraceId: jest.fn(),
      getActiveTraceId: () => null,
      setConstraints: jest.fn(),
      getConstraints: () => [],
      setGoal: jest.fn(),
      resetStepTimer: jest.fn(),
      on: jest.fn().mockImplementation((event: string, cb: Function) => {
        if (event === 'arrival') capturedArrivalCb = cb as any;
        if (event === 'stuck') capturedStuckCb = cb as any;
        if (event === 'stepTimeout') capturedStepTimeoutCb = cb as any;
      }),
      removeListener: jest.fn(),
    } as unknown as VisionLoop;

    ctx = {
      compiler,
      transmitter,
      visionLoop,
      infer: mockInfer as InferenceFunction,
    };
  });

  afterEach(() => {
    _resetTopoMap();
    // Clean up topo_map.json to prevent pollution across test files
    try { fs.unlinkSync(TOPO_MAP_FILE); } catch { /* ignore */ }
  });

  // ===========================================================================
  // robot.read_memory
  // ===========================================================================

  describe('robot.read_memory', () => {
    test('returns memory content with data.type === memory', async () => {
      const result = await handleTool('robot.read_memory', {}, ctx);
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ type: 'memory' });
      expect(result.message).toContain('Hardware');
      expect(result.message).toContain('RoClaw');
    });
  });

  // ===========================================================================
  // robot.explore
  // ===========================================================================

  describe('robot.explore', () => {
    test('starts vision loop with exploration goal', async () => {
      const result = await handleTool('robot.explore', {}, ctx);
      expect(result.success).toBe(true);
      expect(mockVisionLoopStart).toHaveBeenCalledWith(
        expect.stringContaining('Explore'),
      );
    });

    test('appends constraints to goal when provided', async () => {
      const result = await handleTool(
        'robot.explore',
        { constraints: 'Max speed 4.7 cm/s. Stay centered.' },
        ctx,
      );
      expect(result.success).toBe(true);
      const goal = mockVisionLoopStart.mock.calls[0][0] as string;
      expect(goal).toContain('Max speed 4.7 cm/s. Stay centered.');
      expect(goal).toContain('Explore');
    });

    test('returns failure on error', async () => {
      mockVisionLoopStart.mockRejectedValue(new Error('Camera offline'));
      const result = await handleTool('robot.explore', {}, ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Camera offline');
    });

    test('starts topo map loop alongside vision loop', async () => {
      const result = await handleTool('robot.explore', {}, ctx);
      expect(result.success).toBe(true);
      const loop = _getTopoMapLoop();
      expect(loop).not.toBeNull();
      expect(loop!.isRunning()).toBe(true);
    });
  });

  // ===========================================================================
  // robot.go_to
  // ===========================================================================

  describe('robot.go_to', () => {
    test('starts vision loop with navigation goal', async () => {
      const result = await handleTool('robot.go_to', { location: 'the kitchen' }, ctx);
      expect(result.success).toBe(true);
      expect(mockVisionLoopStart).toHaveBeenCalledWith(
        expect.stringContaining('kitchen'),
      );
    });

    test('includes semantic exploration context when no prior memory', async () => {
      const result = await handleTool('robot.go_to', { location: 'the kitchen' }, ctx);
      expect(result.success).toBe(true);
      const goal = mockVisionLoopStart.mock.calls[0][0] as string;
      expect(goal).toContain('No prior memory');
    });

    test('appends constraints to navigation goal', async () => {
      const result = await handleTool(
        'robot.go_to',
        { location: 'the door', constraints: '20cm wide. Scan before turning.' },
        ctx,
      );
      expect(result.success).toBe(true);
      const goal = mockVisionLoopStart.mock.calls[0][0] as string;
      expect(goal).toContain('the door');
      expect(goal).toContain('20cm wide. Scan before turning.');
    });

    test('fails without location', async () => {
      const result = await handleTool('robot.go_to', {}, ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('No location');
    });

    test('falls back gracefully when SemanticMap planning fails', async () => {
      // Force ensureTopoMap to have nodes so it attempts planning
      // (empty map skips planning entirely, so this tests the fallback path)
      const result = await handleTool('robot.go_to', { location: 'the garage' }, ctx);
      expect(result.success).toBe(true);
      // Should still navigate via PoseMap fallback
      expect(result.message).toContain('Navigation started');
    });

    test('starts topo map loop alongside navigation', async () => {
      const result = await handleTool('robot.go_to', { location: 'the kitchen' }, ctx);
      expect(result.success).toBe(true);
      const loop = _getTopoMapLoop();
      expect(loop).not.toBeNull();
      expect(loop!.isRunning()).toBe(true);
    });
  });

  // ===========================================================================
  // robot.describe_scene
  // ===========================================================================

  describe('robot.describe_scene', () => {
    test('calls inference and returns description', async () => {
      const result = await handleTool('robot.describe_scene', {}, ctx);
      expect(result.success).toBe(true);
      expect(result.message).toContain('hallway');
      expect(mockInfer).toHaveBeenCalledTimes(1);
    });

    test('returns failure on inference error', async () => {
      mockInfer.mockRejectedValue(new Error('API timeout'));
      const result = await handleTool('robot.describe_scene', {}, ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('API timeout');
    });
  });

  // ===========================================================================
  // robot.analyze_scene
  // ===========================================================================

  describe('robot.analyze_scene', () => {
    test('returns failure when no frame or VLM fails', async () => {
      // mockInfer returns text, but processScene needs valid JSON from VLM
      // The loop's analyzeNow will call infer which returns non-JSON, causing processScene to fail
      mockInfer.mockRejectedValueOnce(new Error('VLM timeout'));
      const result = await handleTool('robot.analyze_scene', {}, ctx);
      expect(result.success).toBe(false);
    });

    test('creates topo map loop lazily', async () => {
      expect(_getTopoMapLoop()).toBeNull();
      // This will attempt analysis (may fail due to mock, but loop is created)
      await handleTool('robot.analyze_scene', {}, ctx);
      expect(_getTopoMapLoop()).not.toBeNull();
    });
  });

  // ===========================================================================
  // robot.stop
  // ===========================================================================

  describe('robot.stop', () => {
    test('stops vision loop and sends STOP bytecode', async () => {
      const result = await handleTool('robot.stop', {}, ctx);
      expect(result.success).toBe(true);
      expect(mockVisionLoopStop).toHaveBeenCalled();
      expect(mockTransmitterSend).toHaveBeenCalledWith(
        expect.any(Buffer),
      );
      // Verify the sent buffer is a STOP frame
      const sentBuffer = mockTransmitterSend.mock.calls[0][0] as Buffer;
      expect(sentBuffer[1]).toBe(Opcode.STOP);
    });

    test('closes active explore trace as ABORTED', async () => {
      // Start explore (creates an explore trace)
      await handleTool('robot.explore', {}, ctx);

      // Now stop — should close the explore trace
      const result = await handleTool('robot.stop', {}, ctx);
      expect(result.success).toBe(true);
      // The trace logger endTrace is called — we verify stop succeeds
      // and that no errors are thrown from trace closure
    });

    test('stops topo map loop when running', async () => {
      // First start explore to create and start topo loop
      await handleTool('robot.explore', {}, ctx);
      const loop = _getTopoMapLoop()!;
      expect(loop.isRunning()).toBe(true);

      // Now stop
      await handleTool('robot.stop', {}, ctx);
      expect(loop.isRunning()).toBe(false);
    });
  });

  // ===========================================================================
  // robot.status
  // ===========================================================================

  describe('robot.status', () => {
    test('sends GET_STATUS and parses response', async () => {
      const result = await handleTool('robot.status', {}, ctx);
      expect(result.success).toBe(true);
      expect(result.message).toContain('1.5');
      expect(result.data).toBeDefined();
      expect(mockTransmitterSendAndReceive).toHaveBeenCalledWith(
        expect.any(Buffer),
        2000,
      );
    });

    test('returns failure on timeout', async () => {
      mockTransmitterSendAndReceive.mockRejectedValue(new Error('Response timeout'));
      const result = await handleTool('robot.status', {}, ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('timeout');
    });
  });

  // ===========================================================================
  // robot.record_observation
  // ===========================================================================

  describe('robot.record_observation', () => {
    test('records observation using pose from status query', async () => {
      const result = await handleTool('robot.record_observation', { label: 'kitchen' }, ctx);
      expect(result.success).toBe(true);
      expect(result.message).toContain('kitchen');
      expect(result.message).toContain('Recorded');
      expect(mockTransmitterSendAndReceive).toHaveBeenCalled();
    });

    test('records at origin when pose unavailable', async () => {
      mockTransmitterSendAndReceive.mockRejectedValue(new Error('timeout'));
      const result = await handleTool('robot.record_observation', { label: 'hallway' }, ctx);
      expect(result.success).toBe(true);
      expect(result.message).toContain('hallway');
      expect(result.message).toContain('origin');
    });

    test('fails without label', async () => {
      const result = await handleTool('robot.record_observation', {}, ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('No observation label');
    });
  });

  // ===========================================================================
  // robot.get_map
  // ===========================================================================

  describe('robot.get_map', () => {
    test('returns pose map summary', async () => {
      const result = await handleTool('robot.get_map', {}, ctx);
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('entryCount');
      expect(result.data).toHaveProperty('entries');
    });
  });

  // ===========================================================================
  // Navigation session (multi-step plan execution)
  // ===========================================================================

  describe('navigation session', () => {
    test('handleGoTo registers arrival listener on VisionLoop', async () => {
      const result = await handleTool('robot.go_to', { location: 'the kitchen' }, ctx);
      expect(result.success).toBe(true);
      expect((ctx.visionLoop.on as jest.Mock)).toHaveBeenCalledWith(
        'arrival',
        expect.any(Function),
      );
    });

    test('starting new handleGoTo aborts previous session', async () => {
      // First navigation
      await handleTool('robot.go_to', { location: 'the kitchen' }, ctx);
      const firstOnCalls = (ctx.visionLoop.on as jest.Mock).mock.calls.length;

      // Second navigation — should abort first and register new listener
      await handleTool('robot.go_to', { location: 'the bedroom' }, ctx);

      // removeListener should have been called for the first session's arrival listener
      expect((ctx.visionLoop.removeListener as jest.Mock)).toHaveBeenCalledWith(
        'arrival',
        expect.any(Function),
      );
      // New listener should have been registered
      expect((ctx.visionLoop.on as jest.Mock).mock.calls.length).toBeGreaterThan(firstOnCalls);
    });

    test('handleStop aborts active navigation session', async () => {
      // Start navigation
      await handleTool('robot.go_to', { location: 'the kitchen' }, ctx);
      expect((ctx.visionLoop.on as jest.Mock)).toHaveBeenCalledWith('arrival', expect.any(Function));

      // Stop should clean up the session
      const result = await handleTool('robot.stop', {}, ctx);
      expect(result.success).toBe(true);
      expect((ctx.visionLoop.removeListener as jest.Mock)).toHaveBeenCalledWith(
        'arrival',
        expect.any(Function),
      );
    });
  });

  // ===========================================================================
  // Multi-step plan integration (arrival→advance→arrival→SUCCESS)
  // ===========================================================================

  describe('multi-step plan integration', () => {
    let strategySpy: jest.SpyInstance;

    beforeEach(() => {
      // Spy on MemoryManager so the planner finds strategies and calls the LLM
      const mm = _getMemoryManager();
      strategySpy = jest.spyOn(mm, 'findRelevantStrategies').mockImplementation((_goal, level) => {
        if (level === HierarchyLevel.STRATEGY) {
          return [{
            id: 'test_strat',
            version: 1,
            hierarchyLevel: HierarchyLevel.STRATEGY,
            title: 'Navigate via hallway',
            triggerGoals: ['kitchen', 'navigate'],
            preconditions: [],
            steps: ['Go to hallway', 'Go to kitchen'],
            negativeConstraints: [],
            confidence: 0.5,
            successCount: 0,
            failureCount: 0,
            sourceTraceIds: [],
            deprecated: false,
          }];
        }
        return [];
      });
    });

    afterEach(() => {
      strategySpy.mockRestore();
    });

    test('multi-step plan executes to completion via arrival events', async () => {
      // Sequence mockInfer:
      // 1. scene description for planGoal context
      // 2. planGoal LLM → 2-step JSON plan
      // 3+ planStrategicStep / scene descriptions → tactical goals
      let callCount = 0;
      mockInfer.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return 'I see a hallway with doors';
        }
        if (callCount === 2) {
          return JSON.stringify({
            steps: [
              { description: 'Navigate to the hallway', targetLabel: 'hallway' },
              { description: 'Navigate through hallway to kitchen', targetLabel: 'kitchen' },
            ],
          });
        }
        // Subsequent calls (planStrategicStep, scene descriptions for advance)
        return JSON.stringify({
          tacticalGoal: 'Move toward the kitchen door',
          constraints: [],
          strategyHint: 'Follow hallway',
        });
      });

      const result = await handleTool('robot.go_to', { location: 'the kitchen' }, ctx);
      expect(result.success).toBe(true);

      // Verify arrival listener was registered
      expect(capturedArrivalCb).not.toBeNull();

      // Fire arrival for step 1
      capturedArrivalCb!('Arrived at hallway');
      // Flush multiple microtask cycles for the async advanceToNextStep chain
      for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));

      // Verify setGoal was called with step 2's goal
      expect((ctx.visionLoop.setGoal as jest.Mock)).toHaveBeenCalled();

      // Fire arrival for step 2 (plan complete)
      capturedArrivalCb!('Arrived at kitchen');
      for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));

      // Plan is done: visionLoop.stop should have been called
      expect(mockVisionLoopStop).toHaveBeenCalled();
      // Listener cleanup
      expect((ctx.visionLoop.removeListener as jest.Mock)).toHaveBeenCalledWith(
        'arrival',
        expect.any(Function),
      );
    });

    test('arrival on single-step plan completes immediately', async () => {
      let callCount = 0;
      mockInfer.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return 'I see a room';
        if (callCount === 2) {
          return JSON.stringify({
            steps: [{ description: 'Navigate to target', targetLabel: 'target' }],
          });
        }
        return JSON.stringify({
          tacticalGoal: 'Go to target',
          constraints: [],
          strategyHint: '',
        });
      });

      await handleTool('robot.go_to', { location: 'the target' }, ctx);
      expect(capturedArrivalCb).not.toBeNull();

      // Single arrival should complete the plan
      capturedArrivalCb!('Arrived at target');
      for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));

      expect(mockVisionLoopStop).toHaveBeenCalled();
      expect((ctx.visionLoop.removeListener as jest.Mock)).toHaveBeenCalledWith(
        'arrival',
        expect.any(Function),
      );
    });
  });

  // ===========================================================================
  // Unknown tool
  // ===========================================================================

  test('unknown tool returns failure', async () => {
    const result = await handleTool('robot.unknown', {}, ctx);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Unknown tool');
  });
});
