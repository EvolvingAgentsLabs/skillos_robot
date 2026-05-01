import {
  EgocentricController,
  type EgocentricPerception,
  type EgoDecision,
  type FrameTarget,
} from '../../src/control/egocentric_controller';
import { Opcode, decodeFrame } from '../../src/control/bytecode_compiler';

// Helpers -------------------------------------------------------------------

function perception(target: FrameTarget | null, obstacles = []): EgocentricPerception {
  return { target, obstacles, timestamp: Date.now() };
}

function target(cx: number, cy: number, size: number, label = 'red cube'): FrameTarget {
  return { cx, cy, size, label };
}

function assertOpcode(d: EgoDecision, opcode: number): void {
  expect(d.frame.length).toBe(6);
  const decoded = decodeFrame(d.frame);
  expect(decoded).not.toBeNull();
  expect(decoded!.opcode).toBe(opcode);
}

// ---------------------------------------------------------------------------
// Search (no target)
// ---------------------------------------------------------------------------

describe('EgocentricController — search', () => {
  test('no target visible emits ROTATE_CW (search)', () => {
    const ctrl = new EgocentricController();
    const d = ctrl.decide(perception(null));
    expect(d.action).toBe('search');
    assertOpcode(d, Opcode.ROTATE_CW);
    expect(d.reason).toContain('not visible');
  });

  test('search speed matches config', () => {
    const ctrl = new EgocentricController({ searchSpeed: 60 });
    const d = ctrl.decide(perception(null));
    expect(d.bytecode.paramLeft).toBe(60);
    expect(d.bytecode.paramRight).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Arrival
// ---------------------------------------------------------------------------

describe('EgocentricController — arrival', () => {
  test('target large and at frame bottom emits STOP', () => {
    const ctrl = new EgocentricController();
    const d = ctrl.decide(perception(target(0.5, 0.85, 0.30)));
    expect(d.action).toBe('arrived');
    assertOpcode(d, Opcode.STOP);
  });

  test('target large but not at bottom does NOT arrive', () => {
    const ctrl = new EgocentricController();
    // size=0.3 but cy=0.4 (middle of frame)
    const d = ctrl.decide(perception(target(0.5, 0.4, 0.30)));
    expect(d.action).not.toBe('arrived');
  });

  test('target at bottom but small does NOT arrive', () => {
    const ctrl = new EgocentricController();
    // cy=0.9 but size=0.05 (tiny)
    const d = ctrl.decide(perception(target(0.5, 0.9, 0.05)));
    expect(d.action).not.toBe('arrived');
  });

  test('arrival uses configured thresholds', () => {
    const ctrl = new EgocentricController({ arrivalSizeThreshold: 0.10, arrivalCyThreshold: 0.7 });
    const d = ctrl.decide(perception(target(0.5, 0.75, 0.12)));
    expect(d.action).toBe('arrived');
  });
});

// ---------------------------------------------------------------------------
// Lateral alignment (turning)
// ---------------------------------------------------------------------------

describe('EgocentricController — turning', () => {
  test('target left of center emits ROTATE_CCW (turn left)', () => {
    const ctrl = new EgocentricController();
    // cx=0.2 — well left of center (0.5 - 0.17 = 0.33 threshold)
    const d = ctrl.decide(perception(target(0.2, 0.5, 0.05)));
    expect(d.action).toBe('turn_left');
    assertOpcode(d, Opcode.ROTATE_CCW);
    expect(d.targetCx).toBe(0.2);
  });

  test('target right of center emits ROTATE_CW (turn right)', () => {
    const ctrl = new EgocentricController();
    // cx=0.8 — well right of center
    const d = ctrl.decide(perception(target(0.8, 0.5, 0.05)));
    expect(d.action).toBe('turn_right');
    assertOpcode(d, Opcode.ROTATE_CW);
    expect(d.targetCx).toBe(0.8);
  });

  test('target slightly left but within deadzone does NOT turn', () => {
    const ctrl = new EgocentricController();
    // cx=0.4 — within deadzone (0.33–0.67)
    const d = ctrl.decide(perception(target(0.4, 0.5, 0.05)));
    expect(d.action).toBe('move_forward');
  });

  test('turn intensity increases with offset', () => {
    const ctrl = new EgocentricController({ turnSpeed: 100 });
    const d1 = ctrl.decide(perception(target(0.1, 0.5, 0.05))); // far left
    const d2 = ctrl.decide(perception(target(0.25, 0.5, 0.05))); // slightly left
    // d1 offset = 0.4, d2 offset = 0.25 → d1 should have higher intensity
    expect(d1.bytecode.paramLeft).toBeGreaterThan(d2.bytecode.paramLeft);
  });

  test('custom deadzone changes the threshold', () => {
    const ctrl = new EgocentricController({ centerDeadzone: 0.05 });
    // cx=0.4 — outside a narrow 0.05 deadzone (0.45-0.55 is center)
    const d = ctrl.decide(perception(target(0.4, 0.5, 0.05)));
    expect(d.action).toBe('turn_left');
  });
});

// ---------------------------------------------------------------------------
// Forward motion
// ---------------------------------------------------------------------------

describe('EgocentricController — forward', () => {
  test('target centered emits MOVE_FORWARD', () => {
    const ctrl = new EgocentricController();
    const d = ctrl.decide(perception(target(0.5, 0.5, 0.05)));
    expect(d.action).toBe('move_forward');
    assertOpcode(d, Opcode.MOVE_FORWARD);
  });

  test('uses cruise speed when target is far (small)', () => {
    const ctrl = new EgocentricController({ forwardSpeed: 200, approachSpeed: 100, approachSizeThreshold: 0.10 });
    const d = ctrl.decide(perception(target(0.5, 0.5, 0.03))); // small target = far
    expect(d.bytecode.paramLeft).toBe(200);
    expect(d.bytecode.paramRight).toBe(200);
  });

  test('uses approach speed when target is close (large)', () => {
    const ctrl = new EgocentricController({ forwardSpeed: 200, approachSpeed: 100, approachSizeThreshold: 0.10 });
    const d = ctrl.decide(perception(target(0.5, 0.5, 0.15))); // large target = close
    expect(d.bytecode.paramLeft).toBe(100);
    expect(d.bytecode.paramRight).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Frame encoding validity
// ---------------------------------------------------------------------------

describe('EgocentricController — frame integrity', () => {
  test('all decisions produce valid 6-byte frames', () => {
    const ctrl = new EgocentricController();
    const perceptions: EgocentricPerception[] = [
      perception(null),                             // search
      perception(target(0.5, 0.9, 0.30)),           // arrived
      perception(target(0.1, 0.5, 0.05)),           // turn_left
      perception(target(0.9, 0.5, 0.05)),           // turn_right
      perception(target(0.5, 0.5, 0.05)),           // forward
    ];

    for (const p of perceptions) {
      const d = ctrl.decide(p);
      expect(d.frame.length).toBe(6);
      expect(d.frame[0]).toBe(0xAA);
      expect(d.frame[5]).toBe(0xFF);
      const decoded = decodeFrame(d.frame);
      expect(decoded).not.toBeNull();
      expect(decoded!.opcode).toBe(d.bytecode.opcode);
      expect(decoded!.paramLeft).toBe(d.bytecode.paramLeft);
      expect(decoded!.paramRight).toBe(d.bytecode.paramRight);
    }
  });

  test('decision includes target metadata when target is visible', () => {
    const ctrl = new EgocentricController();
    const d = ctrl.decide(perception(target(0.3, 0.6, 0.12)));
    expect(d.targetCx).toBe(0.3);
    expect(d.targetCy).toBe(0.6);
    expect(d.targetSize).toBe(0.12);
  });

  test('decision omits target metadata when no target', () => {
    const ctrl = new EgocentricController();
    const d = ctrl.decide(perception(null));
    expect(d.targetCx).toBeUndefined();
    expect(d.targetCy).toBeUndefined();
    expect(d.targetSize).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('EgocentricController — config', () => {
  test('getConfig returns merged defaults + overrides', () => {
    const ctrl = new EgocentricController({ forwardSpeed: 220 });
    const cfg = ctrl.getConfig();
    expect(cfg.forwardSpeed).toBe(220);
    expect(cfg.centerDeadzone).toBe(0.17); // default
  });
});
