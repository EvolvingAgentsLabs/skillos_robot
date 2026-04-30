/**
 * V1 Visual Self-Perception — Camera-based action verification
 *
 * Compares pre-command and post-command camera frames to determine
 * whether a motor action produced observable visual change.
 *
 * Three verdicts:
 *   - 'coherent': Visual change matches what the command would produce.
 *   - 'stuck':    No significant visual change despite a motion command.
 *   - 'anomaly':  Change detected on a STOP command (environmental drift).
 *
 * Constraints honored:
 *   NC-014: Post-frame captured AFTER settling (minTimeDeltaMs gate).
 *   NC-015: isConfirmedStuck() requires consecutive hits to reduce false positives.
 *   NC-016: Thresholds calibratable per environment via calibrateNoiseFloor().
 */

import sharp from 'sharp';
import { logger } from '../../shared/logger';
import { Opcode, OPCODE_NAMES } from '../../control/bytecode_compiler';

// =============================================================================
// Types
// =============================================================================

export type SelfPerceptionVerdict = 'coherent' | 'stuck' | 'anomaly';

export interface SelfPerceptionResult {
  /** Interpretation of the visual comparison. */
  verdict: SelfPerceptionVerdict;
  /** Normalized visual delta: 0.0 = identical, 1.0 = completely different. */
  delta: number;
  /** The opcode that was being verified. */
  opcode: number;
  /** Human-readable opcode name. */
  opcodeName: string;
  /** Threshold used for this decision. */
  threshold: number;
  /** Time between pre-frame and post-frame in ms. */
  timeDeltaMs: number;
  /** Timestamp of the result. */
  timestamp: number;
}

export interface SelfPerceptionConfig {
  /** Delta threshold below which motion commands are considered "no change" (default: 0.02). */
  stuckThreshold: number;
  /** Delta threshold above which a STOP is considered "anomaly" (default: 0.03). */
  anomalyThreshold: number;
  /** Resolution to downsample frames before comparison (default: 80x60). */
  compareWidth: number;
  compareHeight: number;
  /** Minimum ms between pre and post frame for valid comparison (default: 200). NC-014. */
  minTimeDeltaMs: number;
  /** Enable/disable the monitor (default: true). */
  enabled: boolean;
}

export const DEFAULT_SELF_PERCEPTION_CONFIG: SelfPerceptionConfig = {
  stuckThreshold: 0.02,
  anomalyThreshold: 0.03,
  compareWidth: 80,
  compareHeight: 60,
  minTimeDeltaMs: 200,
  enabled: true,
};

/** Opcodes that represent intentional robot motion. */
const MOTION_OPCODES: ReadonlySet<number> = new Set([
  Opcode.MOVE_FORWARD,
  Opcode.MOVE_BACKWARD,
  Opcode.TURN_LEFT,
  Opcode.TURN_RIGHT,
  Opcode.ROTATE_CW,
  Opcode.ROTATE_CCW,
]);

// =============================================================================
// Pure functions
// =============================================================================

/**
 * Compute normalized pixel-level visual delta between two JPEG frames.
 * Returns 0.0 for identical frames, 1.0 for maximally different.
 *
 * Decodes both JPEGs to grayscale, downsamples, then computes
 * Mean Absolute Difference / 255.
 */
export async function computeVisualDelta(
  preFrameBuffer: Buffer,
  postFrameBuffer: Buffer,
  width = 80,
  height = 60,
): Promise<number> {
  const [prePixels, postPixels] = await Promise.all([
    sharp(preFrameBuffer)
      .greyscale()
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer(),
    sharp(postFrameBuffer)
      .greyscale()
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer(),
  ]);

  const pixelCount = width * height;
  let totalDiff = 0;
  for (let i = 0; i < pixelCount; i++) {
    totalDiff += Math.abs(prePixels[i] - postPixels[i]);
  }

  return totalDiff / (pixelCount * 255);
}

/**
 * Interpret a visual delta given the command type.
 *
 * Motion commands: low delta = 'stuck', else 'coherent'.
 * Non-motion commands: high delta = 'anomaly', else 'coherent'.
 */
export function interpretDelta(
  delta: number,
  opcode: number,
  config: SelfPerceptionConfig,
): SelfPerceptionVerdict {
  if (MOTION_OPCODES.has(opcode)) {
    return delta < config.stuckThreshold ? 'stuck' : 'coherent';
  }
  return delta > config.anomalyThreshold ? 'anomaly' : 'coherent';
}

// =============================================================================
// Calibration
// =============================================================================

/**
 * Calibrate the noise floor from stationary frame pairs.
 * Returns max observed noise and a recommended threshold (1.5x margin).
 */
