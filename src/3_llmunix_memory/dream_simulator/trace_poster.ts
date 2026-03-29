/**
 * Trace Poster — Converts ScenarioResults to evolving-memory server format
 *
 * Wraps MemoryClient to convert dream simulation results into trace ingestion
 * requests compatible with the evolving-memory REST API.
 */

import { MemoryClient, type TraceAction, type IngestTraceRequest, type IngestTraceResponse } from '../../llmunix-core/memory_client';
import { HierarchyLevel, TraceOutcome, TraceSource } from '../../llmunix-core/types';
import type { ScenarioResult, FrameLogEntry } from './scenario_runner';

// =============================================================================
// Types
// =============================================================================

export interface TracePosterConfig {
  /** evolving-memory server URL */
  serverUrl?: string;
  /** Maximum actions per trace (sampling if over) */
  maxActionsPerTrace?: number;
}

// =============================================================================
// TracePoster
// =============================================================================

export class TracePoster {
  private client: MemoryClient;
  private maxActions: number;

  constructor(config: TracePosterConfig = {}) {
    this.client = new MemoryClient(config.serverUrl ?? 'http://localhost:8420');
    this.maxActions = config.maxActionsPerTrace ?? 100;
  }

  /**
   * Post a ScenarioResult as a trace to the evolving-memory server.
   */
  async postResult(result: ScenarioResult): Promise<IngestTraceResponse> {
    const actions = this.buildActions(result.frameLog);

    // Map TS uppercase enums to Python lowercase values
    const outcome = this.mapOutcome(result.outcome);
    const confidence = result.goalReached ? 0.8 : 0.3;

    const req: IngestTraceRequest = {
      goal: `[DREAM] ${result.title}`,
      hierarchyLevel: HierarchyLevel.GOAL,
      outcome,
      confidence,
      source: 'dream_text', // lowercase for Python server
      actions,
      tags: ['distill', `scenario:${result.scenarioId}`, `mode:${result.inferenceMode}`],
    };

    return this.client.ingestTrace(req);
  }

  /**
   * Check server health.
   */
  async health(): Promise<boolean> {
    try {
      await this.client.health();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Trigger dream consolidation for the robotics domain.
   */
  async runDream() {
    return this.client.runDream('robotics');
  }

  /**
   * Get server stats.
   */
  async stats() {
    return this.client.stats();
  }

  /**
   * Query learned strategies from the server.
   */
  async queryStrategies(goal: string) {
    return this.client.query(goal);
  }

  /**
   * Get node details (for extracting strategies/constraints after dreaming).
   */
  async getNode(nodeId: string) {
    return this.client.getNode(nodeId);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Convert FrameLogEntry[] to TraceAction[] for the server.
   * Samples if over maxActions to keep traces manageable.
   */
  private buildActions(frameLog: FrameLogEntry[]): TraceAction[] {
    let frames = frameLog;

    // Sample if too many frames
    if (frames.length > this.maxActions) {
      const sampleRate = Math.ceil(frames.length / this.maxActions);
      frames = frames.filter((_, i) => i % sampleRate === 0 || i === frameLog.length - 1);
    }

    return frames.map(f => ({
      reasoning: f.sceneText,
      actionPayload: f.vlmOutput,
      result: `pose=(${f.pose.x.toFixed(1)},${f.pose.y.toFixed(1)},${f.pose.heading.toFixed(1)}) dist=${f.targetDistance?.toFixed(1) ?? '?'}cm collision=${f.collision}`,
    }));
  }

  /**
   * Map TypeScript uppercase TraceOutcome to Python lowercase values.
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
