/**
 * End-to-end pipeline: Gemini-style JSON → projector → SceneGraph →
 * ReactiveController → ReflexGuard → mock transmitter.
 *
 * This is the integration seam for the Hierarchical Multi-Rate
 * Spatial-Semantic Engine. No real VLM, UDP, or MuJoCo — every part is
 * in-memory. Asserts the thesis:
 *
 *   (a) the controller's opcode is a deterministic function of the
 *       SceneGraph (no oscillation under bearing jitter);
 *   (b) the reflex guard can veto a would-collide forward command
 *       between the controller and the wire;
 *   (c) the STOP fallback is what actually gets transmitted.
 */

import {
  projectGeminiObjects,
  type GeminiObject,
  type ArenaConfig,
} from '../../src/brain/perception/vision_projector';
import { SceneGraph } from '../../src/brain/memory/scene_graph';
import { ReactiveController } from '../../src/control/reactive_controller';
import {
  ReflexGuard,
  attachReflexGuard,
  type SendableTransmitter,
} from '../../src/control/reflex_guard';
import { Opcode, decodeFrame } from '../../src/control/bytecode_compiler';

const ARENA: ArenaConfig = { widthCm: 300, heightCm: 200 };

// Long prediction window so the 4.7cm/s chassis registers a collision
// at test scales. Real-robot defaults are tuned separately.
const REFLEX_WINDOW = { predictionWindowMs: 10_000, safetyMarginCm: 0 };

// A mock transmitter that records everything the pipeline actually sends.
function makeTransmitter(): { tx: SendableTransmitter; sent: Buffer[] } {
  const sent: Buffer[] = [];
  const tx: SendableTransmitter = {
    send: async (frame: Buffer) => { sent.push(frame); },
  };
  return { tx, sent };
}

describe('Scene-graph pipeline — single tick', () => {
  test('perceive → project → decide → guard → send (clear path)', async () => {
    // 1) Gemini returns a bird's-eye perception payload.
    const perception: GeminiObject[] = [
      { label: 'roclaw', box_2d: [400, 100, 600, 200], heading_estimate: 'RIGHT' }, // arena (45, 100)
      { label: 'red cube', box_2d: [400, 700, 600, 800] },                          // arena (225, 100)
    ];

    // 2) Project into the SceneGraph.
    const graph = new SceneGraph();
    projectGeminiObjects(graph, perception, ARENA);
    expect(graph.robot.position[0]).toBeCloseTo(45, 1);
    expect(graph.robot.getHeadingDegrees()).toBeCloseTo(0, 1);

    // 3) Decide the next motor command.
    const controller = new ReactiveController();
    const decision = controller.decide(graph, { kind: 'node', id: 'obj_red_cube_0' });
    expect(decision.action).toBe('move_forward'); // target is dead ahead

    // 4) Gate via the guard (no obstacles in front → allow).
    const guard = new ReflexGuard(graph, { mode: 'active', ...REFLEX_WINDOW });
    const { tx, sent } = makeTransmitter();
    attachReflexGuard(tx, guard);
    await tx.send(decision.frame);

    // 5) The original MOVE_FORWARD frame reached the wire.
    expect(sent).toHaveLength(1);
    expect(decodeFrame(sent[0])!.opcode).toBe(Opcode.MOVE_FORWARD);
    expect(guard.getStats().vetoes).toBe(0);
  });

  test('reflex guard replaces MOVE_FORWARD with STOP when obstacle appears', async () => {
    // Robot facing a target, but a wall gets projected directly in between.
    const perception: GeminiObject[] = [
      { label: 'roclaw', box_2d: [400, 100, 600, 200], heading_estimate: 'RIGHT' },
      { label: 'red cube', box_2d: [400, 800, 600, 900] },
      { label: 'wall',    box_2d: [380, 250, 620, 290] }, // between robot and cube
    ];

    const graph = new SceneGraph();
    projectGeminiObjects(graph, perception, ARENA);

    const controller = new ReactiveController();
    const decision = controller.decide(graph, { kind: 'node', id: 'obj_red_cube_0' });
    expect(decision.action).toBe('move_forward');
    expect(decodeFrame(decision.frame)!.opcode).toBe(Opcode.MOVE_FORWARD);

    const guard = new ReflexGuard(graph, { mode: 'active', ...REFLEX_WINDOW });
    const { tx, sent } = makeTransmitter();
    attachReflexGuard(tx, guard);
    await tx.send(decision.frame);

    // The controller wanted to move forward, but the guard substituted STOP.
    expect(sent).toHaveLength(1);
    expect(decodeFrame(sent[0])!.opcode).toBe(Opcode.STOP);
    expect(guard.getStats().vetoes).toBe(1);
  });

  test('shadow mode logs the veto but still sends the original frame', async () => {
    const perception: GeminiObject[] = [
      { label: 'roclaw', box_2d: [400, 100, 600, 200], heading_estimate: 'RIGHT' },
      { label: 'red cube', box_2d: [400, 800, 600, 900] },
      { label: 'wall',    box_2d: [380, 250, 620, 290] },
    ];
    const graph = new SceneGraph();
    projectGeminiObjects(graph, perception, ARENA);

    const decision = new ReactiveController().decide(graph, { kind: 'node', id: 'obj_red_cube_0' });
    const guard = new ReflexGuard(graph, { mode: 'shadow', ...REFLEX_WINDOW });
    const { tx, sent } = makeTransmitter();
    attachReflexGuard(tx, guard);

    await tx.send(decision.frame);

    expect(sent).toHaveLength(1);
    expect(decodeFrame(sent[0])!.opcode).toBe(Opcode.MOVE_FORWARD); // unchanged
    expect(guard.getStats().shadowVetoes).toBe(1);
    expect(guard.getStats().vetoes).toBe(0);
  });

  test('arrival at target emits STOP (never rotates past it)', async () => {
    // Robot already sitting on top of the cube (within arrivalThreshold).
    const perception: GeminiObject[] = [
      { label: 'roclaw',  box_2d: [480, 500, 520, 540], heading_estimate: 'RIGHT' },
      { label: 'red cube', box_2d: [485, 505, 515, 535] }, // essentially coincident
    ];
    const graph = new SceneGraph();
    projectGeminiObjects(graph, perception, ARENA);

    const decision = new ReactiveController({ arrivalThresholdCm: 10 }).decide(
      graph, { kind: 'node', id: 'obj_red_cube_0' },
    );
    expect(decision.action).toBe('arrived');
    expect(decodeFrame(decision.frame)!.opcode).toBe(Opcode.STOP);
  });
});

