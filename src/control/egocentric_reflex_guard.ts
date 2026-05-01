/**
 * EgocentricReflexGuard — Bbox-Based Collision Prevention
 *
 * Vetoes MOVE_FORWARD commands when a large obstacle occupies the center-bottom
 * region of the camera frame, indicating it's physically close and blocking.
 *
 * Unlike the SceneGraph-based ReflexGuard (which uses AABB forward-sweep in
 * absolute coordinates), this guard operates purely on frame-relative bounding
 * boxes from the VLM's last perception cycle.
 *
 * Returns the same GuardDecision interface for compatibility with ReactiveLoop.
 */

import {
  decodeFrame,
  encodeFrame,
  Opcode,
  OPCODE_NAMES,
} from './bytecode_compiler';
import type { FrameObstacle } from './egocentric_controller';

// =============================================================================
// Types
// =============================================================================

export type EgoGuardReason =
  | 'frame_invalid'
  | 'non_motion_opcode'
  | 'clear_path'
  | 'collision_predicted_veto';

export interface EgoGuardDecision {
  allow: boolean;
  reason: EgoGuardReason;
  opcodeName: string;
  replacement?: Buffer;
  obstacleLabel?: string;
  /** Obstacle size that triggered the veto. */
  obstacleSize?: number;
}

export interface EgoGuardConfig {
  /** Minimum obstacle size (frame fraction) to consider blocking. Default 0.30. */
  minBlockingSize?: number;
  /** Maximum horizontal offset from center for "in path." Default 0.20 (±20% of frame center). */
  maxCenterOffset?: number;
  /** Minimum cy (vertical position) for "physically close." Default 0.60. */
  minProximityCy?: number;
}

const DEFAULTS: Required<EgoGuardConfig> = {
  minBlockingSize: 0.30,
  maxCenterOffset: 0.20,
  minProximityCy: 0.60,
};

// Pre-encoded STOP frame
const STOP_FRAME = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });

// Opcodes that move the robot forward
const FORWARD_OPCODES: ReadonlySet<number> = new Set<number>([Opcode.MOVE_FORWARD]);

// =============================================================================
// Guard
// =============================================================================

export class EgocentricReflexGuard {
  private cfg: Required<EgoGuardConfig>;
  private obstacles: FrameObstacle[] = [];

  constructor(config: EgoGuardConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  /** Update obstacle list from the latest perception cycle. */
  updateObstacles(obstacles: FrameObstacle[]): void {
    this.obstacles = obstacles;
  }

  /** Check if a motor frame should be allowed or vetoed. */
  decide(frame: Buffer): EgoGuardDecision {
    const decoded = decodeFrame(frame);
    if (!decoded) {
      return { allow: true, reason: 'frame_invalid', opcodeName: 'UNKNOWN' };
    }

    const opcodeName = OPCODE_NAMES[decoded.opcode] ?? `0x${decoded.opcode.toString(16)}`;

    // Only gate forward-motion opcodes
    if (!FORWARD_OPCODES.has(decoded.opcode)) {
      return { allow: true, reason: 'non_motion_opcode', opcodeName };
    }

    // Check if any obstacle is blocking the path
    const blocking = this.obstacles.find(o =>
      o.size >= this.cfg.minBlockingSize &&
      Math.abs(o.cx - 0.5) <= this.cfg.maxCenterOffset &&
      o.cy >= this.cfg.minProximityCy
    );

    if (blocking) {
      return {
        allow: false,
        reason: 'collision_predicted_veto',
        opcodeName,
        replacement: STOP_FRAME,
        obstacleLabel: blocking.label,
        obstacleSize: blocking.size,
      };
    }

    return { allow: true, reason: 'clear_path', opcodeName };
  }
}
