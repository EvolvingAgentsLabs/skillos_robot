/**
 * RoClaw Trace Logger — Records physical experiences to markdown
 *
 * Standalone implementation (previously extended core HierarchicalTraceLogger).
 * Local file logging for real-time robot traces. Use MemoryClient.ingestTrace()
 * to send traces to evolving-memory for dream consolidation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { formatHex } from '../2_qwen_cerebellum/bytecode_compiler';
import { logger } from '../shared/logger';
import {
  HierarchyLevel,
  TraceOutcome,
  TraceSource,
  type HierarchicalTraceEntry,
  type ActionEntry,
} from '../llmunix-core/types';
import { type BytecodeEntry, actionToBytecode } from './trace_types';

const TRACES_DIR = path.join(__dirname, 'traces');

// =============================================================================
// Types
// =============================================================================

export interface StartTraceOptions {
  parentTraceId?: string;
  locationNode?: string;
  sceneDescription?: string;
  activeStrategyId?: string;
  source?: TraceSource;
}

// =============================================================================
// Legacy v1 API (backward-compatible)
// =============================================================================

export function appendTrace(goal: string, vlmOutput: string, bytecode: Buffer): void {
  const date = new Date().toISOString().split('T')[0];
  const tracePath = path.join(TRACES_DIR, `trace_${date}.md`);

  const entry = `
### Time: ${new Date().toISOString()}
**Goal:** ${goal}
**VLM Reasoning:** ${vlmOutput.trim()}
**Compiled Bytecode:** \`${formatHex(bytecode)}\`
**Source:** ${TraceSource.REAL_WORLD}
---
`;

  if (!fs.existsSync(TRACES_DIR)) {
    fs.mkdirSync(TRACES_DIR, { recursive: true });
  }

  if (!fs.existsSync(tracePath)) {
    fs.writeFileSync(tracePath, `# Execution Traces: ${date}\n\n`);
  }

  fs.appendFileSync(tracePath, entry);
}

// =============================================================================
// RoClaw Hierarchical Trace Logger
// =============================================================================

/** Extended entry type with backward-compatible bytecodeEntries */
export interface RoClawTraceEntry extends HierarchicalTraceEntry {
  bytecodeEntries: BytecodeEntry[];
}

function generateTraceId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `tr_${ts}_${rand}`;
}

export class HierarchicalTraceLogger {
  protected tracesDir: string;
  private activeTraces = new Map<string, HierarchicalTraceEntry>();

  constructor(tracesDir?: string) {
    this.tracesDir = tracesDir ?? TRACES_DIR;
  }

  startTrace(
    level: HierarchyLevel,
    goal: string,
    opts?: StartTraceOptions,
  ): string {
    const traceId = generateTraceId();
    const entry: HierarchicalTraceEntry = {
      traceId,
      hierarchyLevel: level,
      parentTraceId: opts?.parentTraceId ?? null,
      timestamp: new Date().toISOString(),
      goal,
      locationNode: opts?.locationNode ?? null,
      sceneDescription: opts?.sceneDescription ?? null,
      activeStrategyId: opts?.activeStrategyId ?? null,
      source: opts?.source ?? TraceSource.REAL_WORLD,
      outcome: TraceOutcome.UNKNOWN,
      outcomeReason: null,
      durationMs: null,
      confidence: null,
      actionEntries: [],
    };
    this.activeTraces.set(traceId, entry);
    logger.debug('TraceLogger', `Started trace ${traceId} (L${level}): ${goal}`);
    return traceId;
  }

  appendAction(traceId: string, reasoning: string, actionPayload: string): void {
    const entry = this.activeTraces.get(traceId);
    if (!entry) return;
    entry.actionEntries.push({
      timestamp: new Date().toISOString(),
      reasoning,
      actionPayload,
    });
  }

