/**
 * ReflexGuard — Pre-send collision veto for the SceneGraph reflex loop
 *
 * Sits in front of UDPTransmitter.send() and answers a single question:
 * "If I send this bytecode now, will the robot collide with a known
 * obstacle in the SceneGraph within the next predictionWindowMs?"
 *
 * Three modes (default = 'shadow'):
 *
 *   • 'disabled' — never inspect, always allow. Use when the SceneGraph
 *     is not yet populated (e.g. before first Gemini frame) or to bypass
 *     for benchmarking.
 *   • 'shadow'   — inspect every frame and log would-be vetoes, but
 *     always pass through. Use to validate the predictor against real
 *     traces without putting it on the critical path.
 *   • 'active'   — replace would-collide bytecodes with a STOP frame
 *     (AA 07 00 00 07 FF) and emit a 'reflexStop' event.
 *
 * Mode is read from `RF_REFLEX_ENABLED` env var if not supplied:
 *   '1' / 'true' / 'active'      → active
 *   '0' / 'false' / 'disabled'   → disabled
 *   anything else / unset        → shadow
 *
 * The guard is *passive*: it never mutates the SceneGraph, never opens
 * a UDP socket, never starts a timer. It exposes a synchronous decide()
 * for unit tests and a guardedSend() helper for production wiring.
 */

import { EventEmitter } from 'events';
import {
  decodeFrame,
  encodeFrame,
  Opcode,
  OPCODE_NAMES,
  type BytecodeFrame,
} from './bytecode_compiler';
import { SceneGraph } from '../brain/memory/scene_graph';
import { StepperKinematics } from '../shared/stepper-kinematics';
import { logger } from '../shared/logger';

// =============================================================================
// Types
// =============================================================================

export type ReflexMode = 'disabled' | 'shadow' | 'active';

export interface ReflexGuardConfig {
  /** Override the env-derived default. */
  mode?: ReflexMode;
  /** How far ahead (in ms) we project the robot's motion. Default 1000. */
  predictionWindowMs?: number;
  /** Extra cm added on top of the predicted distance. Default 5. */
  safetyMarginCm?: number;
  /** Kinematics model — defaults to 28BYJ-48 (stepper-kinematics.ts default). */
  kinematics?: StepperKinematics;
  /** STOP frame to substitute on veto. Defaults to encodeFrame(STOP, 0, 0). */
  stopFrame?: Buffer;
}

export interface GuardDecision {
  /** True if the original frame should be sent; false if it should be replaced. */
  allow: boolean;
  /** Tag describing why this decision was made. */
  reason:
    | 'frame_invalid'
    | 'non_motion_opcode'
    | 'disabled'
    | 'clear_path'
    | 'collision_predicted_shadow'
    | 'collision_predicted_veto';
  /** Decoded opcode mnemonic, for logging. */
  opcodeName: string;
  /** Frame to send when allow=false. Always set in active-mode vetoes. */
  replacement?: Buffer;
  /** Distance (cm) the predictor projected for this frame. */
  predictedDistanceCm?: number;
  /** Id of the obstacle that triggered the veto, if any. */
  obstacleId?: string;
  /** Label of the obstacle, if any. */
  obstacleLabel?: string;
}

export interface GuardStats {
  decisions: number;
  allowed: number;
  vetoes: number;
  shadowVetoes: number;
  mode: ReflexMode;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_PREDICTION_WINDOW_MS = 1000;
const DEFAULT_SAFETY_MARGIN_CM = 5;
const ENV_VAR = 'RF_REFLEX_ENABLED';

// =============================================================================
// ReflexGuard
// =============================================================================

export class ReflexGuard extends EventEmitter {
  private graph: SceneGraph;
  private mode: ReflexMode;
  private predictionWindowMs: number;
  private safetyMarginCm: number;
  private kinematics: StepperKinematics;
  private stopFrame: Buffer;
  private stats = {
    decisions: 0,
    allowed: 0,
    vetoes: 0,
    shadowVetoes: 0,
  };

