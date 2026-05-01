import {
  ReflexGuard,
  attachReflexGuard,
  type ReflexMode,
  type SendableTransmitter,
} from '../../src/control/reflex_guard';
import { SceneGraph } from '../../src/brain/memory/scene_graph';
import { encodeFrame, Opcode, FRAME_SIZE } from '../../src/control/bytecode_compiler';

// =============================================================================
// Helpers
// =============================================================================

function moveForward(speed = 200): Buffer {
  return encodeFrame({ opcode: Opcode.MOVE_FORWARD, paramLeft: speed, paramRight: speed });
}
function moveBackward(speed = 200): Buffer {
  return encodeFrame({ opcode: Opcode.MOVE_BACKWARD, paramLeft: speed, paramRight: speed });
}
function turnLeft(speed = 100): Buffer {
  return encodeFrame({ opcode: Opcode.TURN_LEFT, paramLeft: 0x60, paramRight: speed });
}
function rotateCW(speed = 80): Buffer {
  return encodeFrame({ opcode: Opcode.ROTATE_CW, paramLeft: speed, paramRight: speed });
}
function stop(): Buffer {
  return encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
}

function graphWithObstacleAhead(distanceCm = 30): SceneGraph {
  const g = new SceneGraph();
  g.updateRobotPose(0, 0, 0); // facing +X
  g.addOrUpdateNode({
    id: 'wall',
    label: 'wall',
    x: distanceCm,
    y: 0,
    boundingBox: { w: 5, h: 50, d: 10 },
  });
  return g;
}

function graphClear(): SceneGraph {
  const g = new SceneGraph();
  g.updateRobotPose(0, 0, 0);
  // place an obstacle far away so it never trips the predictor
  g.addOrUpdateNode({ id: 'far', label: 'far', x: 9999, y: 9999 });
  return g;
}

// Long prediction window so the (very slow 4.7cm/s) chassis still triggers
// collisions in unit tests within a reasonable arena.
const LONG_WINDOW = { predictionWindowMs: 10_000, safetyMarginCm: 0 };

// =============================================================================
// Mode resolution
// =============================================================================

describe('ReflexGuard — mode resolution', () => {
  const ORIGINAL_ENV = process.env.RF_REFLEX_ENABLED;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.RF_REFLEX_ENABLED;
    else process.env.RF_REFLEX_ENABLED = ORIGINAL_ENV;
  });

  test('explicit config wins over env', () => {
    process.env.RF_REFLEX_ENABLED = '1';
    const g = new ReflexGuard(graphClear(), { mode: 'disabled' });
    expect(g.getMode()).toBe('disabled');
  });

  const cases: Array<[string | undefined, ReflexMode]> = [
    [undefined, 'active'],    // Default: active enforcement (changed 2026-04-27)
    ['', 'active'],           // Empty string → default (active)
    ['shadow', 'shadow'],
    ['1', 'active'],
    ['true', 'active'],
    ['ACTIVE', 'active'],
    ['0', 'disabled'],
    ['false', 'disabled'],
    ['DISABLED', 'disabled'],
    ['garbage', 'active'],    // Unrecognized → default (active)
  ];
  test.each(cases)('env=%j → mode=%s', (env, expected) => {
    if (env === undefined) delete process.env.RF_REFLEX_ENABLED;
    else process.env.RF_REFLEX_ENABLED = env;
    const g = new ReflexGuard(graphClear());
    expect(g.getMode()).toBe(expected);
  });

  test('setMode mutates after construction', () => {
    const g = new ReflexGuard(graphClear(), { mode: 'shadow' });
    g.setMode('active');
    expect(g.getMode()).toBe('active');
  });
});

// =============================================================================
// Decision logic
// =============================================================================

