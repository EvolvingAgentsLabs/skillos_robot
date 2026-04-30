/**
 * ReactiveController — SceneGraph-driven motor commander
 *
 * Replaces the Flash-Lite-style "have the VLM look at the image and emit
 * a motor opcode" path with deterministic 2D vector math against the
 * SceneGraph. The VLM (in OVERHEAD_SCENE_PROMPT mode) becomes a pure
 * perceiver; this controller is the actuator policy.
 *
 * Per-tick algorithm:
 *   1. dx = target.x - robot.x;  dy = target.y - robot.y
 *   2. distance = hypot(dx, dy)
 *   3. if distance < arrivalThresholdCm  -> STOP
 *   4. desiredHeading = atan2(dy, dx) [degrees]
 *   5. angularError = wrap180(desiredHeading - robot.heading)
 *   6. if |angularError| > turnThresholdDeg -> ROTATE_CCW or ROTATE_CW
 *      (positive error increases heading; we use the right-hand rule
 *      convention — flip via `invertRotation` if firmware disagrees)
 *   7. else -> MOVE_FORWARD with speed scaled by distance
 *
 * Why this exists:
 *   • The vector subtraction can't oscillate the way the VLM did
 *     (`docs/08-Gemini-Robotics-Integration.md` Bug #4).
 *   • Numeric CLEARANCE/PROGRESS data is computed locally — there are
 *     no numbers for the VLM to ignore (Flash-Lite failure mode in
 *     `docs/linkedin-dream-distillation-article.md`).
 *   • Quaternion-derived heading from SceneGraph never wraps at ±180°.
 */

import { vec3 } from 'gl-matrix';
import {
  encodeFrame,
  Opcode,
  type BytecodeFrame,
} from './bytecode_compiler';
import { SceneGraph, type SceneNode } from '../brain/memory/scene_graph';

// =============================================================================
// Types
// =============================================================================

export type ControllerAction =
  | 'arrived'
  | 'rotate_ccw'
  | 'rotate_cw'
  | 'move_forward'
  | 'no_target';

/** Goal for the controller — either a SceneGraph node id or a literal point. */
export type ControllerGoal =
  | { kind: 'node'; id: string }
  | { kind: 'point'; x: number; y: number };

export interface ReactiveControllerConfig {
  /** Don't rotate further once |angular error| is below this. Default 15°. */
  turnThresholdDeg?: number;
  /** Within this distance the controller emits STOP. Default 8 cm. */
  arrivalThresholdCm?: number;
  /** Forward speed (0–255) when target is far. Default 200. */
  cruiseSpeed?: number;
  /** Forward speed (0–255) when target is close (slow approach). Default 100. */
  approachSpeed?: number;
  /** Distance below which we drop to approachSpeed. Default 30 cm. */
  approachDistanceCm?: number;
  /** Rotation speed (0–255). Tuned 50–70 in docs/08 Bug #4 — default 70. */
  rotationSpeed?: number;
  /**
   * If true, swap ROTATE_CW/ROTATE_CCW emission. Set when the firmware
   * convention is opposite of "positive heading delta = CCW".
   */
  invertRotation?: boolean;
}

export interface ControllerDecision {
  /** What the controller decided to do this tick. */
  action: ControllerAction;
  /** 6-byte bytecode frame ready for transmission. */
  frame: Buffer;
  /** Decoded form of the same frame, for tests and logs. */
  bytecode: BytecodeFrame;
  /** Distance to target in cm (∞ if no target). */
  distanceCm: number;
  /** Bearing to target in degrees from robot heading, in (-180, 180]. */
  bearingDeg: number;
  /** Human-readable explanation. */
  reason: string;
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULTS: Required<ReactiveControllerConfig> = {
  turnThresholdDeg: 15,
  arrivalThresholdCm: 8,
  cruiseSpeed: 200,
  approachSpeed: 100,
  approachDistanceCm: 30,
  rotationSpeed: 70,
  invertRotation: false,
};

// =============================================================================
// ReactiveController
// =============================================================================

export class ReactiveController {
  private cfg: Required<ReactiveControllerConfig>;

