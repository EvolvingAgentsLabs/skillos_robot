/**
 * Trace Poster — Writes dream simulation results as local .md trace files
 *
 * Converts ScenarioResults into markdown trace files with YAML frontmatter,
 * following the same pattern as HierarchicalTraceLogger and Sim3DTraceCollector.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TraceOutcome } from '../../../llmunix-core/types';
import type { ScenarioResult, FrameLogEntry } from './scenario_runner';

// =============================================================================
// Types
// =============================================================================

export interface TracePosterConfig {
  /** Directory for dream sim trace output (default: traces/dream_sim) */
  tracesDir?: string;
  /** Maximum actions per trace (sampling if over) */
  maxActionsPerTrace?: number;
}

// =============================================================================
// TracePoster
// =============================================================================

export class TracePoster {
  private tracesDir: string;
  private maxActions: number;

  constructor(config: TracePosterConfig = {}) {
    this.tracesDir = config.tracesDir ?? path.join(process.cwd(), 'traces', 'dream_sim');
    this.maxActions = config.maxActionsPerTrace ?? 100;
  }

  /**
   * Write a ScenarioResult as a local .md trace file.
   * Returns the file path.
   */
  writeResult(result: ScenarioResult): string {
    const actions = this.buildActions(result.frameLog);
    const outcome = this.mapOutcome(result.outcome);
    const confidence = result.goalReached ? 0.8 : 0.3;

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toISOString().split('T')[1].split('.')[0].replace(/:/g, '-');
    const scenarioSlug = result.scenarioId.replace(/[^a-z0-9_-]/gi, '-').slice(0, 30);
    const filename = `${dateStr}_${timeStr}_${scenarioSlug}.md`;
    const tracePath = path.join(this.tracesDir, filename);

    // Ensure directory exists
    if (!fs.existsSync(this.tracesDir)) {
      fs.mkdirSync(this.tracesDir, { recursive: true });
    }

    const lines: string[] = [
      '---',
      `timestamp: "${now.toISOString()}"`,
      `goal: "[DREAM] ${result.title.replace(/"/g, '\\"')}"`,
      `outcome: ${outcome}`,
      `source: dream_text`,
      `fidelity: 0.3`,
      `confidence: ${confidence}`,
      `scenario_id: "${result.scenarioId}"`,
      `inference_mode: "${result.inferenceMode}"`,
      `frames: ${result.framesExecuted}`,
      `duration_ms: ${result.durationMs}`,
      `collisions: ${result.collisionCount}`,
      `goal_reached: ${result.goalReached}`,
      `tags: [distill, scenario:${result.scenarioId}, mode:${result.inferenceMode}]`,
      '---',
      '',
      `# Dream Sim Trace: ${result.title}`,
      '',
      `**Outcome**: ${outcome} | **Goal Reached**: ${result.goalReached}`,
      `**Duration**: ${Math.round(result.durationMs / 1000)}s | **Frames**: ${result.framesExecuted} | **Collisions**: ${result.collisionCount}`,
      '',
      '## Actions',
      '',
    ];

    for (const action of actions) {
      lines.push(`- **Scene**: ${action.sceneText.slice(0, 120)}`);
      lines.push(`  **VLM**: ${action.vlmOutput}`);
      lines.push(`  **Result**: ${action.result}`);
      lines.push('');
    }

    lines.push('---');

    fs.writeFileSync(tracePath, lines.join('\n'));
    return tracePath;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Convert FrameLogEntry[] to action summaries.
   * Samples if over maxActions to keep traces manageable.
   */
  private buildActions(frameLog: FrameLogEntry[]): Array<{ sceneText: string; vlmOutput: string; result: string }> {
    let frames = frameLog;

    // Sample if too many frames
    if (frames.length > this.maxActions) {
      const sampleRate = Math.ceil(frames.length / this.maxActions);
      frames = frames.filter((_, i) => i % sampleRate === 0 || i === frameLog.length - 1);
    }

    return frames.map(f => ({
      sceneText: f.sceneText,
      vlmOutput: f.vlmOutput,
      result: `pose=(${f.pose.x.toFixed(1)},${f.pose.y.toFixed(1)},${f.pose.heading.toFixed(1)}) dist=${f.targetDistance?.toFixed(1) ?? '?'}cm collision=${f.collision}`,
    }));
  }

  /**
   * Map TypeScript uppercase TraceOutcome to lowercase values.
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
