/**
 * Sim3DTraceCollector — Captures camera-based navigation traces from VisionLoop
 *
 * Hooks into VisionLoop events to collect frame-by-frame action data during
 * 3D simulation runs. Posts consolidated traces to evolving-memory server
 * for dream consolidation and training data export.
 *
 * Optionally asks the VLM to describe the scene as text after each frame,
 * enabling gap analysis between camera-based and text-only input.
 */

import { MemoryClient, type TraceAction, type IngestTraceRequest, type IngestTraceResponse } from '../llmunix-core/memory_client';
import { HierarchyLevel, TraceOutcome } from '../llmunix-core/types';
import type { VisionLoop } from '../2_qwen_cerebellum/vision_loop';
import type { InferenceFunction } from '../llmunix-core/interfaces';
import { logger } from '../shared/logger';

// =============================================================================
// Types
// =============================================================================

export interface Sim3DTraceCollectorConfig {
  /** evolving-memory server URL (default: http://localhost:8420) */
  serverUrl?: string;
  /** Maximum actions to keep per trace (oldest get sampled out) */
  maxActions?: number;
  /** Ask VLM to describe what it sees as text (for gap analysis) */
  describeScene?: boolean;
}

/** A single frame capture during 3D sim navigation */
interface FrameCapture {
  timestamp: number;
  /** The raw VLM output (e.g. "TOOLCALL:{...}") */
  vlmOutput: string;
  /** The compiled bytecode as hex string */
  bytecodeHex: string;
  /** Optional: VLM's text description of what it sees in the camera */
  sceneDescription?: string;
}

// =============================================================================
// Sim3DTraceCollector
// =============================================================================

export class Sim3DTraceCollector {
  private client: MemoryClient;
  private maxActions: number;
  private describeScene: boolean;
  private infer: InferenceFunction | null = null;

  private frames: FrameCapture[] = [];
  private goal: string = '';
  private startTime: number = 0;
  private outcome: TraceOutcome = TraceOutcome.UNKNOWN;
  private outcomeReason: string = '';
  private collecting = false;

  constructor(config: Sim3DTraceCollectorConfig = {}) {
    this.client = new MemoryClient(config.serverUrl ?? 'http://localhost:8420');
    this.maxActions = config.maxActions ?? 200;
    this.describeScene = config.describeScene ?? false;
  }

  /**
   * Set the inference function for scene description.
   * Required when describeScene is enabled.
   */
  setInferenceFunction(infer: InferenceFunction): void {
    this.infer = infer;
  }

  /**
   * Attach to a VisionLoop and start collecting.
   */
  attach(visionLoop: VisionLoop, goal: string): void {
    this.goal = goal;
    this.startTime = Date.now();
    this.frames = [];
    this.outcome = TraceOutcome.UNKNOWN;
    this.outcomeReason = '';
    this.collecting = true;

    // Collect every bytecode emission
    visionLoop.on('bytecode', this.onBytecode);

    // Detect arrival (success)
    visionLoop.on('arrival', this.onArrival);

    // Detect stuck (failure)
    visionLoop.on('stuck', this.onStuck);

    // Detect step timeout (failure)
    visionLoop.on('stepTimeout', this.onStepTimeout);

    logger.info('TraceCollector', `Attached — collecting traces for goal: "${goal}"`);
  }

  /**
   * Detach from VisionLoop and stop collecting.
   */
  detach(visionLoop: VisionLoop): void {
    this.collecting = false;
    visionLoop.off('bytecode', this.onBytecode);
    visionLoop.off('arrival', this.onArrival);
    visionLoop.off('stuck', this.onStuck);
    visionLoop.off('stepTimeout', this.onStepTimeout);
    logger.info('TraceCollector', `Detached — ${this.frames.length} frames collected`);
  }

  /**
   * Post the collected trace to evolving-memory.
   * Returns null if no frames were collected.
   */
  async postTrace(): Promise<IngestTraceResponse | null> {
    if (this.frames.length === 0) {
      logger.warn('TraceCollector', 'No frames to post');
      return null;
    }

    const actions = this.buildActions();
    const durationMs = Date.now() - this.startTime;
    const confidence = this.outcome === TraceOutcome.SUCCESS ? 0.9 : 0.3;

    const req: IngestTraceRequest = {
      goal: this.goal,
      hierarchyLevel: HierarchyLevel.GOAL,
      outcome: this.mapOutcome(this.outcome),
      confidence,
      source: 'sim_3d', // lowercase for Python server
      actions,
      tags: [
        'sim3d',
        `frames:${this.frames.length}`,
        `duration:${Math.round(durationMs / 1000)}s`,
        ...(this.describeScene ? ['scene_described'] : []),
      ],
    };

    const response = await this.client.ingestTrace(req);
    logger.info('TraceCollector', `Posted trace ${response.trace_id} (${this.frames.length} actions, outcome=${this.outcome})`);
    return response;
  }

