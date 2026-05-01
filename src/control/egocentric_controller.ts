/**
 * EgocentricController — First-Person Visual Servoing
 *
 * Makes motor decisions purely from the target's position in the camera frame.
 * No absolute coordinates, no SceneGraph queries, no IMU needed.
 *
 * Algorithm:
 *   1. No target visible → SEARCH (rotate CW to scan environment)
 *   2. Target fills bottom of frame → ARRIVED (STOP)
 *   3. Target left of center → TURN_LEFT (ROTATE_CCW)
 *   4. Target right of center → TURN_RIGHT (ROTATE_CW)
 *   5. Target centered → MOVE_FORWARD (speed scaled by proximity)
 *
 * Input: normalized frame coordinates (0–1) from VLM bounding boxes.
 * Output: 6-byte ISA v1 motor frames.
 */

import {
  encodeFrame,
  Opcode,
  type BytecodeFrame,
} from './bytecode_compiler';

// =============================================================================
// Types
// =============================================================================

/** A target object detected in the camera frame. */
export interface FrameTarget {
  /** Horizontal center of bbox, normalized 0–1 (0=left edge, 1=right edge). */
  cx: number;
  /** Vertical center of bbox, normalized 0–1 (0=top edge, 1=bottom edge). */
  cy: number;
  /** Relative size of bbox (area / frame_area), 0–1. */
  size: number;
  /** Label from VLM. */
  label: string;
}

/** An obstacle detected in the camera frame. */
export interface FrameObstacle {
  cx: number;
  cy: number;
  size: number;
  label: string;
}

/** Combined perception state from the last VLM cycle. */
export interface EgocentricPerception {
  target: FrameTarget | null;
  obstacles: FrameObstacle[];
  timestamp: number;
}

export type EgoAction =
  | 'turn_left'
  | 'turn_right'
  | 'move_forward'
  | 'arrived'
  | 'search'
  | 'blocked';

/** Output of a single control tick. */
export interface EgoDecision {
  action: EgoAction;
  /** 6-byte ISA frame ready for UDP. */
  frame: Buffer;
  /** Decoded form for tests/logs. */
  bytecode: BytecodeFrame;
  /** Human-readable explanation. */
  reason: string;
  /** Target cx in frame (if visible). */
  targetCx?: number;
  /** Target cy in frame (if visible). */
  targetCy?: number;
  /** Target size in frame (if visible). */
  targetSize?: number;
}

// =============================================================================
// Configuration
// =============================================================================

export interface EgocentricControllerConfig {
  /**
   * Half-width of the center dead zone. Target cx within [0.5 - deadzone, 0.5 + deadzone]
   * is considered "centered." Default 0.17 (~33%–67% of frame).
   */
  centerDeadzone?: number;
  /** Target size threshold for arrival (fraction of frame). Default 0.25. */
  arrivalSizeThreshold?: number;
  /** Target cy threshold for arrival (bottom of frame). Default 0.8. */
  arrivalCyThreshold?: number;
  /** Forward speed (0–255). Default 180. */
  forwardSpeed?: number;
  /** Slow approach speed when target is large. Default 100. */
  approachSpeed?: number;
  /** Target size above which we slow down. Default 0.10. */
  approachSizeThreshold?: number;
  /** Turn speed (0–255). Default 100. */
  turnSpeed?: number;
  /** Search rotation speed (0–255). Default 80. */
  searchSpeed?: number;
}

const DEFAULTS: Required<EgocentricControllerConfig> = {
  centerDeadzone: 0.17,
  arrivalSizeThreshold: 0.25,
  arrivalCyThreshold: 0.8,
  forwardSpeed: 180,
  approachSpeed: 100,
  approachSizeThreshold: 0.10,
  turnSpeed: 100,
  searchSpeed: 80,
};

// =============================================================================
// Controller
// =============================================================================

export class EgocentricController {
  private cfg: Required<EgocentricControllerConfig>;

  constructor(config: EgocentricControllerConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  getConfig(): Required<EgocentricControllerConfig> {
    return { ...this.cfg };
  }

  /**
   * Decide the next motor command from the latest egocentric perception.
   * Pure function — no I/O, no state mutation.
   */
  decide(perception: EgocentricPerception): EgoDecision {
    const { target } = perception;

    // 1. No target visible → rotate to search
    if (!target) {
      return this.makeDecision(
        'search',
        { opcode: Opcode.ROTATE_CW, paramLeft: this.cfg.searchSpeed, paramRight: this.cfg.searchSpeed },
        'Target not visible — scanning',
      );
    }

    // 2. Arrival check: target fills frame bottom
    if (target.size >= this.cfg.arrivalSizeThreshold && target.cy >= this.cfg.arrivalCyThreshold) {
      return this.makeDecision(
        'arrived',
        { opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 },
        `Arrived — target "${target.label}" fills ${(target.size * 100).toFixed(0)}% at cy=${target.cy.toFixed(2)}`,
        target,
      );
    }

    // 3. Lateral alignment — keep target in center band
    const offset = target.cx - 0.5; // negative = left, positive = right

    if (offset < -this.cfg.centerDeadzone) {
      // Target is left of center → turn left (CCW)
      const intensity = Math.min(255, Math.round(this.cfg.turnSpeed * Math.abs(offset) * 2));
      return this.makeDecision(
        'turn_left',
        { opcode: Opcode.ROTATE_CCW, paramLeft: intensity || this.cfg.turnSpeed, paramRight: intensity || this.cfg.turnSpeed },
        `Target "${target.label}" left of center (cx=${target.cx.toFixed(2)}, offset=${offset.toFixed(2)})`,
        target,
      );
    }

    if (offset > this.cfg.centerDeadzone) {
      // Target is right of center → turn right (CW)
      const intensity = Math.min(255, Math.round(this.cfg.turnSpeed * Math.abs(offset) * 2));
      return this.makeDecision(
        'turn_right',
        { opcode: Opcode.ROTATE_CW, paramLeft: intensity || this.cfg.turnSpeed, paramRight: intensity || this.cfg.turnSpeed },
        `Target "${target.label}" right of center (cx=${target.cx.toFixed(2)}, offset=${offset.toFixed(2)})`,
        target,
      );
    }

    // 4. Target centered → move forward (speed scaled by proximity)
    const speed = target.size > this.cfg.approachSizeThreshold
      ? this.cfg.approachSpeed
      : this.cfg.forwardSpeed;

    return this.makeDecision(
      'move_forward',
      { opcode: Opcode.MOVE_FORWARD, paramLeft: speed, paramRight: speed },
      `Target "${target.label}" centered (cx=${target.cx.toFixed(2)}) — ${speed === this.cfg.approachSpeed ? 'approaching' : 'cruising'}`,
      target,
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private makeDecision(
    action: EgoAction,
    bytecode: BytecodeFrame,
    reason: string,
    target?: FrameTarget,
  ): EgoDecision {
    return {
      action,
      frame: encodeFrame(bytecode),
      bytecode,
      reason,
      targetCx: target?.cx,
      targetCy: target?.cy,
      targetSize: target?.size,
    };
  }
}
