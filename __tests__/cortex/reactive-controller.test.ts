import {
  ReactiveController,
  type ControllerDecision,
} from '../../src/control/reactive_controller';
import { SceneGraph } from '../../src/brain/memory/scene_graph';
import { Opcode, decodeFrame } from '../../src/control/bytecode_compiler';

// Helpers -------------------------------------------------------------------

function sceneWithTarget(
  robotX: number, robotY: number, robotHeadingDeg: number,
  targetX: number, targetY: number,
): SceneGraph {
  const g = new SceneGraph();
  g.updateRobotPose(robotX, robotY, robotHeadingDeg);
  g.addOrUpdateNode({
    id: 'target',
    label: 'target',
    x: targetX,
    y: targetY,
    boundingBox: { w: 5, h: 5, d: 5 },
  });
  return g;
}

function assertFrame(d: ControllerDecision, opcode: number): void {
  expect(d.frame.length).toBe(6);
  const decoded = decodeFrame(d.frame);
  expect(decoded).not.toBeNull();
  expect(decoded!.opcode).toBe(opcode);
}

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

describe('ReactiveController — basics', () => {
  test('no_target: unknown node id emits STOP', () => {
    const g = new SceneGraph();
    const ctrl = new ReactiveController();
    const d = ctrl.decide(g, { kind: 'node', id: 'nonexistent' });
    expect(d.action).toBe('no_target');
    assertFrame(d, Opcode.STOP);
  });

  test('literal point target is accepted even with no matching node', () => {
    const g = new SceneGraph();
    g.updateRobotPose(0, 0, 0);
    const ctrl = new ReactiveController();
    const d = ctrl.decide(g, { kind: 'point', x: 100, y: 0 });
    expect(d.action).toBe('move_forward');
    assertFrame(d, Opcode.MOVE_FORWARD);
  });

  test('exposed config merges defaults with overrides', () => {
    const c = new ReactiveController({ turnThresholdDeg: 5, cruiseSpeed: 250 });
    const cfg = c.getConfig();
    expect(cfg.turnThresholdDeg).toBe(5);
    expect(cfg.cruiseSpeed).toBe(250);
    expect(cfg.arrivalThresholdCm).toBe(8); // default preserved
  });
});

// ---------------------------------------------------------------------------
// Arrival
// ---------------------------------------------------------------------------

