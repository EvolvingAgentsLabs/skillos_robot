import { handleTool, type ToolContext } from '../../src/1_openclaw_cortex/roclaw_tools';
import { BytecodeCompiler, Opcode, formatHex } from '../../src/2_qwen_cerebellum/bytecode_compiler';
import { UDPTransmitter } from '../../src/2_qwen_cerebellum/udp_transmitter';
import { VisionLoop } from '../../src/2_qwen_cerebellum/vision_loop';
import type { InferenceFunction } from '../../src/2_qwen_cerebellum/inference';

describe('RoClaw Tools', () => {
  let ctx: ToolContext;
  let mockInfer: jest.Mock;
  let mockTransmitterSend: jest.Mock;
  let mockTransmitterSendAndReceive: jest.Mock;
  let mockVisionLoopStart: jest.Mock;
  let mockVisionLoopStop: jest.Mock;

  beforeEach(() => {
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
    } as unknown as VisionLoop;

    ctx = {
      compiler,
      transmitter,
      visionLoop,
      infer: mockInfer as InferenceFunction,
    };
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

    test('returns failure on error', async () => {
      mockVisionLoopStart.mockRejectedValue(new Error('Camera offline'));
      const result = await handleTool('robot.explore', {}, ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Camera offline');
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

    test('fails without location', async () => {
      const result = await handleTool('robot.go_to', {}, ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('No location');
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
  // Unknown tool
  // ===========================================================================

  test('unknown tool returns failure', async () => {
    const result = await handleTool('robot.unknown', {}, ctx);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Unknown tool');
  });
});
