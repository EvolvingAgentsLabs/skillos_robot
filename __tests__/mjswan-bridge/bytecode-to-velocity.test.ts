/**
 * Tests for bytecodeToCtrl() — translates RoClaw bytecode frames into
 * MuJoCo velocity actuator controls [left_rad_s, right_rad_s].
 */

import { bytecodeToCtrl, speedParamToRadS, MAX_WHEEL_RAD_S } from '../../src/mjswan_bridge';
import {
  Opcode, encodeFrame, encodeFrameV2, decodeFrameAuto, ACK_FLAG,
  type BytecodeFrame,
} from '../../src/2_qwen_cerebellum/bytecode_compiler';

describe('MAX_WHEEL_RAD_S constant', () => {
  it('equals (1024/4096) * 2 * PI ~= 1.5708', () => {
    const expected = (1024 / 4096) * 2 * Math.PI;
    expect(MAX_WHEEL_RAD_S).toBeCloseTo(expected, 4);
    expect(MAX_WHEEL_RAD_S).toBeCloseTo(1.5708, 3);
  });
});

describe('speedParamToRadS', () => {
  it('maps 0 to 0', () => {
    expect(speedParamToRadS(0)).toBe(0);
  });

  it('maps 255 to MAX_WHEEL_RAD_S', () => {
    expect(speedParamToRadS(255)).toBeCloseTo(MAX_WHEEL_RAD_S, 6);
  });

  it('maps 128 to ~half of MAX_WHEEL_RAD_S', () => {
    expect(speedParamToRadS(128)).toBeCloseTo((128 / 255) * MAX_WHEEL_RAD_S, 6);
  });

  it('maps 1 to a small positive value', () => {
    const result = speedParamToRadS(1);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeCloseTo((1 / 255) * MAX_WHEEL_RAD_S, 6);
  });
});