describe('Scene-graph pipeline — multi-tick (oscillation thesis)', () => {
  test('jittery Gemini bearings do not flip controller rotation direction', () => {
    // Simulates the Flash-Lite oscillation failure mode (docs/linkedin-dream-*)
    // where per-frame noise in the VLM's opinion causes CW/CCW alternation.
    // The ReactiveController should never flip, because bearing is computed
    // from the SceneGraph vector, which is smooth.
    const controller = new ReactiveController({ turnThresholdDeg: 15 });
    const rotations: number[] = [];

    // Target fixed at (0, 100). Robot heading drifts in tiny random jitter
    // around 0° (as if Gemini's heading_estimate were noisy).
    // The controller must always choose ROTATE_CCW (target at +90° bearing).
    const rng = seeded(42);
    for (let tick = 0; tick < 30; tick++) {
      const headingJitter = (rng() - 0.5) * 6; // ±3°
      const graph = new SceneGraph();
      graph.updateRobotPose(0, 0, headingJitter);
      graph.addOrUpdateNode({
        id: 'target', label: 'target', x: 0, y: 100,
        boundingBox: { w: 5, h: 5, d: 5 },
      });
      const d = controller.decide(graph, { kind: 'node', id: 'target' });
      if (d.action === 'rotate_cw' || d.action === 'rotate_ccw') {
        rotations.push(decodeFrame(d.frame)!.opcode);
      }
    }

    const unique = new Set(rotations);
    expect(unique.size).toBe(1);
    expect(unique.has(Opcode.ROTATE_CCW)).toBe(true);
  });

  test('pipeline converges: rotate to face → advance → stop at target', async () => {
    // Full closed-loop tick-by-tick simulation without physics:
    // after each controller decision, we synthesize the next "Gemini frame"
    // by advancing the robot's pose as if the bytecode had executed.
    const graph = new SceneGraph();
    projectGeminiObjects(
      graph,
      [
        { label: 'roclaw',   box_2d: [100, 100, 150, 150], heading_estimate: 'RIGHT' },
        { label: 'red cube', box_2d: [700, 700, 750, 750] },
      ],
      ARENA,
    );

    const controller = new ReactiveController({ arrivalThresholdCm: 5 });
    const guard = new ReflexGuard(graph, { mode: 'shadow', ...REFLEX_WINDOW });
    const { tx, sent } = makeTransmitter();
    attachReflexGuard(tx, guard);

    const actions: string[] = [];
    let arrived = false;
    for (let tick = 0; tick < 200 && !arrived; tick++) {
      const d = controller.decide(graph, { kind: 'node', id: 'obj_red_cube_0' });
      actions.push(d.action);
      await tx.send(d.frame);

      // "Physics" step: apply the controller's intent to the robot pose.
      if (d.action === 'move_forward') {
        const stepCm = 5;
        const h = graph.robot.getHeadingDegrees() * Math.PI / 180;
        const nx = graph.robot.position[0] + Math.cos(h) * stepCm;
        const ny = graph.robot.position[1] + Math.sin(h) * stepCm;
        graph.updateRobotPose(nx, ny, graph.robot.getHeadingDegrees());
      } else if (d.action === 'rotate_ccw') {
        graph.updateRobotPose(
          graph.robot.position[0], graph.robot.position[1],
          graph.robot.getHeadingDegrees() + decodeFrame(d.frame)!.paramLeft,
        );
      } else if (d.action === 'rotate_cw') {
        graph.updateRobotPose(
          graph.robot.position[0], graph.robot.position[1],
          graph.robot.getHeadingDegrees() - decodeFrame(d.frame)!.paramLeft,
        );
      } else if (d.action === 'arrived') {
        arrived = true;
      }
    }

    expect(arrived).toBe(true);
    // Final action is 'arrived' (STOP); at least one rotation and one forward step occurred.
    expect(actions[actions.length - 1]).toBe('arrived');
    expect(actions).toContain('move_forward');
    expect(actions.some(a => a === 'rotate_ccw' || a === 'rotate_cw')).toBe(true);
    // The last frame to actually hit the wire is STOP.
    expect(decodeFrame(sent[sent.length - 1])!.opcode).toBe(Opcode.STOP);
  });
});

// -----------------------------------------------------------------------------
// Tiny seeded RNG so the jitter test is deterministic.
// -----------------------------------------------------------------------------
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // Mulberry32
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
