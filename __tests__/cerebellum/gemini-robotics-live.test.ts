/**
 * Gemini Robotics-ER Live Integration Tests
 *
 * Tests the actual Gemini API with real inference calls.
 * Requires GOOGLE_API_KEY environment variable.
 *
 * Run:
 *   GOOGLE_API_KEY=... npm test -- --testPathPattern=gemini-robotics-live
 */

import {
  GeminiRoboticsInference,
  ROCLAW_TOOL_DECLARATIONS,
  createGeminiInference,
} from '../../src/2_qwen_cerebellum/gemini_robotics';
import {
  BytecodeCompiler,
  Opcode,
  decodeFrame,
  formatHex,
  FRAME_START,
  FRAME_END,
  FRAME_SIZE,
} from '../../src/2_qwen_cerebellum/bytecode_compiler';

// =============================================================================
// Skip if no API key
// =============================================================================

const API_KEY = process.env.GOOGLE_API_KEY || '';
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey('Gemini Robotics-ER — Live Integration', () => {
  jest.setTimeout(30000); // API calls can be slow

  // ===========================================================================
  // Text inference (no tools)
  // ===========================================================================

  describe('text inference', () => {
    test('returns a motor command from text prompt', async () => {
      const adapter = new GeminiRoboticsInference({
        apiKey: API_KEY,
        thinkingBudget: 0,
        useToolCalling: false,
      });

      const result = await adapter.infer(
        'You are a robot motor controller. Output ONLY a text command: FORWARD, BACKWARD, TURN_LEFT, TURN_RIGHT, ROTATE_CW, ROTATE_CCW, or STOP followed by two numbers 0-255. Example: FORWARD 100 100. No explanation.',
        'The path ahead is clear. Move forward at moderate speed.',
      );

      console.log('Text inference result:', result);

      // Should contain a recognizable motor command
      expect(result.length).toBeGreaterThan(0);
      // The model should output something parseable
      const compiler = new BytecodeCompiler('fewshot');
      const bytecode = compiler.compile(result);
      // May or may not compile depending on model output format
      // but the response should at least be non-empty text
      if (bytecode) {
        expect(bytecode.length).toBe(FRAME_SIZE);
        console.log('  Compiled to:', formatHex(bytecode));
      } else {
        console.log('  (not directly compilable, text output)');
      }
    });

    test('returns hex bytecode when prompted', async () => {
      const adapter = new GeminiRoboticsInference({
        apiKey: API_KEY,
        thinkingBudget: 0,
        useToolCalling: false,
      });

      const result = await adapter.infer(
        `You are a robot motor controller. Output ONLY 6 hex bytes separated by spaces.
Format: AA OO LL RR CC FF where OO=opcode, LL=left param, RR=right param, CC=XOR checksum of bytes 1-3.
Opcodes: 01=forward, 02=backward, 03=turn_left, 04=turn_right, 07=stop.
Example: AA 01 80 80 01 FF (forward at speed 128,128)`,
        'Move forward at moderate speed.',
      );

      console.log('Hex inference result:', result);

      const compiler = new BytecodeCompiler('fewshot');
      const bytecode = compiler.compile(result);
      if (bytecode) {
        expect(bytecode.length).toBe(FRAME_SIZE);
        expect(bytecode[0]).toBe(FRAME_START);
        expect(bytecode[5]).toBe(FRAME_END);
        console.log('  Compiled to:', formatHex(bytecode));

        const decoded = decodeFrame(bytecode);
        expect(decoded).not.toBeNull();
        console.log('  Decoded opcode:', decoded!.opcode, 'params:', decoded!.paramLeft, decoded!.paramRight);
      }
    });
  });

  // ===========================================================================
  // Tool calling (structured function calls)
  // ===========================================================================

  describe('tool calling', () => {
    test('returns structured function call for navigation', async () => {
      const adapter = new GeminiRoboticsInference({
        apiKey: API_KEY,
        thinkingBudget: 0,
        useToolCalling: true,
        tools: ROCLAW_TOOL_DECLARATIONS,
      });

      const result = await adapter.infer(
        'You are a robot motor controller. Use the available tools to control the robot. Choose the appropriate tool based on the situation.',
        'The path ahead is clear. Move forward at moderate speed.',
      );

      console.log('Tool call result:', result);

      // Should be a TOOLCALL: response
      expect(result.startsWith('TOOLCALL:')).toBe(true);

      const parsed = JSON.parse(result.slice('TOOLCALL:'.length));
      expect(parsed.name).toBeDefined();
      expect(parsed.args).toBeDefined();
      console.log('  Tool name:', parsed.name, 'args:', parsed.args);

      // Should be a recognized tool
      const validTools = ROCLAW_TOOL_DECLARATIONS.map(t => t.name);
      expect(validTools).toContain(parsed.name);
    });

    test('TOOLCALL response compiles to valid 6-byte bytecode', async () => {
      const adapter = new GeminiRoboticsInference({
        apiKey: API_KEY,
        thinkingBudget: 0,
        useToolCalling: true,
        tools: ROCLAW_TOOL_DECLARATIONS,
        maxRetries: 2,
      });

      const result = await adapter.infer(
        'You are a robot motor controller. Use the available tools to control the robot.',
        'Turn right to avoid the wall on the left.',
      );

      console.log('Tool call for compilation:', result);

      const compiler = new BytecodeCompiler('fewshot');
      const bytecode = compiler.compile(result);

      expect(bytecode).not.toBeNull();
      expect(bytecode!.length).toBe(FRAME_SIZE);
      expect(bytecode![0]).toBe(FRAME_START);
      expect(bytecode![5]).toBe(FRAME_END);

      const decoded = decodeFrame(bytecode!);
      expect(decoded).not.toBeNull();
      console.log('  Bytecode:', formatHex(bytecode!));
      console.log('  Opcode:', decoded!.opcode, 'paramL:', decoded!.paramLeft, 'paramR:', decoded!.paramRight);

      // Stats should show toolcall hit
      const stats = compiler.getStats();
      expect(stats.toolcallHits).toBe(1);
    });

    test('stop command via tool calling', async () => {
      const adapter = new GeminiRoboticsInference({
        apiKey: API_KEY,
        thinkingBudget: 0,
        useToolCalling: true,
        tools: ROCLAW_TOOL_DECLARATIONS,
      });

      const result = await adapter.infer(
        'You are a robot motor controller. Use the available tools to control the robot.',
        'You have arrived at the destination. Stop immediately.',
      );

      console.log('Stop command result:', result);

      expect(result.startsWith('TOOLCALL:')).toBe(true);
      const parsed = JSON.parse(result.slice('TOOLCALL:'.length));
      expect(parsed.name).toBe('stop');

      const compiler = new BytecodeCompiler('fewshot');
      const bytecode = compiler.compile(result);
      expect(bytecode).not.toBeNull();
      expect(bytecode![1]).toBe(Opcode.STOP);
      console.log('  Bytecode:', formatHex(bytecode!));
    });

    test('multiple sequential commands maintain stats', async () => {
      const adapter = new GeminiRoboticsInference({
        apiKey: API_KEY,
        thinkingBudget: 0,
        useToolCalling: true,
        tools: ROCLAW_TOOL_DECLARATIONS,
        maxRetries: 2,
      });

      const compiler = new BytecodeCompiler('fewshot');
      const scenarios = [
        'Move forward slowly.',
        'Turn left, there is a wall on the right.',
        'Stop, you are at the goal.',
      ];

      for (const scenario of scenarios) {
        const result = await adapter.infer(
          'You are a robot motor controller. Use the available tools to control the robot.',
          scenario,
        );

        console.log(`  "${scenario}" -> ${result}`);

        const bytecode = compiler.compile(result);
        expect(bytecode).not.toBeNull();
        expect(bytecode!.length).toBe(FRAME_SIZE);
      }

      const inferStats = adapter.getStats();
      expect(inferStats.totalCalls).toBe(3);
      expect(inferStats.successfulCalls).toBe(3);
      expect(inferStats.failedCalls).toBe(0);
      expect(inferStats.averageLatencyMs).toBeGreaterThan(0);
      console.log('  Inference stats:', inferStats);

      const compilerStats = compiler.getStats();
      expect(compilerStats.framesCompiled).toBe(3);
      expect(compilerStats.toolcallHits).toBe(3);
      console.log('  Compiler stats:', compilerStats);
    });
  });

  // ===========================================================================
  // Full pipeline: Gemini → TOOLCALL → Bytecode Compiler → 6-byte frame
  // ===========================================================================

  describe('full pipeline', () => {
    test('Gemini Robotics → tool call → bytecode → valid frame (end-to-end)', async () => {
      const adapter = new GeminiRoboticsInference({
        apiKey: API_KEY,
        thinkingBudget: 0,
        useToolCalling: true,
        tools: ROCLAW_TOOL_DECLARATIONS,
        maxRetries: 2,
      });
      const compiler = new BytecodeCompiler('fewshot');

      // Simulate a vision loop iteration
      const vlmOutput = await adapter.infer(
        `You are a robot motor controller navigating a room.
Use the available tools to issue motor commands.
Goal: navigate to the red cube.`,
        'Camera sees: A room with a red cube visible to the right side. Clear path ahead. Walls on left.',
      );

      console.log('VLM output:', vlmOutput);

      // Compile to bytecode
      const bytecode = compiler.compile(vlmOutput);
      expect(bytecode).not.toBeNull();
      expect(bytecode!.length).toBe(FRAME_SIZE);

      // Verify frame integrity
      const decoded = decodeFrame(bytecode!);
      expect(decoded).not.toBeNull();
      expect(decoded!.opcode).toBeGreaterThan(0);
      expect(decoded!.opcode).toBeLessThan(0xFF);

      console.log('  Frame:', formatHex(bytecode!));
      console.log('  Opcode:', decoded!.opcode, 'L:', decoded!.paramLeft, 'R:', decoded!.paramRight);

      // The model should choose turn_right or move_forward given the scenario
      // (red cube is to the right)
      const reasonableOpcodes = [
        Opcode.TURN_RIGHT,
        Opcode.MOVE_FORWARD,
        Opcode.ROTATE_CW,
      ];
      expect(reasonableOpcodes).toContain(decoded!.opcode);
    });
  });

  // ===========================================================================
  // Thinking budget
  // ===========================================================================

  describe('thinking budget', () => {
    test('thinkingBudget>0 produces deeper analysis', async () => {
      const adapter = new GeminiRoboticsInference({
        apiKey: API_KEY,
        thinkingBudget: 512,
        useToolCalling: false,
        maxOutputTokens: 512,
      });

      const result = await adapter.infer(
        'You are a robot spatial reasoning system. Analyze the scene and describe navigation options.',
        'Camera sees: A T-junction in a hallway. Left path leads to a bright room. Right path leads to a dark corridor. Straight ahead is a wall.',
      );

      console.log('Deep analysis result:', result.slice(0, 200));

      // With thinking budget, should produce a more detailed response
      expect(result.length).toBeGreaterThan(20);
    });
  });

  // ===========================================================================
  // Factory function
  // ===========================================================================

  describe('createGeminiInference factory', () => {
    test('factory creates working InferenceFunction', async () => {
      const infer = createGeminiInference({
        apiKey: API_KEY,
        thinkingBudget: 0,
        useToolCalling: false,
      });

      const result = await infer(
        'Respond with exactly one word.',
        'Are you a robot?',
      );

      console.log('Factory result:', result);
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
