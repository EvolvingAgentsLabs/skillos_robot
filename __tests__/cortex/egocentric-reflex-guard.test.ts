import { EgocentricReflexGuard } from '../../src/control/egocentric_reflex_guard';
import { encodeFrame, Opcode, decodeFrame } from '../../src/control/bytecode_compiler';
import type { FrameObstacle } from '../../src/control/egocentric_controller';

// Helpers -------------------------------------------------------------------

function forwardFrame(speed = 150): Buffer {
  return encodeFrame({ opcode: Opcode.MOVE_FORWARD, paramLeft: speed, paramRight: speed });
}

function rotateFrame(): Buffer {
  return encodeFrame({ opcode: Opcode.ROTATE_CW, paramLeft: 80, paramRight: 80 });
}

function obstacle(cx: number, cy: number, size: number, label = 'wall'): FrameObstacle {
  return { cx, cy, size, label };
}

// ---------------------------------------------------------------------------
// Non-motion opcodes always pass
// ---------------------------------------------------------------------------

describe('EgocentricReflexGuard — non-motion opcodes', () => {
  test('ROTATE_CW always allowed', () => {
    const guard = new EgocentricReflexGuard();
    guard.updateObstacles([obstacle(0.5, 0.9, 0.5)]); // big obstacle in center
    const d = guard.decide(rotateFrame());
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('non_motion_opcode');
  });

  test('STOP always allowed', () => {
    const guard = new EgocentricReflexGuard();
    guard.updateObstacles([obstacle(0.5, 0.9, 0.5)]);
    const frame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
    const d = guard.decide(frame);
    expect(d.allow).toBe(true);
  });

  test('invalid frame is allowed (fails gracefully)', () => {
    const guard = new EgocentricReflexGuard();
    const d = guard.decide(Buffer.from([0x00, 0x00, 0x00]));
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('frame_invalid');
  });
});

// ---------------------------------------------------------------------------
// Forward motion veto logic
// ---------------------------------------------------------------------------

describe('EgocentricReflexGuard — forward motion', () => {
  test('no obstacles → allow forward', () => {
    const guard = new EgocentricReflexGuard();
    guard.updateObstacles([]);
    const d = guard.decide(forwardFrame());
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('clear_path');
  });

  test('small obstacle → allow forward', () => {
    const guard = new EgocentricReflexGuard();
    // size=0.1, below default threshold of 0.3
    guard.updateObstacles([obstacle(0.5, 0.8, 0.1)]);
    const d = guard.decide(forwardFrame());
    expect(d.allow).toBe(true);
  });

  test('large obstacle off-center → allow forward', () => {
    const guard = new EgocentricReflexGuard();
    // cx=0.9, outside ±0.2 of center
    guard.updateObstacles([obstacle(0.9, 0.8, 0.4)]);
    const d = guard.decide(forwardFrame());
    expect(d.allow).toBe(true);
  });

  test('large obstacle high in frame (far away) → allow forward', () => {
    const guard = new EgocentricReflexGuard();
    // cy=0.3, below minProximityCy threshold of 0.6
    guard.updateObstacles([obstacle(0.5, 0.3, 0.4)]);
    const d = guard.decide(forwardFrame());
    expect(d.allow).toBe(true);
  });

  test('large + centered + close obstacle → VETO', () => {
    const guard = new EgocentricReflexGuard();
    // size=0.4, cx=0.5, cy=0.8 — all thresholds exceeded
    guard.updateObstacles([obstacle(0.5, 0.8, 0.4, 'wooden wall')]);
    const d = guard.decide(forwardFrame());
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('collision_predicted_veto');
    expect(d.obstacleLabel).toBe('wooden wall');
    expect(d.obstacleSize).toBe(0.4);
  });

  test('veto provides STOP replacement frame', () => {
    const guard = new EgocentricReflexGuard();
    guard.updateObstacles([obstacle(0.5, 0.7, 0.35)]);
    const d = guard.decide(forwardFrame());
    expect(d.allow).toBe(false);
    expect(d.replacement).toBeDefined();
    const decoded = decodeFrame(d.replacement!);
    expect(decoded).not.toBeNull();
    expect(decoded!.opcode).toBe(Opcode.STOP);
  });

  test('multiple obstacles — first blocking one triggers veto', () => {
    const guard = new EgocentricReflexGuard();
    guard.updateObstacles([
      obstacle(0.1, 0.9, 0.3, 'side wall'),   // off-center, won't block
      obstacle(0.5, 0.75, 0.35, 'box'),        // centered + large + close → blocks
    ]);
    const d = guard.decide(forwardFrame());
    expect(d.allow).toBe(false);
    expect(d.obstacleLabel).toBe('box');
  });
});

// ---------------------------------------------------------------------------
// Custom config
// ---------------------------------------------------------------------------

describe('EgocentricReflexGuard — custom config', () => {
  test('lower minBlockingSize catches smaller obstacles', () => {
    const guard = new EgocentricReflexGuard({ minBlockingSize: 0.15 });
    guard.updateObstacles([obstacle(0.5, 0.7, 0.18)]);
    const d = guard.decide(forwardFrame());
    expect(d.allow).toBe(false);
  });

  test('wider maxCenterOffset catches off-center obstacles', () => {
    const guard = new EgocentricReflexGuard({ maxCenterOffset: 0.4 });
    // cx=0.8 — within ±0.4 of center (0.1–0.9)
    guard.updateObstacles([obstacle(0.8, 0.7, 0.35)]);
    const d = guard.decide(forwardFrame());
    expect(d.allow).toBe(false);
  });

  test('obstacle update replaces previous obstacles', () => {
    const guard = new EgocentricReflexGuard();
    guard.updateObstacles([obstacle(0.5, 0.8, 0.4)]); // blocking
    guard.updateObstacles([]); // cleared
    const d = guard.decide(forwardFrame());
    expect(d.allow).toBe(true);
  });
});