  constructor(config: ReactiveControllerConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  getConfig(): Required<ReactiveControllerConfig> {
    return { ...this.cfg };
  }

  /**
   * Decide the next motor command from the current SceneGraph and goal.
   * Pure (no graph mutation, no I/O).
   */
  decide(graph: SceneGraph, goal: ControllerGoal): ControllerDecision {
    const target = resolveTarget(graph, goal);
    if (!target) {
      return this.stopDecision('no_target', `target ${describeGoal(goal)} not found`);
    }

    const robot = graph.robot;
    const dx = target.x - robot.position[0];
    const dy = target.y - robot.position[1];
    const distance = Math.hypot(dx, dy);

    // 1) Arrival check
    if (distance <= this.cfg.arrivalThresholdCm) {
      return this.stopDecision(
        'arrived',
        `target within ${this.cfg.arrivalThresholdCm}cm (d=${round(distance)})`,
        distance,
        0,
      );
    }

    const desiredHeadingDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const bearingDeg = wrap180(desiredHeadingDeg - robot.getHeadingDegrees());

    // 2) Rotate-to-face check
    if (Math.abs(bearingDeg) > this.cfg.turnThresholdDeg) {
      // Positive bearing = need to rotate heading more positive (CCW by RH rule).
      // `invertRotation` flips this if the firmware uses the opposite convention.
      const ccw = (bearingDeg > 0) !== this.cfg.invertRotation;
      const opcode = ccw ? Opcode.ROTATE_CCW : Opcode.ROTATE_CW;
      const action: ControllerAction = ccw ? 'rotate_ccw' : 'rotate_cw';
      const degrees = clampInt(Math.abs(bearingDeg), 1, 180);
      const speed = this.cfg.rotationSpeed;
      // mjswan_bridge reads paramRight as the velocity for ROTATE_*; param order
      // matches the existing tool-calling contract (degrees, speed).
      const frame: BytecodeFrame = { opcode, paramLeft: degrees, paramRight: speed };
      return {
        action,
        frame: encodeFrame(frame),
        bytecode: frame,
        distanceCm: distance,
        bearingDeg,
        reason: `bearing ${round(bearingDeg)}° > ${this.cfg.turnThresholdDeg}° → ${action}(${degrees}, ${speed})`,
      };
    }

    // 3) Cruise / approach
    const speed = distance < this.cfg.approachDistanceCm
      ? this.cfg.approachSpeed
      : this.cfg.cruiseSpeed;
    const frame: BytecodeFrame = {
      opcode: Opcode.MOVE_FORWARD,
      paramLeft: speed,
      paramRight: speed,
    };
    return {
      action: 'move_forward',
      frame: encodeFrame(frame),
      bytecode: frame,
      distanceCm: distance,
      bearingDeg,
      reason: `aligned (bearing ${round(bearingDeg)}°), d=${round(distance)}cm → move_forward(${speed},${speed})`,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private stopDecision(
    action: ControllerAction,
    reason: string,
    distanceCm = Infinity,
    bearingDeg = 0,
  ): ControllerDecision {
    const bc: BytecodeFrame = { opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 };
    return {
      action,
      frame: encodeFrame(bc),
      bytecode: bc,
      distanceCm,
      bearingDeg,
      reason,
    };
  }
}

// =============================================================================
// Free helpers
// =============================================================================

function resolveTarget(graph: SceneGraph, goal: ControllerGoal): { x: number; y: number } | null {
  if (goal.kind === 'point') return { x: goal.x, y: goal.y };
  const node: SceneNode | undefined = graph.getNode(goal.id);
  if (!node) return null;
  return { x: node.position[0], y: node.position[1] };
}

function describeGoal(goal: ControllerGoal): string {
  return goal.kind === 'node' ? `node "${goal.id}"` : `point (${goal.x}, ${goal.y})`;
}

/** Wrap an angle to the half-open interval (-180, 180]. */
function wrap180(deg: number): number {
  let d = ((deg + 180) % 360) - 180;
  if (d <= -180) d += 360;
  return d;
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(v);
  return n < lo ? lo : n > hi ? hi : n;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// Re-export gl-matrix's vec3 to make the module self-contained for callers
// that build literal targets.
export { vec3 };
