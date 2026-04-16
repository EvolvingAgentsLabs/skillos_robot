import { VLMMotorPolicy, buildTelemetrySection } from '../../src/2_qwen_cerebellum/vlm_motor_policy';
import { BytecodeCompiler, Opcode, decodeFrame, FRAME_SIZE } from '../../src/2_qwen_cerebellum/bytecode_compiler';
import type { InferenceFunction } from '../../src/llmunix-core/interfaces';
import type { TelemetrySnapshot } from '../../src/2_qwen_cerebellum/perception_policy';

describe('VLMMotorPolicy', () => {
  let compiler: BytecodeCompiler;
  let mockInfer: jest.Mock;

  beforeEach(() => {
    compiler = new BytecodeCompiler('fewshot');
    mockInfer = jest.fn<Promise<string>, [string, string, string[] | undefined]>();
    mockInfer.mockResolvedValue('AA 07 00 00 07 FF');
  });

  // ===========================================================================
  // 1. processFrame calls infer with system prompt and user message
  // ===========================================================================

  test('processFrame calls infer with system prompt and user message', async () => {
    const policy = new VLMMotorPolicy(compiler, mockInfer as InferenceFunction);

    await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    expect(mockInfer).toHaveBeenCalledTimes(1);
    const [systemPrompt, userMessage, frames] = mockInfer.mock.calls[0];
    // System prompt should contain the goal
    expect(systemPrompt).toContain('navigate to the red cube');
    // System prompt should reference the robot motor controller context
    expect(systemPrompt).toContain('robot motor controller');
    // User message should be the single-frame prompt
    expect(userMessage).toBe('What do you see? Output the next motor command.');
    // Frames should be passed through
    expect(frames).toEqual(['base64frame']);
  });

  // ===========================================================================
  // 2. processFrame compiles VLM output to bytecode
  // ===========================================================================

  test('processFrame compiles VLM output to bytecode', async () => {
    mockInfer.mockResolvedValue('FORWARD 128 128');
    const policy = new VLMMotorPolicy(compiler, mockInfer as InferenceFunction);

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate forward',
      null,
      [],
    );

    expect(result.bytecode).not.toBeNull();
    expect(result.bytecode!.length).toBe(FRAME_SIZE);
    const decoded = decodeFrame(result.bytecode!);
    expect(decoded).not.toBeNull();
    expect(decoded!.opcode).toBe(Opcode.MOVE_FORWARD);
    expect(decoded!.paramLeft).toBe(128);
    expect(decoded!.paramRight).toBe(128);
  });

  // ===========================================================================
  // 3. Returns null bytecode when VLM output is garbage
  // ===========================================================================

  test('returns null bytecode when VLM output is garbage', async () => {
    mockInfer.mockResolvedValue('I cannot determine what to do, the image is too blurry.');
    const policy = new VLMMotorPolicy(compiler, mockInfer as InferenceFunction);

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    expect(result.bytecode).toBeNull();
    expect(result.vlmOutput).toContain('I cannot determine');
  });

  // ===========================================================================
  // 4. Passes constraints into system prompt
  // ===========================================================================

  test('passes constraints into system prompt', async () => {
    const policy = new VLMMotorPolicy(compiler, mockInfer as InferenceFunction);

    await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      ['Avoid walls within 15cm', 'Reduce speed near obstacles'],
    );

    expect(mockInfer).toHaveBeenCalledTimes(1);
    const [systemPrompt] = mockInfer.mock.calls[0];
    expect(systemPrompt).toContain('ACTIVE CONSTRAINTS (from learned strategies):');
    expect(systemPrompt).toContain('- Avoid walls within 15cm');
    expect(systemPrompt).toContain('- Reduce speed near obstacles');
  });

  // ===========================================================================
  // 5. Builds telemetry section when telemetry is provided
  // ===========================================================================

  test('builds telemetry section when telemetry is provided', async () => {
    // Use multi-frame input so the telemetry section is appended to the user message.
    // (Single-frame non-tool-calling mode uses a hardcoded user message without telemetry.)
    const policy = new VLMMotorPolicy(compiler, mockInfer as InferenceFunction);

    const telemetry: TelemetrySnapshot = {
      pose: { x: 1.5, y: 2.3, h: Math.PI / 4 }, // 45 degrees
      targetDist: 0.50, // 50cm
      targetBearing: 10, // 10 degrees left
    };

    await policy.processFrame(
      ['frame1', 'frame2'],
      'navigate to the red cube',
      telemetry,
      [],
    );

    expect(mockInfer).toHaveBeenCalledTimes(1);
    const [, userMessage] = mockInfer.mock.calls[0];
    expect(userMessage).toContain('SENSOR DATA');
    expect(userMessage).toContain('Robot position: x=1.500, y=2.300');
    expect(userMessage).toContain('Robot heading: 45deg');
    expect(userMessage).toContain('Target distance: 50cm');
    expect(userMessage).toContain('Target bearing:');
  });

  // ===========================================================================
  // 6. Multi-frame user message includes frame count
  // ===========================================================================

  test('multi-frame user message includes frame count', async () => {
    const policy = new VLMMotorPolicy(compiler, mockInfer as InferenceFunction);

    await policy.processFrame(
      ['frame1', 'frame2', 'frame3', 'frame4'],
      'navigate to the red cube',
      null,
      [],
    );

    expect(mockInfer).toHaveBeenCalledTimes(1);
    const [, userMessage, frames] = mockInfer.mock.calls[0];
    expect(userMessage).toContain('last 4 frames of movement');
    expect(userMessage).toContain('oldest');
    expect(userMessage).toContain('newest');
    expect(userMessage).toContain('6-byte motor command');
    expect(frames).toEqual(['frame1', 'frame2', 'frame3', 'frame4']);
  });

  // ===========================================================================
  // 7. Tool-calling prompt mode uses correct system prompt
  // ===========================================================================

  test('tool-calling prompt mode uses correct system prompt', async () => {
    const policy = new VLMMotorPolicy(compiler, mockInfer as InferenceFunction, {
      useToolCallingPrompt: true,
    });

    await policy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    expect(mockInfer).toHaveBeenCalledTimes(1);
    const [systemPrompt, userMessage] = mockInfer.mock.calls[0];
    // Tool-calling prompt should contain the tool-calling specific text
    expect(systemPrompt).toContain('AVAILABLE ACTIONS');
    expect(systemPrompt).toContain('move_forward');
    expect(systemPrompt).toContain('rotate_cw');
    expect(systemPrompt).toContain('stop()');
    // Single-frame user message for tool-calling mode
    expect(userMessage).toContain('Call the appropriate motor control function');
  });

  // ===========================================================================
  // 8. Returns vlmOutput in result
  // ===========================================================================

  test('returns vlmOutput in result', async () => {
    const rawOutput = 'AA 01 80 80 01 FF';
    mockInfer.mockResolvedValue(rawOutput);
    const policy = new VLMMotorPolicy(compiler, mockInfer as InferenceFunction);

    const result = await policy.processFrame(
      ['base64frame'],
      'navigate forward',
      null,
      [],
    );

    expect(result.vlmOutput).toBe(rawOutput);
  });
});

