/**
 * PerceptionPolicy — Strategy pattern for VisionLoop's frame processing
 *
 * Two implementations:
 *   1. VLMMotorPolicy (default) — Current behavior: VLM sees frame → outputs
 *      motor command → compiled to bytecode. Byte-for-byte identical to the
 *      original VisionLoop.processFrame() path.
 *
 *   2. SceneGraphPolicy — New scene-graph path: VLM sees frame → outputs
 *      JSON bounding boxes → projected into SceneGraph → ReactiveController
 *      decides motor command deterministically.
 *
 * The VisionLoop delegates to whichever policy is active. Everything
 * downstream (transmission, tracing, stuck detection, events) is unchanged.
 */

// =============================================================================
// Types
// =============================================================================

/** Snapshot of current robot telemetry, passed to the policy each frame. */
export interface TelemetrySnapshot {
  pose: { x: number; y: number; h: number };
  targetDist?: number;
  targetBearing?: number;
}

/** Result returned by a policy's processFrame(). */
export interface PerceptionPolicyResult {
  /** 6-byte bytecode frame, or null if compilation failed. */
  bytecode: Buffer | null;
  /** Raw text output from the VLM (for logging/tracing). */
  vlmOutput: string;
  /** Optional metadata for diagnostics (e.g., object count, controller action). */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Interface
// =============================================================================

export interface PerceptionPolicy {
  /**
   * Process one or more camera frames and produce a motor bytecode.
   *
   * @param frameBase64s  Base64-encoded JPEG frames (oldest→newest)
   * @param goal          Current navigation goal (human-readable text)
   * @param telemetry     Latest telemetry snapshot, or null if unavailable
   * @param constraints   Active strategy constraints to append to prompt
   */
  processFrame(
    frameBase64s: string[],
    goal: string,
    telemetry: TelemetrySnapshot | null,
    constraints: string[],
  ): Promise<PerceptionPolicyResult>;
}