describe('ReflexGuard — decide()', () => {
  test('non-motion opcodes are always allowed', () => {
    const g = new ReflexGuard(graphWithObstacleAhead(5), { mode: 'active', ...LONG_WINDOW });
    for (const f of [stop(), rotateCW(), encodeFrame({ opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 })]) {
      const d = g.decide(f);
      expect(d.allow).toBe(true);
      expect(d.reason).toMatch(/non_motion_opcode|clear_path/);
    }
  });

  test('disabled mode never inspects', () => {
    const g = new ReflexGuard(graphWithObstacleAhead(5), { mode: 'disabled', ...LONG_WINDOW });
    const d = g.decide(moveForward());
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('disabled');
  });

  test('clear path → allow', () => {
    const g = new ReflexGuard(graphClear(), { mode: 'active', ...LONG_WINDOW });
    const d = g.decide(moveForward());
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('clear_path');
    expect(d.predictedDistanceCm).toBeGreaterThan(0);
  });

  test('active mode vetoes when obstacle is in predicted path', () => {
    const g = new ReflexGuard(graphWithObstacleAhead(20), { mode: 'active', ...LONG_WINDOW });
    const d = g.decide(moveForward(255));
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('collision_predicted_veto');
    expect(d.obstacleId).toBe('wall');
    expect(d.obstacleLabel).toBe('wall');
    expect(d.replacement).toBeDefined();
    expect(d.replacement!.length).toBe(FRAME_SIZE);
    // Replacement must be a STOP frame.
    expect(d.replacement![1]).toBe(Opcode.STOP);
  });

  test('shadow mode logs but always allows', () => {
    const g = new ReflexGuard(graphWithObstacleAhead(20), { mode: 'shadow', ...LONG_WINDOW });
    const d = g.decide(moveForward(255));
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('collision_predicted_shadow');
    expect(d.obstacleId).toBe('wall');
    expect(d.replacement).toBeUndefined();
  });

  test('active mode emits reflexStop event with frame + decision', () => {
    const g = new ReflexGuard(graphWithObstacleAhead(20), { mode: 'active', ...LONG_WINDOW });
    const events: any[] = [];
    g.on('reflexStop', (e) => events.push(e));
    const frame = moveForward(255);
    g.decide(frame);
    expect(events).toHaveLength(1);
    expect(events[0].frame).toBe(frame);
    expect(events[0].decision.allow).toBe(false);
  });

  test('shadow mode emits shadowVeto event (not reflexStop)', () => {
    const g = new ReflexGuard(graphWithObstacleAhead(20), { mode: 'shadow', ...LONG_WINDOW });
    const stops: any[] = [];
    const shadows: any[] = [];
    g.on('reflexStop', (e) => stops.push(e));
    g.on('shadowVeto', (e) => shadows.push(e));
    g.decide(moveForward(255));
    expect(stops).toHaveLength(0);
    expect(shadows).toHaveLength(1);
  });

  test('invalid frame is allowed (let transmitter complain about it)', () => {
    const g = new ReflexGuard(graphClear(), { mode: 'active' });
    const bogus = Buffer.from([0xAA, 0x01, 0x00, 0x00, 0xFF, 0xFF]); // bad checksum
    const d = g.decide(bogus);
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('frame_invalid');
  });

  test('TURN_LEFT is treated as forward motion (differential drive)', () => {
    const g = new ReflexGuard(graphWithObstacleAhead(15), { mode: 'active', ...LONG_WINDOW });
    const d = g.decide(turnLeft(255));
    expect(d.allow).toBe(false);
    expect(d.opcodeName).toBe('TURN_LEFT');
  });

  test('ROTATE_CW is pure rotation — never vetoed even with obstacle ahead', () => {
    const g = new ReflexGuard(graphWithObstacleAhead(2), { mode: 'active', ...LONG_WINDOW });
    const d = g.decide(rotateCW(200));
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('non_motion_opcode');
  });

  test('MOVE_BACKWARD uses backward sweep (not forward)', () => {
    const g = new SceneGraph();
    g.updateRobotPose(0, 0, 0);
    // Obstacle BEHIND the robot at -X
    g.addOrUpdateNode({
      id: 'rear_wall',
      label: 'rear wall',
      x: -25,
      y: 0,
      boundingBox: { w: 5, h: 50, d: 10 },
    });
    const guard = new ReflexGuard(g, { mode: 'active', ...LONG_WINDOW });

    // Moving forward is fine — nothing ahead.
    expect(guard.decide(moveForward(255)).allow).toBe(true);
    // Moving backward should hit the rear wall.
    const d = guard.decide(moveBackward(255));
    expect(d.allow).toBe(false);
    expect(d.obstacleId).toBe('rear_wall');
  });

  test('respects current robot heading (reflex updates with pose)', () => {
    const g = new SceneGraph();
    g.updateRobotPose(0, 0, 0); // facing +X
    g.addOrUpdateNode({
      id: 'east_wall',
      label: 'east wall',
      x: 25,
      y: 0,
      boundingBox: { w: 5, h: 50, d: 10 },
    });
    const guard = new ReflexGuard(g, { mode: 'active', ...LONG_WINDOW });

    expect(guard.decide(moveForward(255)).allow).toBe(false); // hits wall

    // Turn 90° — wall is now to the right, not ahead.
    g.updateRobotPose(0, 0, 90);
    expect(guard.decide(moveForward(255)).allow).toBe(true);
  });

  test('predicted distance scales with prediction window and speed', () => {
    const g1 = new ReflexGuard(graphClear(), { mode: 'shadow', predictionWindowMs: 1000, safetyMarginCm: 0 });
    const g2 = new ReflexGuard(graphClear(), { mode: 'shadow', predictionWindowMs: 2000, safetyMarginCm: 0 });
    const d1 = g1.decide(moveForward(255));
    const d2 = g2.decide(moveForward(255));
    expect(d2.predictedDistanceCm).toBeCloseTo((d1.predictedDistanceCm ?? 0) * 2, 3);

    const slow = g1.decide(moveForward(128));
    expect(slow.predictedDistanceCm).toBeLessThan(d1.predictedDistanceCm ?? Infinity);
  });

  test('safety margin extends the predicted reach', () => {
    const small = new ReflexGuard(graphClear(), { mode: 'shadow', predictionWindowMs: 100, safetyMarginCm: 0 });
    const large = new ReflexGuard(graphClear(), { mode: 'shadow', predictionWindowMs: 100, safetyMarginCm: 25 });
    const ds = small.decide(moveForward(255));
    const dl = large.decide(moveForward(255));
    expect((dl.predictedDistanceCm ?? 0) - (ds.predictedDistanceCm ?? 0)).toBeCloseTo(25, 3);
  });
});