describe('bytecodeToCtrl', () => {
  // Helper
  const frame = (opcode: number, paramLeft: number, paramRight: number): BytecodeFrame =>
    ({ opcode, paramLeft, paramRight });

  describe('MOVE_FORWARD (0x01)', () => {
    it('param=128 -> ~0.789 rad/s each wheel', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.MOVE_FORWARD, 128, 128));
      const expected = speedParamToRadS(128);
      expect(left).toBeCloseTo(expected, 6);
      expect(right).toBeCloseTo(expected, 6);
      expect(left).toBeCloseTo(0.789, 2);
    });

    it('param=255 -> MAX_WHEEL_RAD_S each wheel', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.MOVE_FORWARD, 255, 255));
      expect(left).toBeCloseTo(MAX_WHEEL_RAD_S, 4);
      expect(right).toBeCloseTo(MAX_WHEEL_RAD_S, 4);
    });

    it('param=0 -> 0 each wheel', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.MOVE_FORWARD, 0, 0));
      expect(left).toBe(0);
      expect(right).toBe(0);
    });

    it('differential params -> different wheel speeds', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.MOVE_FORWARD, 0x60, 0x80));
      expect(left).toBeCloseTo(speedParamToRadS(0x60), 6);
      expect(right).toBeCloseTo(speedParamToRadS(0x80), 6);
      expect(left).toBeLessThan(right);
    });
  });

  describe('MOVE_BACKWARD (0x02)', () => {
    it('param=128 -> ~-0.789 rad/s each wheel', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.MOVE_BACKWARD, 128, 128));
      const expected = -speedParamToRadS(128);
      expect(left).toBeCloseTo(expected, 6);
      expect(right).toBeCloseTo(expected, 6);
    });

    it('param=255 -> -MAX_WHEEL_RAD_S', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.MOVE_BACKWARD, 255, 255));
      expect(left).toBeCloseTo(-MAX_WHEEL_RAD_S, 4);
      expect(right).toBeCloseTo(-MAX_WHEEL_RAD_S, 4);
    });
  });

  describe('TURN_LEFT (0x03)', () => {
    it('uses differential params directly (same signs)', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.TURN_LEFT, 0x60, 0x80));
      expect(left).toBeCloseTo(speedParamToRadS(0x60), 6);
      expect(right).toBeCloseTo(speedParamToRadS(0x80), 6);
      // Both positive — VLM sets differential params
      expect(left).toBeGreaterThan(0);
      expect(right).toBeGreaterThan(0);
    });
  });

  describe('TURN_RIGHT (0x04)', () => {
    it('uses differential params directly (same signs)', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.TURN_RIGHT, 0x80, 0x60));
      expect(left).toBeCloseTo(speedParamToRadS(0x80), 6);
      expect(right).toBeCloseTo(speedParamToRadS(0x60), 6);
    });
  });

  describe('ROTATE_CW (0x05)', () => {
    it('opposite signs: +left, -right', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.ROTATE_CW, 128, 128));
      expect(left).toBeGreaterThan(0);
      expect(right).toBeLessThan(0);
      expect(left).toBeCloseTo(-right, 6);
    });

    it('uses paramRight for velocity (fallback to paramLeft)', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.ROTATE_CW, 100, 200));
      const expected = speedParamToRadS(200);
      expect(left).toBeCloseTo(expected, 6);
      expect(right).toBeCloseTo(-expected, 6);
    });

    it('falls back to paramLeft when paramRight is 0', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.ROTATE_CW, 128, 0));
      const expected = speedParamToRadS(128);
      expect(left).toBeCloseTo(expected, 6);
      expect(right).toBeCloseTo(-expected, 6);
    });
  });

  describe('ROTATE_CCW (0x06)', () => {
    it('opposite signs: -left, +right', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.ROTATE_CCW, 128, 128));
      expect(left).toBeLessThan(0);
      expect(right).toBeGreaterThan(0);
      expect(left).toBeCloseTo(-right, 6);
    });
  });

  describe('STOP (0x07)', () => {
    it('returns [0, 0]', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.STOP, 0, 0));
      expect(left).toBe(0);
      expect(right).toBe(0);
    });

    it('ignores params', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.STOP, 255, 255));
      expect(left).toBe(0);
      expect(right).toBe(0);
    });
  });

  describe('Unknown opcodes', () => {
    it('returns [0, 0] for unrecognized opcode', () => {
      const [left, right] = bytecodeToCtrl(frame(0x99, 128, 128));
      expect(left).toBe(0);
      expect(right).toBe(0);
    });
  });

  describe('Edge cases', () => {
    it('param=1 produces small but nonzero velocity', () => {
      const [left, right] = bytecodeToCtrl(frame(Opcode.MOVE_FORWARD, 1, 1));
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThan(0.01);
      expect(right).toBeGreaterThan(0);
    });
  });

  describe('V2 frame auto-detection for bridge', () => {
    it('decodeFrameAuto handles V1 frame for bytecodeToCtrl', () => {
      const v1 = encodeFrame({ opcode: Opcode.MOVE_FORWARD, paramLeft: 128, paramRight: 128 });
      const decoded = decodeFrameAuto(v1);
      expect(decoded).not.toBeNull();
      const [left, right] = bytecodeToCtrl(decoded!);
      expect(left).toBeCloseTo(speedParamToRadS(128), 6);
      expect(right).toBeCloseTo(speedParamToRadS(128), 6);
    });

    it('decodeFrameAuto handles V2 frame for bytecodeToCtrl', () => {
      const v2 = encodeFrameV2({
        opcode: Opcode.MOVE_FORWARD, paramLeft: 200, paramRight: 200,
        sequenceNumber: 42, flags: ACK_FLAG,
      });
      const decoded = decodeFrameAuto(v2);
      expect(decoded).not.toBeNull();
      const [left, right] = bytecodeToCtrl(decoded!);
      expect(left).toBeCloseTo(speedParamToRadS(200), 6);
      expect(right).toBeCloseTo(speedParamToRadS(200), 6);
    });
  });
});