export async function calibrateNoiseFloor(
  framePairs: Array<{ pre: Buffer; post: Buffer }>,
  width = 80,
  height = 60,
): Promise<{ noiseFloor: number; recommendedThreshold: number }> {
  const deltas = await Promise.all(
    framePairs.map(p => computeVisualDelta(p.pre, p.post, width, height)),
  );
  const maxNoise = Math.max(...deltas);
  const recommendedThreshold = maxNoise * 1.5;

  logger.info('SelfPerception', `Calibration: max noise=${maxNoise.toFixed(4)}, recommended threshold=${recommendedThreshold.toFixed(4)}`);
  return { noiseFloor: maxNoise, recommendedThreshold };
}

// =============================================================================
// SelfPerceptionMonitor — stateful integration with VisionLoop
// =============================================================================

export class SelfPerceptionMonitor {
  private config: SelfPerceptionConfig;

  /** The frame captured at the moment the last bytecode was sent. */
  private preCommandFrame: Buffer | null = null;
  private preCommandTimestamp = 0;
  private lastCommandOpcode = 0;

  /** Running stats. */
  private stats = {
    comparisons: 0,
    stuckDetections: 0,
    anomalyDetections: 0,
    skipped: 0,
    avgDelta: 0,
  };

  /** Consecutive stuck count for multi-frame confirmation (NC-015). */
  private consecutiveStuck = 0;
  private static readonly CONSECUTIVE_STUCK_THRESHOLD = 2;

  constructor(config: Partial<SelfPerceptionConfig> = {}) {
    this.config = { ...DEFAULT_SELF_PERCEPTION_CONFIG, ...config };
  }

  /**
   * Record the pre-command frame. Called immediately before transmitting bytecode.
   */
  recordPreCommandFrame(frameBase64: string, opcode: number): void {
    if (!this.config.enabled) return;
    this.preCommandFrame = Buffer.from(frameBase64, 'base64');
    this.preCommandTimestamp = Date.now();
    this.lastCommandOpcode = opcode;
  }

  /**
   * Compare the post-command frame against the stored pre-command frame.
   * Called when the next frame arrives after bytecode transmission.
   *
   * Returns null if comparison cannot be performed (no pre-frame, disabled, too soon).
   */
  async comparePostFrame(postFrameBase64: string): Promise<SelfPerceptionResult | null> {
    if (!this.config.enabled || !this.preCommandFrame) {
      return null;
    }

    const timeDelta = Date.now() - this.preCommandTimestamp;

    // NC-014: skip if frames are too close (robot hasn't settled)
    if (timeDelta < this.config.minTimeDeltaMs) {
      this.stats.skipped++;
      return null;
    }

    const postFrameBuffer = Buffer.from(postFrameBase64, 'base64');

    const delta = await computeVisualDelta(
      this.preCommandFrame,
      postFrameBuffer,
      this.config.compareWidth,
      this.config.compareHeight,
    );

    const verdict = interpretDelta(delta, this.lastCommandOpcode, this.config);

    this.stats.comparisons++;
    this.stats.avgDelta =
      (this.stats.avgDelta * (this.stats.comparisons - 1) + delta) / this.stats.comparisons;

    if (verdict === 'stuck') {
      this.consecutiveStuck++;
      this.stats.stuckDetections++;
    } else {
      this.consecutiveStuck = 0;
    }

    if (verdict === 'anomaly') {
      this.stats.anomalyDetections++;
    }

    // Consume pre-command frame
    this.preCommandFrame = null;

    const result: SelfPerceptionResult = {
      verdict,
      delta,
      opcode: this.lastCommandOpcode,
      opcodeName: OPCODE_NAMES[this.lastCommandOpcode] ?? `0x${this.lastCommandOpcode.toString(16)}`,
      threshold: this.config.stuckThreshold,
      timeDeltaMs: timeDelta,
      timestamp: Date.now(),
    };

    logger.debug('SelfPerception', `${result.opcodeName} → delta=${delta.toFixed(4)} → ${verdict}`, {
      timeDeltaMs: timeDelta,
      consecutiveStuck: this.consecutiveStuck,
    });

    return result;
  }

  /**
   * True if the robot has been visually stuck for 2+ consecutive frames.
   * Reduces false positives from single-frame noise (NC-015).
   */
  isConfirmedStuck(): boolean {
    return this.consecutiveStuck >= SelfPerceptionMonitor.CONSECUTIVE_STUCK_THRESHOLD;
  }

  /** Reset consecutive stuck counter (e.g., after recovery action). */
  resetStuckCounter(): void {
    this.consecutiveStuck = 0;
  }

  getConsecutiveStuck(): number {
    return this.consecutiveStuck;
  }

  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  getConfig(): SelfPerceptionConfig {
    return { ...this.config };
  }

  /** Update thresholds at runtime (e.g., after calibration). */
  updateConfig(patch: Partial<SelfPerceptionConfig>): void {
    Object.assign(this.config, patch);
  }
}