// =============================================================================
// guardedSend wrapper
// =============================================================================

describe('ReflexGuard — guardedSend()', () => {
  test('passes the original frame through when allowed', async () => {
    const frame = moveForward(200);
    const sent: Buffer[] = [];
    const tx = { send: async (b: Buffer) => { sent.push(b); } };
    const g = new ReflexGuard(graphClear(), { mode: 'active', ...LONG_WINDOW });

    const d = await g.guardedSend(tx, frame);
    expect(d.allow).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(frame);
  });

  test('substitutes STOP frame when active-mode vetoes', async () => {
    const frame = moveForward(255);
    const sent: Buffer[] = [];
    const tx = { send: async (b: Buffer) => { sent.push(b); } };
    const g = new ReflexGuard(graphWithObstacleAhead(20), { mode: 'active', ...LONG_WINDOW });

    const d = await g.guardedSend(tx, frame);
    expect(d.allow).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe(frame);
    expect(sent[0][1]).toBe(Opcode.STOP);
  });

  test('shadow mode passes original frame even when it would-collide', async () => {
    const frame = moveForward(255);
    const sent: Buffer[] = [];
    const tx = { send: async (b: Buffer) => { sent.push(b); } };
    const g = new ReflexGuard(graphWithObstacleAhead(20), { mode: 'shadow', ...LONG_WINDOW });

    const d = await g.guardedSend(tx, frame);
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('collision_predicted_shadow');
    expect(sent[0]).toBe(frame);
  });

  test('propagates send errors', async () => {
    const tx = { send: async () => { throw new Error('udp down'); } };
    const g = new ReflexGuard(graphClear(), { mode: 'shadow' });
    await expect(g.guardedSend(tx, moveForward())).rejects.toThrow(/udp down/);
  });
});