  constructor(graph: SceneGraph, config: ReflexGuardConfig = {}) {
    super();
    this.graph = graph;
    this.mode = config.mode ?? readModeFromEnv();
    this.predictionWindowMs = config.predictionWindowMs ?? DEFAULT_PREDICTION_WINDOW_MS;
    this.safetyMarginCm = config.safetyMarginCm ?? DEFAULT_SAFETY_MARGIN_CM;
    this.kinematics = config.kinematics ?? new StepperKinematics();
    this.stopFrame = config.stopFrame ?? encodeFrame({
      opcode: Opcode.STOP,
      paramLeft: 0,
      paramRight: 0,
    });
  }

  // ---------------------------------------------------------------------------
  // Mode & stats
  // ---------------------------------------------------------------------------

  setMode(mode: ReflexMode): void {
    this.mode = mode;
  }

  getMode(): ReflexMode {
    return this.mode;
  }

  getStats(): GuardStats {
    return { ...this.stats, mode: this.mode };
  }

  // ---------------------------------------------------------------------------
  // Core decision
  // ---------------------------------------------------------------------------

  /**
   * Inspect a 6-byte bytecode frame and decide whether to allow it.
   * Pure (no side effects beyond stats and event emission).
   */
  decide(frame: Buffer): GuardDecision {
    this.stats.decisions++;

    const decoded = decodeFrame(frame);
    if (!decoded) {
      // We never veto frames we can't parse — let the transmitter handle them.
      return this.allow('frame_invalid', 'UNKNOWN');
    }
    const opName = OPCODE_NAMES[decoded.opcode] ?? `0x${decoded.opcode.toString(16)}`;

    if (this.mode === 'disabled') {
      return this.allow('disabled', opName);
    }

    const direction = motionDirection(decoded.opcode);
    if (direction === 'none') {
      return this.allow('non_motion_opcode', opName);
    }

    const speedCmS = this.predictedSpeedCmS(decoded);
    const distanceCm = (speedCmS * this.predictionWindowMs) / 1000 + this.safetyMarginCm;
    const sweep = direction === 'forward' ? distanceCm : -distanceCm;

    const hit = this.graph.predictForwardCollision(sweep);
    if (!hit) {
      return this.allow('clear_path', opName, distanceCm);
    }

    const isActive = this.mode === 'active';
    const decision: GuardDecision = {
      allow: !isActive,
      reason: isActive ? 'collision_predicted_veto' : 'collision_predicted_shadow',
      opcodeName: opName,
      predictedDistanceCm: distanceCm,
      obstacleId: hit.id,
      obstacleLabel: hit.label,
      replacement: isActive ? this.stopFrame : undefined,
    };

    if (isActive) {
      this.stats.vetoes++;
      logger.warn('ReflexGuard', `VETO ${opName} → ${hit.label} ahead`, {
        distanceCm: round2(distanceCm),
        obstacleId: hit.id,
      });
      this.emit('reflexStop', { frame, decision });
    } else {
      this.stats.shadowVetoes++;
      logger.info('ReflexGuard', `SHADOW VETO ${opName} → ${hit.label} ahead`, {
        distanceCm: round2(distanceCm),
        obstacleId: hit.id,
      });
      this.emit('shadowVeto', { frame, decision });
    }

    return decision;
  }