describe('buildTelemetrySection', () => {
  test('includes target bearing direction labels', () => {
    // AHEAD when bearing is within 10 degrees
    const aheadTelem: TelemetrySnapshot = {
      pose: { x: 0, y: 0, h: 0 },
      targetDist: 0.5,
      targetBearing: 5,
    };
    expect(buildTelemetrySection(aheadTelem)).toContain('AHEAD');

    // LEFT when bearing is positive (> 10)
    const leftTelem: TelemetrySnapshot = {
      pose: { x: 0, y: 0, h: 0 },
      targetDist: 0.5,
      targetBearing: 30,
    };
    expect(buildTelemetrySection(leftTelem)).toContain('LEFT');

    // RIGHT when bearing is negative
    const rightTelem: TelemetrySnapshot = {
      pose: { x: 0, y: 0, h: 0 },
      targetDist: 0.5,
      targetBearing: -30,
    };
    expect(buildTelemetrySection(rightTelem)).toContain('RIGHT');
  });

  test('emits stop call when distance is very close', () => {
    const closeTelem: TelemetrySnapshot = {
      pose: { x: 0, y: 0, h: 0 },
      targetDist: 0.10, // 10cm
      targetBearing: 3,
    };
    const section = buildTelemetrySection(closeTelem);
    expect(section).toContain('>>> CALL: stop()');
  });
});