// =============================================================================
// Stats
// =============================================================================

// =============================================================================
// attachReflexGuard — monkey-patched transmitter
// =============================================================================

describe('attachReflexGuard()', () => {
  function makeTx(): { tx: SendableTransmitter; sent: Buffer[] } {
    const sent: Buffer[] = [];
    const tx: SendableTransmitter = {
      send: async (b: Buffer) => { sent.push(b); },
    };
    return { tx, sent };
  }

  test('intercepts send() so every frame passes through decide()', async () => {
    const { tx, sent } = makeTx();
    const guard = new ReflexGuard(graphClear(), { mode: 'shadow' });
    attachReflexGuard(tx, guard);

    await tx.send(moveForward());
    await tx.send(stop());

    const stats = guard.getStats();
    expect(stats.decisions).toBe(2);
    expect(sent).toHaveLength(2);
  });

  test('active mode replaces would-collide frames with STOP on the wire', async () => {
    const { tx, sent } = makeTx();
    const guard = new ReflexGuard(graphWithObstacleAhead(20), { mode: 'active', ...LONG_WINDOW });
    attachReflexGuard(tx, guard);

    const original = moveForward(255);
    await tx.send(original);

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe(original);
    expect(sent[0][1]).toBe(Opcode.STOP);
  });

  test('shadow mode sends the original frame verbatim', async () => {
    const { tx, sent } = makeTx();
    const guard = new ReflexGuard(graphWithObstacleAhead(20), { mode: 'shadow', ...LONG_WINDOW });
    attachReflexGuard(tx, guard);

    const original = moveForward(255);
    await tx.send(original);
    expect(sent[0]).toBe(original);
    expect(guard.getStats().shadowVetoes).toBe(1);
  });

  test('detach() restores the original send method', async () => {
    const { tx, sent } = makeTx();
    const guard = new ReflexGuard(graphWithObstacleAhead(20), { mode: 'active', ...LONG_WINDOW });
    const originalSend = tx.send;
    const detach = attachReflexGuard(tx, guard);

    expect(tx.send).not.toBe(originalSend);
    detach();
    expect(tx.send).toBe(originalSend);

    // After detach the guard no longer intercepts.
    await tx.send(moveForward(255));
    expect(guard.getStats().decisions).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test('propagates underlying transmitter errors', async () => {
    const tx: SendableTransmitter = {
      send: async () => { throw new Error('network down'); },
    };
    const guard = new ReflexGuard(graphClear(), { mode: 'shadow' });
    attachReflexGuard(tx, guard);

    await expect(tx.send(moveForward())).rejects.toThrow(/network down/);
    expect(guard.getStats().decisions).toBe(1);
  });
});

describe('ReflexGuard — getStats()', () => {
  test('counts decisions, vetoes, allowed', () => {
    const g = new ReflexGuard(graphWithObstacleAhead(20), { mode: 'active', ...LONG_WINDOW });
    g.decide(moveForward(255));   // veto
    g.decide(stop());             // allow (non-motion)
    g.decide(rotateCW());         // allow (non-motion)
    const s = g.getStats();
    expect(s.decisions).toBe(3);
    expect(s.vetoes).toBe(1);
    expect(s.allowed).toBe(2);
    expect(s.shadowVetoes).toBe(0);
    expect(s.mode).toBe('active');
  });

  test('shadow vetoes are counted separately from active vetoes', () => {
    const g = new ReflexGuard(graphWithObstacleAhead(20), { mode: 'shadow', ...LONG_WINDOW });
    g.decide(moveForward(255));
    const s = g.getStats();
    expect(s.shadowVetoes).toBe(1);
    expect(s.vetoes).toBe(0);
    expect(s.allowed).toBe(0);
  });
});
