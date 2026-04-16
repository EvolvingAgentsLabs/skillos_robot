/**
 * Sim3DTraceCollector — Captures camera-based navigation traces from VisionLoop
 *
 * Hooks into VisionLoop events to collect frame-by-frame action data during
 * 3D simulation runs. Writes consolidated traces as local .md files
 * following the HierarchicalTraceLogger pattern.
 *
 * Optionally asks the VLM to describe the scene as text after each frame,
 * enabling gap analysis between camera-based and text-only input.
 */

import * as fs from 'fs';
import * as path from 'path';
import { HierarchyLevel, TraceOutcome } from '../llmunix-core/types';
import type { VisionLoop } from '../2_qwen_cerebellum/vision_loop';
import type { InferenceFunction } from '../llmunix-core/interfaces';
import type { SceneGraph } from './scene_graph';
import { serializeSceneGraph, countCollisionPredictions } from './roclaw_dream_adapter';
import { logger } from '../shared/logger';

// =============================================================================
// Types
// =============================================================================

export interface Sim3DTraceCollectorConfig {
  /** Directory for trace output (default: traces/sim3d) */
  tracesDir?: string;
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
  private tracesDir: string;
  private maxActions: number;
  private describeScene: boolean;
  private infer: InferenceFunction | null = null;

  private frames: FrameCapture[] = [];
  private goal: string = '';
  private startTime: number = 0;
  private outcome: TraceOutcome = TraceOutcome.UNKNOWN;
  private outcomeReason: string = '';
  private collecting = false;

  // Scene-graph snapshot support (PR-4)
  private sceneGraph: SceneGraph | null = null;
  private sceneSnapshots: Array<{ moment: string; timestamp: number; markdown: string; nodeCount: number; collisionsPredicted: number }> = [];

