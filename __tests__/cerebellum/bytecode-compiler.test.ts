import {
  BytecodeCompiler,
  Opcode,
  OPCODE_NAMES,
  FRAME_START,
  FRAME_END,
  FRAME_SIZE,
  calculateChecksum,
  encodeFrame,
  decodeFrame,
  formatHex,
} from '../../src/2_qwen_cerebellum/bytecode_compiler';

describe('BytecodeCompiler', () => {
  let compiler: BytecodeCompiler;

  beforeEach(() => {
    compiler = new BytecodeCompiler('fewshot');
  });

  // ===========================================================================
  // Frame encoding / decoding
  // ===========================================================================

  describe('encodeFrame', () => {
    test('produces 6-byte buffer with correct markers', () => {
      const buf = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
      expect(buf.length).toBe(FRAME_SIZE);
      expect(buf[0]).toBe(FRAME_START);
      expect(buf[5]).toBe(FRAME_END);
    });

    test('STOP frame is AA 07 00 00 07 FF', () => {
      const buf = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
      expect(formatHex(buf)).toBe('AA 07 00 00 07 FF');
    });

    test('GET_STATUS frame is AA 08 00 00 08 FF', () => {
      const buf = encodeFrame({ opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 });
      expect(formatHex(buf)).toBe('AA 08 00 00 08 FF');
    });

    test('MOVE_FORWARD at speed 100/100', () => {
      const buf = encodeFrame({ opcode: Opcode.MOVE_FORWARD, paramLeft: 100, paramRight: 100 });
      expect(buf[0]).toBe(0xAA);
      expect(buf[1]).toBe(0x01);
      expect(buf[2]).toBe(100);
      expect(buf[3]).toBe(100);
      expect(buf[5]).toBe(0xFF);
      // Verify checksum
      expect(buf[4]).toBe(calculateChecksum(0x01, 100, 100));
    });
  });

  describe('decodeFrame', () => {
    test('decodes a valid frame', () => {
      const buf = encodeFrame({ opcode: Opcode.MOVE_FORWARD, paramLeft: 128, paramRight: 64 });
      const frame = decodeFrame(buf);
      expect(frame).not.toBeNull();
      expect(frame!.opcode).toBe(Opcode.MOVE_FORWARD);
      expect(frame!.paramLeft).toBe(128);
      expect(frame!.paramRight).toBe(64);
    });

    test('returns null for wrong start marker', () => {
      const buf = Buffer.from([0xBB, 0x01, 0x64, 0x64, 0x01, 0xFF]);
      expect(decodeFrame(buf)).toBeNull();
    });

    test('returns null for wrong end marker', () => {
      const buf = Buffer.from([0xAA, 0x01, 0x64, 0x64, 0x01, 0xFE]);
      expect(decodeFrame(buf)).toBeNull();
    });

    test('returns null for bad checksum', () => {
      const buf = Buffer.from([0xAA, 0x01, 0x64, 0x64, 0x00, 0xFF]);
      expect(decodeFrame(buf)).toBeNull();
    });

    test('returns null for too-short buffer', () => {
      expect(decodeFrame(Buffer.from([0xAA, 0x01]))).toBeNull();
    });

    test('round-trip: decode(encode(frame)) === frame', () => {
      const original = { opcode: Opcode.ROTATE_CW, paramLeft: 90, paramRight: 128 };
      const decoded = decodeFrame(encodeFrame(original));
      expect(decoded).toEqual(original);
    });
  });

  // ===========================================================================
  // Checksum
  // ===========================================================================

  describe('calculateChecksum', () => {
    test('XOR of bytes 1-3', () => {
      expect(calculateChecksum(0x07, 0x00, 0x00)).toBe(0x07);
      expect(calculateChecksum(0x08, 0x00, 0x00)).toBe(0x08);
    });

    test('same params cancel out in XOR', () => {
      // 0x01 ^ 0x64 ^ 0x64 = 0x01 ^ 0x00 = 0x01
      expect(calculateChecksum(0x01, 0x64, 0x64)).toBe(0x01);
    });

    test('various opcodes', () => {
      // STOP: 0x07 ^ 0x00 ^ 0x00 = 0x07
      expect(calculateChecksum(0x07, 0x00, 0x00)).toBe(0x07);

      // RESET: 0xFE ^ 0x00 ^ 0x00 = 0xFE
      expect(calculateChecksum(0xFE, 0x00, 0x00)).toBe(0xFE);
    });
  });

  // ===========================================================================
  // All 13 opcodes
  // ===========================================================================

  describe('all opcodes produce valid frames', () => {
    const opcodeEntries = Object.entries(Opcode) as Array<[string, number]>;

    test.each(opcodeEntries)('opcode %s (0x%s)', (name, value) => {
      const buf = encodeFrame({ opcode: value, paramLeft: 42, paramRight: 84 });
      expect(buf.length).toBe(FRAME_SIZE);
      expect(buf[0]).toBe(FRAME_START);
      expect(buf[1]).toBe(value);
      expect(buf[5]).toBe(FRAME_END);
      // Should decode back
      const decoded = decodeFrame(buf);
      expect(decoded).not.toBeNull();
      expect(decoded!.opcode).toBe(value);
    });

    test('13 opcodes defined', () => {
      expect(opcodeEntries.length).toBe(13);
    });
  });

  // ===========================================================================
  // Compilation from VLM output
  // ===========================================================================

  describe('compile', () => {
    test('compiles clean hex output (grammar mode)', () => {
      const result = compiler.compile('AA 07 00 00 07 FF');
      expect(result).not.toBeNull();
      expect(formatHex(result!)).toBe('AA 07 00 00 07 FF');
    });

    test('extracts hex from noisy output (fewshot mode)', () => {
      const result = compiler.compile('Based on what I see, the command is: AA 01 80 80 01 FF');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.MOVE_FORWARD);
    });

    test('compiles text command (host fallback)', () => {
      const result = compiler.compile('STOP');
      expect(result).not.toBeNull();
      expect(formatHex(result!)).toBe('AA 07 00 00 07 FF');
    });

    test('compiles FORWARD text command', () => {
      const result = compiler.compile('FORWARD 100 100');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.MOVE_FORWARD);
      expect(result![2]).toBe(100);
      expect(result![3]).toBe(100);
    });

    test('compiles BACKWARD text command', () => {
      const result = compiler.compile('BACKWARD 80 80');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.MOVE_BACKWARD);
    });

    test('compiles TURN_LEFT text command', () => {
      const result = compiler.compile('TURN_LEFT 60 100');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.TURN_LEFT);
    });

    test('compiles TURN_RIGHT text command', () => {
      const result = compiler.compile('TURN_RIGHT 100 60');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.TURN_RIGHT);
    });

    test('compiles ROTATE_CW text command', () => {
      const result = compiler.compile('ROTATE_CW 90 128');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.ROTATE_CW);
      expect(result![2]).toBe(90);
      expect(result![3]).toBe(128);
    });

    test('compiles STATUS text command', () => {
      const result = compiler.compile('STATUS');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.GET_STATUS);
    });

    test('returns null for garbage input', () => {
      expect(compiler.compile('I am not sure what to do')).toBeNull();
    });

    test('returns null for empty input', () => {
      expect(compiler.compile('')).toBeNull();
    });

    test('clamps text command params to 0-255', () => {
      const result = compiler.compile('FORWARD 300 -10');
      expect(result).not.toBeNull();
      expect(result![2]).toBe(255); // clamped from 300
      expect(result![3]).toBe(0);   // clamped from -10
    });

    test('repairs hex with bad checksum', () => {
      // Valid structure but wrong checksum — compiler auto-repairs
      const result = compiler.compile('AA 01 64 64 00 FF');
      expect(result).not.toBeNull();
      // Checksum should be corrected: 0x01 ^ 0x64 ^ 0x64 = 0x01
      expect(result![4]).toBe(0x01);
    });
  });

  // ===========================================================================
  // createFrame helper
  // ===========================================================================

  describe('createFrame', () => {
    test('creates STOP frame', () => {
      const buf = compiler.createFrame(Opcode.STOP);
      expect(formatHex(buf)).toBe('AA 07 00 00 07 FF');
    });

    test('creates MOVE_FORWARD frame with params', () => {
      const buf = compiler.createFrame(Opcode.MOVE_FORWARD, 128, 128);
      expect(buf[1]).toBe(0x01);
      expect(buf[2]).toBe(128);
      expect(buf[3]).toBe(128);
    });
  });

  // ===========================================================================
  // createStopFrame helper (holding torque toggle)
  // ===========================================================================

  describe('createStopFrame', () => {
    test('freewheel stop (default)', () => {
      const buf = compiler.createStopFrame();
      expect(formatHex(buf)).toBe('AA 07 00 00 07 FF');
    });

    test('freewheel stop (explicit false)', () => {
      const buf = compiler.createStopFrame(false);
      expect(formatHex(buf)).toBe('AA 07 00 00 07 FF');
    });

    test('hold torque stop', () => {
      const buf = compiler.createStopFrame(true);
      expect(buf[1]).toBe(Opcode.STOP);
      expect(buf[2]).toBe(1); // PARAM_L = 1 (hold)
      expect(buf[3]).toBe(0);
      // Checksum: 0x07 ^ 0x01 ^ 0x00 = 0x06
      expect(buf[4]).toBe(0x06);
    });
  });

  // ===========================================================================
  // Permissive text command parsing
  // ===========================================================================

  describe('permissive text commands', () => {
    test('compiles FORWARD with trailing period', () => {
      const result = compiler.compile('FORWARD 100 100.');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.MOVE_FORWARD);
      expect(result![2]).toBe(100);
      expect(result![3]).toBe(100);
    });

    test('compiles FORWARD with commas instead of spaces', () => {
      const result = compiler.compile('FORWARD, 100, 100');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.MOVE_FORWARD);
      expect(result![2]).toBe(100);
      expect(result![3]).toBe(100);
    });

    test('compiles **STOP** with markdown bold', () => {
      const result = compiler.compile('**STOP**');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.STOP);
    });

    test('compiles STOP with trailing exclamation', () => {
      const result = compiler.compile('STOP!');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.STOP);
    });

    test('compiles BACKWARD with trailing semicolon', () => {
      const result = compiler.compile('BACKWARD 80 80;');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.MOVE_BACKWARD);
    });
  });

  // ===========================================================================
  // Tool call compilation (Gemini structured tool calling)
  // ===========================================================================

  describe('tool call compilation', () => {
    test('compiles TOOLCALL:move_forward', () => {
      const result = compiler.compile('TOOLCALL:{"name":"move_forward","args":{"speed_l":150,"speed_r":150}}');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.MOVE_FORWARD);
      expect(result![2]).toBe(150);
      expect(result![3]).toBe(150);
    });

    test('compiles TOOLCALL:move_backward', () => {
      const result = compiler.compile('TOOLCALL:{"name":"move_backward","args":{"speed_l":100,"speed_r":80}}');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.MOVE_BACKWARD);
      expect(result![2]).toBe(100);
      expect(result![3]).toBe(80);
    });

    test('compiles TOOLCALL:turn_left', () => {
      const result = compiler.compile('TOOLCALL:{"name":"turn_left","args":{"speed_l":60,"speed_r":120}}');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.TURN_LEFT);
      expect(result![2]).toBe(60);
      expect(result![3]).toBe(120);
    });

    test('compiles TOOLCALL:turn_right', () => {
      const result = compiler.compile('TOOLCALL:{"name":"turn_right","args":{"speed_l":120,"speed_r":60}}');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.TURN_RIGHT);
      expect(result![2]).toBe(120);
      expect(result![3]).toBe(60);
    });

    test('compiles TOOLCALL:rotate_cw with degrees/speed', () => {
      const result = compiler.compile('TOOLCALL:{"name":"rotate_cw","args":{"degrees":90,"speed":128}}');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.ROTATE_CW);
      expect(result![2]).toBe(90);  // degrees → paramLeft
      expect(result![3]).toBe(128); // speed → paramRight
    });

    test('compiles TOOLCALL:rotate_ccw', () => {
      const result = compiler.compile('TOOLCALL:{"name":"rotate_ccw","args":{"degrees":180,"speed":64}}');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.ROTATE_CCW);
      expect(result![2]).toBe(180);
      expect(result![3]).toBe(64);
    });

    test('compiles TOOLCALL:stop (no args)', () => {
      const result = compiler.compile('TOOLCALL:{"name":"stop","args":{}}');
      expect(result).not.toBeNull();
      expect(result![1]).toBe(Opcode.STOP);
      expect(result![2]).toBe(0);
      expect(result![3]).toBe(0);
    });

    test('returns null for unknown tool name', () => {
      const result = compiler.compile('TOOLCALL:{"name":"fly_away","args":{}}');
      expect(result).toBeNull();
    });

    test('returns null for malformed JSON after TOOLCALL:', () => {
      const result = compiler.compile('TOOLCALL:not-json');
      expect(result).toBeNull();
    });

    test('returns null for text that does not start with TOOLCALL:', () => {
      const result = compiler.compile('Some text TOOLCALL:{"name":"stop","args":{}}');
      // Should not match — TOOLCALL: must be at the start
      // This will fall through to other compilation modes
      expect(result).toBeNull();
    });

    test('clamps out-of-range values to 0-255', () => {
      const result = compiler.compile('TOOLCALL:{"name":"move_forward","args":{"speed_l":300,"speed_r":-10}}');
      expect(result).not.toBeNull();
      expect(result![2]).toBe(255); // clamped from 300
      expect(result![3]).toBe(0);   // clamped from -10
    });

    test('handles missing args gracefully', () => {
      const result = compiler.compile('TOOLCALL:{"name":"move_forward","args":{}}');
      expect(result).not.toBeNull();
      expect(result![2]).toBe(0);
      expect(result![3]).toBe(0);
    });

    test('scales normalized 0-1 float values to 0-255', () => {
      // Gemini Robotics-ER sometimes outputs normalized motor values
      const result = compiler.compile('TOOLCALL:{"name":"move_forward","args":{"speed_l":0.5,"speed_r":0.8}}');
      expect(result).not.toBeNull();
      expect(result![2]).toBe(128); // 0.5 * 255 = 127.5 → 128
      expect(result![3]).toBe(204); // 0.8 * 255 = 204
    });

    test('does not scale integer values even if they are small', () => {
      // Values like 50, 100 are clearly byte-range integers, not 0-1 normalized
      const result = compiler.compile('TOOLCALL:{"name":"move_forward","args":{"speed_l":50,"speed_r":100}}');
      expect(result).not.toBeNull();
      expect(result![2]).toBe(50);
      expect(result![3]).toBe(100);
    });

    test('tracks toolcallHits in stats', () => {
      compiler.compile('TOOLCALL:{"name":"stop","args":{}}');
      compiler.compile('TOOLCALL:{"name":"move_forward","args":{"speed_l":100,"speed_r":100}}');

      const stats = compiler.getStats();
      expect(stats.toolcallHits).toBe(2);
      expect(stats.framesCompiled).toBe(2);
    });

    test('toolcall has priority over hex and text modes', () => {
      // Even if text matches hex pattern after TOOLCALL:, toolcall wins
      compiler.compile('TOOLCALL:{"name":"stop","args":{}}');
      const stats = compiler.getStats();
      expect(stats.toolcallHits).toBe(1);
      expect(stats.grammarHits).toBe(0);
      expect(stats.fewshotHits).toBe(0);
      expect(stats.hostFallbacks).toBe(0);
    });
  });

  // ===========================================================================
  // formatHex
  // ===========================================================================

  describe('formatHex', () => {
    test('formats buffer as uppercase hex with spaces', () => {
      const buf = Buffer.from([0xaa, 0x01, 0x64, 0x64, 0x01, 0xff]);
      expect(formatHex(buf)).toBe('AA 01 64 64 01 FF');
    });

    test('pads single-digit hex values', () => {
      const buf = Buffer.from([0x00, 0x0a]);
      expect(formatHex(buf)).toBe('00 0A');
    });
  });

  // ===========================================================================
  // Stats
  // ===========================================================================

  describe('stats', () => {
    test('tracks compilation stats', () => {
      compiler.compile('AA 07 00 00 07 FF');  // grammar
      compiler.compile('The command is AA 07 00 00 07 FF done');  // fewshot
      compiler.compile('STOP');  // host fallback
      compiler.compile('garbage');  // failure

      const stats = compiler.getStats();
      expect(stats.framesCompiled).toBe(3);
      expect(stats.grammarHits).toBe(1);
      expect(stats.fewshotHits).toBe(1);
      expect(stats.hostFallbacks).toBe(1);
      expect(stats.failures).toBe(1);
    });
  });

  // ===========================================================================
  // System prompt
  // ===========================================================================

  describe('getSystemPrompt', () => {
    test('includes the goal', () => {
      const prompt = compiler.getSystemPrompt('explore the room');
      expect(prompt).toContain('explore the room');
    });

    test('includes opcode reference', () => {
      const prompt = compiler.getSystemPrompt('test');
      expect(prompt).toContain('AA 01');
      expect(prompt).toContain('Move forward');
    });
  });
});