  /**
   * Convenience wrapper around UDPTransmitter.send() that runs decide()
   * first and substitutes the STOP frame on active-mode vetoes.
   *
   * Returns the decision so callers can correlate with logs.
   */
  async guardedSend(
    transmitter: { send(frame: Buffer): Promise<void> },
    frame: Buffer,
  ): Promise<GuardDecision> {
    const d = this.decide(frame);
    const toSend = d.allow ? frame : (d.replacement ?? frame);
    await transmitter.send(toSend);
    return d;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private allow(
    reason: GuardDecision['reason'],
    opcodeName: string,
    predictedDistanceCm?: number,
  ): GuardDecision {
    this.stats.allowed++;
    return { allow: true, reason, opcodeName, predictedDistanceCm };
  }

  /**
   * Convert a bytecode's [paramLeft, paramRight] (each 0–255) into a linear
   * speed in cm/s using the chassis kinematics. Mirrors the conversion in
   * mjswan_bridge.ts (speedParamToRadS) so the predictor agrees with the
   * simulator's physics.
   */
  private predictedSpeedCmS(frame: BytecodeFrame): number {
    const spec = this.kinematics.getSpec();
    const wheelRadiusCm = spec.wheelDiameterCm / 2;
    const maxRadS = (spec.maxStepsPerSecond / spec.stepsPerRevolution) * 2 * Math.PI;
    const avgParam = (frame.paramLeft + frame.paramRight) / 2;
    const wheelRadS = (avgParam / 255) * maxRadS;
    return Math.abs(wheelRadS * wheelRadiusCm);
  }
}

// =============================================================================
// attachReflexGuard — wrap a transmitter.send call site
// =============================================================================

/**
 * Minimal contract the guard needs from a transmitter — implemented by
 * UDPTransmitter and easily mock-able. We intentionally type structurally
 * so callers can pass mock or alternative transports without coupling.
 */
export interface SendableTransmitter {
  send(frame: Buffer): Promise<void>;
}

/**
 * Monkey-patch a transmitter so every `transmitter.send(frame)` call is
 * funneled through the guard. Returns a `detach()` function that restores
 * the original send method.
 *
 * In 'shadow' mode this is observationally identical to the unguarded
 * transmitter (the original frame is always sent); the guard only logs.
 * In 'active' mode, would-collide frames are replaced with STOP before
 * leaving the wire.
 *
 * Use this once at boot, after `transmitter.connect()`.
 */
export function attachReflexGuard(
  transmitter: SendableTransmitter,
  guard: ReflexGuard,
): () => void {
  // Preserve the exact original method reference so detach() is fully reversible
  // (including identity comparisons). We bind internally for correct `this`,
  // without mutating the stored reference.
  const original = transmitter.send;
  const boundOriginal = original.bind(transmitter);
  transmitter.send = async (frame: Buffer): Promise<void> => {
    const decision = guard.decide(frame);
    const toSend = decision.allow ? frame : (decision.replacement ?? frame);
    await boundOriginal(toSend);
  };
  return () => {
    transmitter.send = original;
  };
}

// =============================================================================
// Free helpers
// =============================================================================

type MotionDirection = 'forward' | 'backward' | 'none';

/**
 * Map an opcode to the dominant translation direction the chassis would
 * take when it executes the bytecode.
 *
 *   - MOVE_FORWARD / MOVE_STEPS / TURN_LEFT / TURN_RIGHT → 'forward'
 *     (TURN ops are differential drive — they translate forward while turning.)
 *   - MOVE_BACKWARD / MOVE_STEPS_R                       → 'backward'
 *   - ROTATE_CW / ROTATE_CCW / STOP / GET_STATUS / etc.  → 'none'
 *     (Pure in-place rotations and non-motion opcodes are never gated.)
 */
function motionDirection(opcode: number): MotionDirection {
  switch (opcode) {
    case Opcode.MOVE_FORWARD:
    case Opcode.TURN_LEFT:
    case Opcode.TURN_RIGHT:
    case Opcode.MOVE_STEPS:
      return 'forward';
    case Opcode.MOVE_BACKWARD:
    case Opcode.MOVE_STEPS_R:
      return 'backward';
    default:
      return 'none';
  }
}

function readModeFromEnv(): ReflexMode {
  const v = process.env[ENV_VAR];
  if (v === undefined) return 'active';  // Default: active enforcement (was 'shadow' pre-2026-04-27)
  const norm = v.trim().toLowerCase();
  if (norm === '1' || norm === 'true' || norm === 'active') return 'active';
  if (norm === '0' || norm === 'false' || norm === 'disabled') return 'disabled';
  if (norm === 'shadow') return 'shadow';
  return 'active';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