  /**
   * Mark outcome externally (e.g. from physics-based goal confirmation).
   */
  setOutcome(outcome: TraceOutcome, reason: string): void {
    this.outcome = outcome;
    this.outcomeReason = reason;
  }

  /**
   * Get collected scene descriptions for gap analysis.
   */
  getSceneDescriptions(): Array<{ timestamp: number; vlmOutput: string; sceneDescription: string }> {
    return this.frames
      .filter(f => f.sceneDescription)
      .map(f => ({
        timestamp: f.timestamp,
        vlmOutput: f.vlmOutput,
        sceneDescription: f.sceneDescription!,
      }));
  }

  /**
   * Get summary stats.
   */
  getSummary(): { frames: number; outcome: string; durationMs: number; descriptionsCollected: number } {
    return {
      frames: this.frames.length,
      outcome: this.outcome,
      durationMs: Date.now() - this.startTime,
      descriptionsCollected: this.frames.filter(f => f.sceneDescription).length,
    };
  }

  // ---------------------------------------------------------------------------
  // Event handlers (bound to preserve `this`)
  // ---------------------------------------------------------------------------

  private onBytecode = async (bytecode: Buffer, vlmOutput: string): Promise<void> => {
    if (!this.collecting) return;

    const capture: FrameCapture = {
      timestamp: Date.now(),
      vlmOutput: vlmOutput || '',
      bytecodeHex: bytecode.toString('hex'),
    };

    // Optionally ask the VLM to describe the scene
    if (this.describeScene && this.infer) {
      try {
        const description = await this.describeCurrentScene();
        if (description) {
          capture.sceneDescription = description;
        }
      } catch (err) {
        logger.warn('TraceCollector', 'Scene description failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.frames.push(capture);

    // Trim if over limit (keep first, last, and sample middle)
    if (this.frames.length > this.maxActions * 1.5) {
      this.sampleFrames();
    }
  };

  private onArrival = (_vlmOutput: string): void => {
    if (this.outcome === TraceOutcome.UNKNOWN) {
      this.outcome = TraceOutcome.SUCCESS;
      this.outcomeReason = 'Arrival detected';
    }
  };

  private onStuck = (_vlmOutput: string): void => {
    // Don't override SUCCESS
    if (this.outcome === TraceOutcome.UNKNOWN) {
      this.outcome = TraceOutcome.FAILURE;
      this.outcomeReason = 'Stuck: low entropy motor pattern';
    }
  };

  private onStepTimeout = (_elapsed: number): void => {
    if (this.outcome === TraceOutcome.UNKNOWN) {
      this.outcome = TraceOutcome.FAILURE;
      this.outcomeReason = 'Step timeout';
    }
  };

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Ask the VLM to describe what it sees in text form.
   * Uses the latest frame from the VisionLoop.
   */
  private async describeCurrentScene(): Promise<string | null> {
    if (!this.infer) return null;

    const describePrompt =
      'Describe what you see in this camera frame as a detailed text scene description. ' +
      'Include: objects visible (color, shape, size, approximate distance), ' +
      'spatial layout (what is left/right/center/far), obstacles, open paths, ' +
      'and any target objects. Be specific about distances and positions. ' +
      'Output ONLY the description, no motor commands.';

    // We don't pass images here — the VLM is called separately with just text
    // The actual scene description needs the frame, but we're in the bytecode handler
    // which fires AFTER inference. Instead, we'll do a lightweight text-only request.
    // For gap analysis, we sample every Nth frame via a separate call in run_sim3d.ts
    return null; // Placeholder — actual implementation is in run_sim3d.ts describe loop
  }

  /**
   * Build TraceAction[] from collected frames.
   */
  private buildActions(): TraceAction[] {
    let frames = this.frames;

    // Sample if too many
    if (frames.length > this.maxActions) {
      this.sampleFrames();
      frames = this.frames;
    }

    return frames.map(f => ({
      reasoning: f.sceneDescription ?? `[camera frame at ${new Date(f.timestamp).toISOString()}]`,
      actionPayload: f.vlmOutput,
      result: `bytecode=${f.bytecodeHex}`,
    }));
  }

  /**
   * Downsample frames to maxActions, keeping first and last.
   */
  private sampleFrames(): void {
    if (this.frames.length <= this.maxActions) return;

    const first = this.frames[0];
    const last = this.frames[this.frames.length - 1];
    const middle = this.frames.slice(1, -1);

    const sampleRate = Math.ceil(middle.length / (this.maxActions - 2));
    const sampled = middle.filter((_, i) => i % sampleRate === 0);

    this.frames = [first, ...sampled, last];
  }

  /**
   * Map TraceOutcome to lowercase string for Python server.
   */
  private mapOutcome(outcome: TraceOutcome): string {
    switch (outcome) {
      case TraceOutcome.SUCCESS: return 'success';
      case TraceOutcome.FAILURE: return 'failure';
      case TraceOutcome.PARTIAL: return 'partial';
      case TraceOutcome.ABORTED: return 'aborted';
      default: return 'unknown';
    }
  }
}