  constructor(config: Sim3DTraceCollectorConfig = {}) {
    this.tracesDir = config.tracesDir ?? path.join(process.cwd(), 'traces', 'sim3d');
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
   * Set a SceneGraph reference for snapshot capture at key moments.
   * When set, the trace will include scene-graph data in the YAML
   * frontmatter and a snapshot section in the markdown body.
   */
  setSceneGraph(graph: SceneGraph): void {
    this.sceneGraph = graph;
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
   * Write the collected trace as a local .md file.
   * Returns the file path, or null if no frames were collected.
   */
  writeTrace(): string | null {
    if (this.frames.length === 0) {
      logger.warn('TraceCollector', 'No frames to write');
      return null;
    }

    const actions = this.buildActions();
    const durationMs = Date.now() - this.startTime;
    const confidence = this.outcome === TraceOutcome.SUCCESS ? 0.9 : 0.3;
    const outcomeStr = this.mapOutcome(this.outcome);

    // Build goal slug for filename
    const goalSlug = this.goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toISOString().split('T')[1].split('.')[0].replace(/:/g, '-');
    const filename = `${dateStr}_${timeStr}_${goalSlug}.md`;
    const tracePath = path.join(this.tracesDir, filename);

    // Ensure directory exists
    if (!fs.existsSync(this.tracesDir)) {
      fs.mkdirSync(this.tracesDir, { recursive: true });
    }

    // Build markdown content with YAML frontmatter
    const lines: string[] = [
      '---',
      `timestamp: "${now.toISOString()}"`,
      `goal: "${this.goal.replace(/"/g, '\\"')}"`,
      `outcome: ${outcomeStr}`,
      `source: sim_3d`,
      `fidelity: 0.8`,
      `confidence: ${confidence}`,
      `frames: ${this.frames.length}`,
      `duration_ms: ${durationMs}`,
      `duration: "${Math.round(durationMs / 1000)}s"`,
      ...(this.outcomeReason ? [`outcome_reason: "${this.outcomeReason.replace(/"/g, '\\"')}"`] : []),
      ...(this.sceneSnapshots.length > 0 ? [
        `scene_nodes: ${this.sceneSnapshots[this.sceneSnapshots.length - 1].nodeCount}`,
        `collisions_predicted: ${this.sceneSnapshots[this.sceneSnapshots.length - 1].collisionsPredicted}`,
      ] : []),
      `tags: [sim3d, ${this.describeScene ? 'scene_described, ' : ''}${this.sceneSnapshots.length > 0 ? 'scene_graph, ' : ''}frames:${this.frames.length}]`,
      '---',
      '',
      `# Sim3D Trace: ${this.goal}`,
      '',
      `**Outcome**: ${outcomeStr}${this.outcomeReason ? ` (${this.outcomeReason})` : ''}`,
      `**Duration**: ${Math.round(durationMs / 1000)}s | **Frames**: ${this.frames.length} | **Confidence**: ${confidence}`,
      '',
      '## Actions',
      '',
    ];

    for (const action of actions) {
      lines.push(`### ${new Date(action.timestamp).toISOString()}`);
      lines.push(`**Reasoning:** ${action.reasoning}`);
      lines.push(`**Action:** ${action.actionPayload}`);
      lines.push(`**Result:** ${action.result}`);
      lines.push('');
    }

    // Scene-graph snapshots (PR-4)
    if (this.sceneSnapshots.length > 0) {
      lines.push('## Scene Graph Snapshots');
      lines.push('');
      for (const snap of this.sceneSnapshots) {
        lines.push(`### ${snap.moment} (${new Date(snap.timestamp).toISOString()})`);
        lines.push(`Nodes: ${snap.nodeCount} | Collisions predicted: ${snap.collisionsPredicted}`);
        lines.push('');
        lines.push(snap.markdown);
        lines.push('');
      }
    }

    lines.push('---');

    fs.writeFileSync(tracePath, lines.join('\n'));
    logger.info('TraceCollector', `Trace written to ${tracePath} (${this.frames.length} actions, outcome=${outcomeStr})`);
    return tracePath;
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
    this.snapshotSceneGraph('arrival');
  };

  private onStuck = (_vlmOutput: string): void => {
    // Don't override SUCCESS
    if (this.outcome === TraceOutcome.UNKNOWN) {
      this.outcome = TraceOutcome.FAILURE;
      this.outcomeReason = 'Stuck: low entropy motor pattern';
    }
    this.snapshotSceneGraph('stuck');
  };

  private onStepTimeout = (_elapsed: number): void => {
    if (this.outcome === TraceOutcome.UNKNOWN) {
      this.outcome = TraceOutcome.FAILURE;
      this.outcomeReason = 'Step timeout';
    }
    this.snapshotSceneGraph('timeout');
  };

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Snapshot the current SceneGraph state at a key moment.
   */
  private snapshotSceneGraph(moment: string): void {
    if (!this.sceneGraph) return;
    const nodeCount = this.sceneGraph.size() - 1; // exclude robot
    const collisionsPredicted = countCollisionPredictions(this.sceneGraph);
    this.sceneSnapshots.push({
      moment,
      timestamp: Date.now(),
      markdown: serializeSceneGraph(this.sceneGraph),
      nodeCount,
      collisionsPredicted,
    });
  }

  /**
   * Ask the VLM to describe what it sees in text form.
   */
  private async describeCurrentScene(): Promise<string | null> {
    if (!this.infer) return null;
    return null; // Placeholder — actual implementation is in run_sim3d.ts describe loop
  }

  /**
   * Build action entries from collected frames.
   */
  private buildActions(): Array<{ timestamp: number; reasoning: string; actionPayload: string; result: string }> {
    let frames = this.frames;

    // Sample if too many
    if (frames.length > this.maxActions) {
      this.sampleFrames();
      frames = this.frames;
    }

    return frames.map(f => ({
      timestamp: f.timestamp,
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
   * Map TraceOutcome to lowercase string.
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
