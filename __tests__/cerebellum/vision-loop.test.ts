import { VisionLoop } from '../../src/2_qwen_cerebellum/vision_loop';
import { BytecodeCompiler, Opcode, formatHex } from '../../src/2_qwen_cerebellum/bytecode_compiler';
import { UDPTransmitter } from '../../src/2_qwen_cerebellum/udp_transmitter';
import type { InferenceFunction } from '../../src/2_qwen_cerebellum/inference';

describe('VisionLoop', () => {
  let compiler: BytecodeCompiler;
  let transmitter: UDPTransmitter;
  let mockInfer: jest.Mock;
  let visionLoop: VisionLoop;

  beforeEach(() => {
    compiler = new BytecodeCompiler('fewshot');
    transmitter = new UDPTransmitter({ host: '127.0.0.1', port: 4210 });

    // Mock inference function
    mockInfer = jest.fn<Promise<string>, [string, string, string[] | undefined]>();
    mockInfer.mockResolvedValue('AA 07 00 00 07 FF');

    visionLoop = new VisionLoop(
      { cameraUrl: 'http://127.0.0.1:80/stream', targetFPS: 2 },
      compiler,
      transmitter,
      mockInfer as InferenceFunction,
    );
  });

  afterEach(() => {
    visionLoop.stop();
  });

  // ===========================================================================
  // Goal management
  // ===========================================================================

  test('default goal is set', () => {
    expect(visionLoop.getGoal()).toBe('explore and avoid obstacles');
  });

  test('setGoal updates the goal', () => {
    visionLoop.setGoal('navigate to the kitchen');
    expect(visionLoop.getGoal()).toBe('navigate to the kitchen');
  });

  // ===========================================================================
  // State
  // ===========================================================================

  test('isRunning is false initially', () => {
    expect(visionLoop.isRunning()).toBe(false);
  });

  test('stop sets isRunning to false', () => {
    visionLoop.stop();
    expect(visionLoop.isRunning()).toBe(false);
  });

  // ===========================================================================
  // Stats
  // ===========================================================================

  test('initial stats are zero', () => {
    const stats = visionLoop.getStats();
    expect(stats.framesReceived).toBe(0);
    expect(stats.framesProcessed).toBe(0);
    expect(stats.inferenceCount).toBe(0);
    expect(stats.bytecodesSent).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.connected).toBe(false);
  });

  // ===========================================================================
  // Single frame processing (no network required)
  // ===========================================================================

  test('processSingleFrame calls inference with image', async () => {
    // Mock transmitter as connected
    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockResolvedValue('AA 07 00 00 07 FF');

    const result = await visionLoop.processSingleFrame('base64imagedata');

    expect(mockInfer).toHaveBeenCalledTimes(1);
    expect(mockInfer).toHaveBeenCalledWith(
      expect.stringContaining('robot motor controller'),
      expect.any(String),
      ['base64imagedata'],
    );
  });

  test('processSingleFrame emits arrival event when STOP opcode compiled', async () => {
    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    // AA 07 00 00 07 FF decodes to STOP opcode
    mockInfer.mockResolvedValue('AA 07 00 00 07 FF');

    const arrivalHandler = jest.fn();
    visionLoop.on('arrival', arrivalHandler);

    await visionLoop.processSingleFrame('base64imagedata');

    expect(arrivalHandler).toHaveBeenCalledTimes(1);
    expect(arrivalHandler).toHaveBeenCalledWith(expect.stringContaining('AA 07'));
  });

  test('processSingleFrame does NOT emit arrival for FORWARD opcode', async () => {
    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockResolvedValue('FORWARD 128 128');

    const arrivalHandler = jest.fn();
    visionLoop.on('arrival', arrivalHandler);

    await visionLoop.processSingleFrame('base64imagedata');

    expect(arrivalHandler).not.toHaveBeenCalled();
  });

  test('processSingleFrame compiles and sends bytecode', async () => {
    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockResolvedValue('AA 07 00 00 07 FF');

    const result = await visionLoop.processSingleFrame('base64imagedata');

    expect(result).not.toBeNull();
    expect(result!.length).toBe(6);
    expect(result![0]).toBe(0xAA);
    expect(result![1]).toBe(Opcode.STOP);
    // 2 sends: STOP-before-inference + motor command
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test('processSingleFrame returns null on inference failure', async () => {
    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockRejectedValue(new Error('API error'));

    const result = await visionLoop.processSingleFrame('base64imagedata');
    expect(result).toBeNull();
  });

  test('processSingleFrame returns null on compile failure', async () => {
    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockResolvedValue('I have no idea what to do');

    const result = await visionLoop.processSingleFrame('base64imagedata');
    expect(result).toBeNull();
  });

  test('processSingleFrame with FORWARD command', async () => {
    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockResolvedValue('FORWARD 128 128');

    const result = await visionLoop.processSingleFrame('base64imagedata');
    expect(result).not.toBeNull();
    expect(result![1]).toBe(Opcode.MOVE_FORWARD);
    expect(result![2]).toBe(128);
  });

  // ===========================================================================
  // Frame history
  // ===========================================================================

  test('frame history is empty initially', () => {
    expect(visionLoop.getFrameHistory()).toEqual([]);
  });

  test('frame history is cleared on stop', () => {
    // Feed frames via handleFrame (private) by using the internal method
    // We'll use processSingleFrame with history to verify the getter works
    // Then stop should clear it
    // Instead, directly test via the public getter after simulating frames
    // through the MJPEG path isn't practical, so we test stop() clears state
    visionLoop.stop();
    expect(visionLoop.getFrameHistory()).toEqual([]);
  });

  test('processSingleFrame with explicit history sends multiple frames', async () => {
    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockResolvedValue('AA 07 00 00 07 FF');

    const history = ['frame1', 'frame2', 'frame3'];
    await visionLoop.processSingleFrame('frame3', history);

    expect(mockInfer).toHaveBeenCalledWith(
      expect.stringContaining('robot motor controller'),
      expect.stringContaining('last 3 frames of movement'),
      ['frame1', 'frame2', 'frame3'],
    );
  });

  test('processSingleFrame without history sends single frame', async () => {
    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockResolvedValue('AA 07 00 00 07 FF');

    await visionLoop.processSingleFrame('singleframe');

    expect(mockInfer).toHaveBeenCalledWith(
      expect.stringContaining('robot motor controller'),
      'What do you see? Output the next motor command.',
      ['singleframe'],
    );
  });

  // ===========================================================================
  // STOP-before-inference (Sense-Plan-Act synchronizer)
  // ===========================================================================

  test('processSingleFrame sends STOP frame BEFORE motor command', async () => {
    const sendCalls: Buffer[] = [];
    const mockSend = jest.fn().mockImplementation((frame: Buffer) => {
      sendCalls.push(Buffer.from(frame));
      return Promise.resolve();
    });
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockResolvedValue('FORWARD 128 128');

    await visionLoop.processSingleFrame('base64imagedata');

    // First send should be STOP (0x07), second should be FORWARD (0x01)
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
    expect(sendCalls[0][1]).toBe(Opcode.STOP);
    expect(sendCalls[1][1]).toBe(Opcode.MOVE_FORWARD);
  });

  test('first transmitter.send() call has opcode 0x07 even when VLM outputs STOP', async () => {
    const sendCalls: Buffer[] = [];
    const mockSend = jest.fn().mockImplementation((frame: Buffer) => {
      sendCalls.push(Buffer.from(frame));
      return Promise.resolve();
    });
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    // VLM outputs STOP — there should STILL be a pre-inference STOP first
    mockInfer.mockResolvedValue('AA 07 00 00 07 FF');

    await visionLoop.processSingleFrame('base64imagedata');

    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
    // Both are STOP opcode — but two separate send() calls
    expect(sendCalls[0][1]).toBe(Opcode.STOP);
    expect(sendCalls[1][1]).toBe(Opcode.STOP);
  });

  test('STOP settle time is configurable', async () => {
    // Create loop with 0ms settle
    const fastLoop = new VisionLoop(
      { cameraUrl: 'http://127.0.0.1:80/stream', targetFPS: 2, stopSettleMs: 0 },
      compiler,
      transmitter,
      mockInfer as InferenceFunction,
    );

    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockResolvedValue('AA 07 00 00 07 FF');

    const start = Date.now();
    await fastLoop.processSingleFrame('base64imagedata');
    const elapsed = Date.now() - start;

    // With 0ms settle, should complete very fast (no artificial delay)
    expect(elapsed).toBeLessThan(500);
    fastLoop.stop();
  });

  test('STOP-before-inference continues when transmitter.send fails', async () => {
    let callCount = 0;
    const mockSend = jest.fn().mockImplementation((frame: Buffer) => {
      callCount++;
      if (callCount === 1) {
        // First call (STOP-before-inference) fails
        return Promise.reject(new Error('send failed'));
      }
      return Promise.resolve();
    });
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockResolvedValue('FORWARD 128 128');

    // Should NOT throw — graceful degradation
    const result = await visionLoop.processSingleFrame('base64imagedata');
    expect(result).not.toBeNull();
    // Inference still ran and motor command was sent
    expect(mockInfer).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  // ===========================================================================
  // Stuck detection
  // ===========================================================================

  test('emits stuck event after N identical non-STOP opcodes', async () => {
    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    // FORWARD opcode: AA 01 80 00 80 FF => MOVE_FORWARD
    mockInfer.mockResolvedValue('FORWARD 128 128');

    const stuckHandler = jest.fn();
    visionLoop.on('stuck', stuckHandler);

    // Process 8 frames with identical FORWARD command (STUCK_WINDOW = 8)
    for (let i = 0; i < 8; i++) {
      await visionLoop.processSingleFrame('base64imagedata');
    }

    expect(stuckHandler).toHaveBeenCalledTimes(1);
    expect(stuckHandler).toHaveBeenCalledWith(expect.any(String));
  });

  test('does NOT emit stuck for repeated STOP opcodes', async () => {
    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockResolvedValue('AA 07 00 00 07 FF');

    const stuckHandler = jest.fn();
    visionLoop.on('stuck', stuckHandler);

    for (let i = 0; i < 10; i++) {
      await visionLoop.processSingleFrame('base64imagedata');
    }

    expect(stuckHandler).not.toHaveBeenCalled();
  });

  test('emits stepTimeout after elapsed time', async () => {
    const mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    mockInfer.mockResolvedValue('FORWARD 128 128');

    const timeoutHandler = jest.fn();
    visionLoop.on('stepTimeout', timeoutHandler);

    // Simulate step start time in the past (> 45s ago)
    (visionLoop as any).stepStartTime = Date.now() - 50000;

    await visionLoop.processSingleFrame('base64imagedata');

    expect(timeoutHandler).toHaveBeenCalledTimes(1);
    expect(timeoutHandler).toHaveBeenCalledWith(expect.any(Number));
  });

  test('resetStepTimer clears stuck state and resets timer', () => {
    // Populate some opcodes
    (visionLoop as any).recentOpcodes = [1, 1, 1, 1];
    (visionLoop as any).stepStartTime = Date.now() - 99999;

    visionLoop.resetStepTimer();

    expect((visionLoop as any).recentOpcodes).toEqual([]);
    expect((visionLoop as any).stepStartTime).toBeGreaterThan(Date.now() - 1000);
  });

  // ===========================================================================
  // Frame history
  // ===========================================================================

  test('frameHistorySize config limits buffer', () => {
    const smallHistoryLoop = new VisionLoop(
      { cameraUrl: 'http://127.0.0.1:80/stream', targetFPS: 2, frameHistorySize: 2 },
      compiler,
      transmitter,
      mockInfer as InferenceFunction,
    );

    // Feed frames through handleFrame by simulating JPEG data
    const makeJpeg = (id: number) => {
      const buf = Buffer.alloc(10);
      buf[0] = 0xFF;
      buf[1] = 0xD8; // JPEG magic
      buf[2] = id;
      return buf;
    };

    // Access private handleFrame via prototype
    const handleFrame = (smallHistoryLoop as any).handleFrame.bind(smallHistoryLoop);
    // Need to bypass rate limiting
    (smallHistoryLoop as any).lastFrameTime = 0;
    (smallHistoryLoop as any).minFrameIntervalMs = 0;

    handleFrame(makeJpeg(1));
    expect(smallHistoryLoop.getFrameHistory()).toHaveLength(1);

    (smallHistoryLoop as any).lastFrameTime = 0;
    handleFrame(makeJpeg(2));
    expect(smallHistoryLoop.getFrameHistory()).toHaveLength(2);

    (smallHistoryLoop as any).lastFrameTime = 0;
    handleFrame(makeJpeg(3));
    expect(smallHistoryLoop.getFrameHistory()).toHaveLength(2); // capped at 2

    smallHistoryLoop.stop();
    expect(smallHistoryLoop.getFrameHistory()).toHaveLength(0);
  });
});