  appendBytecode(traceId: string, vlmOutput: string, bytecode: Buffer): void {
    const entry = this.activeTraces.get(traceId);
    if (!entry) {
      logger.warn('TraceLogger', `appendBytecode: unknown trace ${traceId}, falling back to legacy`);
      appendTrace('(unknown trace)', vlmOutput, bytecode);
      return;
    }
    this.appendAction(traceId, vlmOutput, formatHex(bytecode));
  }

  endTrace(
    traceId: string,
    outcome: TraceOutcome,
    reason?: string,
    confidence?: number,
  ): void {
    const entry = this.activeTraces.get(traceId);
    if (!entry) {
      logger.warn('TraceLogger', `endTrace: unknown trace ${traceId}`);
      return;
    }
    logger.debug('TraceLogger', `Ending trace ${traceId}: ${outcome}`);
    entry.outcome = outcome;
    entry.outcomeReason = reason ?? null;
    entry.confidence = confidence ?? null;
    const startTime = new Date(entry.timestamp).getTime();
    entry.durationMs = Date.now() - startTime;
    this.activeTraces.delete(traceId);
    this.writeTrace(entry);
    logger.debug('TraceLogger', `Ended trace ${traceId}: ${outcome} (${entry.durationMs}ms)`);
  }

  getActiveTrace(traceId: string): RoClawTraceEntry | undefined {
    const entry = this.activeTraces.get(traceId);
    if (!entry) return undefined;
    return {
      ...entry,
      bytecodeEntries: entry.actionEntries.map(actionToBytecode),
    };
  }

  getActiveTraceCount(): number {
    return this.activeTraces.size;
  }

  appendTraceLegacy(goal: string, vlmOutput: string, bytecode: Buffer): void {
    appendTrace(goal, vlmOutput, bytecode);
  }

  // ---------------------------------------------------------------------------
  // Write trace to markdown file
  // ---------------------------------------------------------------------------

  protected writeTrace(entry: HierarchicalTraceEntry): void {
    const date = entry.timestamp.split('T')[0];
    const tracePath = path.join(this.tracesDir, `trace_${date}.md`);

    if (!fs.existsSync(this.tracesDir)) {
      fs.mkdirSync(this.tracesDir, { recursive: true });
    }

    if (!fs.existsSync(tracePath)) {
      fs.writeFileSync(tracePath, `# Execution Traces: ${date}\n\n`);
    }

    const lines: string[] = [
      '',
      `### Time: ${entry.timestamp}`,
      `**Trace ID:** ${entry.traceId}`,
      `**Level:** ${entry.hierarchyLevel}`,
    ];

    if (entry.parentTraceId) {
      lines.push(`**Parent:** ${entry.parentTraceId}`);
    }

    lines.push(`**Goal:** ${entry.goal}`);

    if (entry.locationNode) {
      lines.push(`**Location:** ${entry.locationNode}`);
    }
    if (entry.sceneDescription) {
      lines.push(`**Scene:** ${entry.sceneDescription}`);
    }
    if (entry.activeStrategyId) {
      lines.push(`**Strategy:** ${entry.activeStrategyId}`);
    }
    if (entry.source && entry.source !== TraceSource.UNKNOWN_SOURCE) {
      lines.push(`**Source:** ${entry.source}`);
    }

    lines.push(`**Outcome:** ${entry.outcome}`);

    if (entry.outcomeReason) {
      lines.push(`**Reason:** ${entry.outcomeReason}`);
    }
    if (entry.durationMs !== null) {
      lines.push(`**Duration:** ${entry.durationMs}ms`);
    }
    if (entry.confidence !== null) {
      lines.push(`**Confidence:** ${entry.confidence}`);
    }

    for (const action of entry.actionEntries) {
      lines.push(`**VLM Reasoning:** ${action.reasoning}`);
      lines.push(`**Compiled Bytecode:** \`${action.actionPayload}\``);
    }

    lines.push('---');
    lines.push('');

    fs.appendFileSync(tracePath, lines.join('\n'));
  }
}

// =============================================================================
// Singleton for shared use
// =============================================================================

export const traceLogger = new HierarchicalTraceLogger();