describe('ReactiveController — arrival', () => {
  test('within arrivalThreshold → STOP with action=arrived', () => {
    const g = sceneWithTarget(0, 0, 0, 5, 0); // 5cm away, threshold default 8
    const d = new ReactiveController().decide(g, { kind: 'node', id: 'target' });
    expect(d.action).toBe('arrived');
    expect(d.distanceCm).toBeCloseTo(5, 3);
    assertFrame(d, Opcode.STOP);
  });

  test('just outside arrivalThreshold does NOT stop', () => {
    const g = sceneWithTarget(0, 0, 0, 10, 0); // 10cm away
    const d = new ReactiveController().decide(g, { kind: 'node', id: 'target' });
    expect(d.action).not.toBe('arrived');
  });

  test('custom arrivalThreshold is respected', () => {
    const g = sceneWithTarget(0, 0, 0, 20, 0);
    const d = new ReactiveController({ arrivalThresholdCm: 30 }).decide(
      g, { kind: 'node', id: 'target' },
    );
    expect(d.action).toBe('arrived');
  });
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe('ReactiveController — rotation', () => {
  test('target exactly ahead (bearing ~0) → move_forward, not rotate', () => {
    const g = sceneWithTarget(0, 0, 0, 100, 0);
    const d = new ReactiveController().decide(g, { kind: 'node', id: 'target' });
    expect(d.action).toBe('move_forward');
    expect(Math.abs(d.bearingDeg)).toBeLessThan(1);
  });

  test('positive bearing → rotate_ccw (RH convention)', () => {
    // Robot facing 0° (+X), target at (0, 100) → desired heading +90° → bearing +90°
    const g = sceneWithTarget(0, 0, 0, 0, 100);
    const d = new ReactiveController().decide(g, { kind: 'node', id: 'target' });
    expect(d.action).toBe('rotate_ccw');
    expect(d.bearingDeg).toBeCloseTo(90, 1);
    assertFrame(d, Opcode.ROTATE_CCW);
  });

  test('negative bearing → rotate_cw', () => {
    // Target at (0, -100) → desired heading -90° → bearing -90°
    const g = sceneWithTarget(0, 0, 0, 0, -100);
    const d = new ReactiveController().decide(g, { kind: 'node', id: 'target' });
    expect(d.action).toBe('rotate_cw');
    expect(d.bearingDeg).toBeCloseTo(-90, 1);
    assertFrame(d, Opcode.ROTATE_CW);
  });

  test('bearing just above threshold rotates; just below moves forward', () => {
    const c = new ReactiveController({ turnThresholdDeg: 15 });
    // Target bearing ≈ +20° (above threshold) — target at (100, ~36.4)
    const g1 = sceneWithTarget(0, 0, 0, 100, 100 * Math.tan(20 * Math.PI / 180));
    expect(c.decide(g1, { kind: 'node', id: 'target' }).action).toBe('rotate_ccw');
    // Target bearing ≈ +10° (below threshold)
    const g2 = sceneWithTarget(0, 0, 0, 100, 100 * Math.tan(10 * Math.PI / 180));
    expect(c.decide(g2, { kind: 'node', id: 'target' }).action).toBe('move_forward');
  });

  test('invertRotation swaps CW/CCW emission', () => {
    // Same scenario as "positive bearing → rotate_ccw" but inverted.
    const g = sceneWithTarget(0, 0, 0, 0, 100);
    const d = new ReactiveController({ invertRotation: true }).decide(
      g, { kind: 'node', id: 'target' },
    );
    expect(d.action).toBe('rotate_cw');
    assertFrame(d, Opcode.ROTATE_CW);
  });

  test('rotate frame encodes (degrees, speed) in paramLeft, paramRight', () => {
    const g = sceneWithTarget(0, 0, 0, 0, 100); // bearing +90°
    const c = new ReactiveController({ rotationSpeed: 85 });
    const d = c.decide(g, { kind: 'node', id: 'target' });
    const decoded = decodeFrame(d.frame)!;
    expect(decoded.paramLeft).toBe(90);  // degrees
    expect(decoded.paramRight).toBe(85); // speed
  });

  test('degrees param is clamped to [1, 180]', () => {
    // Target exactly behind → bearing +180° (or -180°)
    const g = sceneWithTarget(0, 0, 0, -100, 0);
    const d = new ReactiveController().decide(g, { kind: 'node', id: 'target' });
    const decoded = decodeFrame(d.frame)!;
    expect(decoded.paramLeft).toBeLessThanOrEqual(180);
    expect(decoded.paramLeft).toBeGreaterThanOrEqual(1);
  });

  test('angular wrap-around across ±180° chooses the short rotation', () => {
    // Robot heading 170°, target at bearing that requires going through 180°.
    // Target at world heading -170° → world desired -170°.
    // bearing = -170 - 170 = -340 → wraps to +20.
    const targetAngle = -170 * Math.PI / 180;
    const g = sceneWithTarget(0, 0, 170, 100 * Math.cos(targetAngle), 100 * Math.sin(targetAngle));
    const d = new ReactiveController().decide(g, { kind: 'node', id: 'target' });
    // Short rotation is ~+20° CCW, not ~-340° CW.
    expect(d.action).toBe('rotate_ccw');
    expect(Math.abs(d.bearingDeg)).toBeLessThan(30);
  });
});

// ---------------------------------------------------------------------------
// Forward motion / speed shaping
// ---------------------------------------------------------------------------

describe('ReactiveController — forward motion', () => {
  test('far target → cruiseSpeed', () => {
    const g = sceneWithTarget(0, 0, 0, 200, 0);
    const c = new ReactiveController({ cruiseSpeed: 200, approachDistanceCm: 30 });
    const d = c.decide(g, { kind: 'node', id: 'target' });
    expect(d.action).toBe('move_forward');
    const decoded = decodeFrame(d.frame)!;
    expect(decoded.paramLeft).toBe(200);
    expect(decoded.paramRight).toBe(200);
  });

  test('close target (within approachDistance) → approachSpeed', () => {
    const g = sceneWithTarget(0, 0, 0, 20, 0); // 20cm, below default 30cm threshold
    const c = new ReactiveController({ approachSpeed: 100 });
    const d = c.decide(g, { kind: 'node', id: 'target' });
    expect(d.action).toBe('move_forward');
    const decoded = decodeFrame(d.frame)!;
    expect(decoded.paramLeft).toBe(100);
    expect(decoded.paramRight).toBe(100);
  });

  test('both wheels emit equal speed (straight-line forward)', () => {
    const g = sceneWithTarget(0, 0, 0, 100, 0);
    const d = new ReactiveController().decide(g, { kind: 'node', id: 'target' });
    const decoded = decodeFrame(d.frame)!;
    expect(decoded.paramLeft).toBe(decoded.paramRight);
  });
});

// ---------------------------------------------------------------------------
// Oscillation resistance (the thesis)
// ---------------------------------------------------------------------------

describe('ReactiveController — oscillation resistance', () => {
  test('repeatedly deciding from the same scene returns identical opcodes', () => {
    const g = sceneWithTarget(0, 0, 0, 100, 50);
    const c = new ReactiveController();
    const opcodes = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const d = c.decide(g, { kind: 'node', id: 'target' });
      opcodes.add(decodeFrame(d.frame)!.opcode);
    }
    expect(opcodes.size).toBe(1); // never alternates
  });

  test('rotation direction does not flip between +ε and -ε bearings across frames', () => {
    // As the robot turns to face the target, bearing decreases monotonically —
    // the controller must never emit the OPPOSITE rotation mid-turn.
    const c = new ReactiveController({ turnThresholdDeg: 15 });
    const opcodes: number[] = [];
    for (let headingDeg = 0; headingDeg <= 90; headingDeg += 10) {
      const g = sceneWithTarget(0, 0, headingDeg, 0, 100); // target permanently at +90°
      const d = c.decide(g, { kind: 'node', id: 'target' });
      opcodes.push(decodeFrame(d.frame)!.opcode);
    }
    // All rotate ops must be the same direction (ROTATE_CCW), plus a final MOVE_FORWARD.
    const rotations = opcodes.filter(op => op === Opcode.ROTATE_CW || op === Opcode.ROTATE_CCW);
    expect(rotations.every(op => op === Opcode.ROTATE_CCW)).toBe(true);
  });
});
