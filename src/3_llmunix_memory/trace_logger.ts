/**
 * RoClaw Trace Logger — Records physical experiences to markdown
 *
 * Extends the core HierarchicalTraceLogger with RoClaw-specific behavior:
 * - appendBytecode() using formatHex + Buffer
 * - Legacy appendTrace() function
 * - VLM/Bytecode trace format for backward compatibility
 * - Singleton traceLogger instance
 */

import * as fs from 'fs';
import * as path from 'path';
import { formatHex } from '../2_qwen_cerebellum/bytecode_compiler';
import { logger } from '../shared/logger';
import {
  HierarchicalTraceLogger as CoreTraceLogger,
  type StartTraceOptions,
} from '../llmunix-core/trace_logger';
import {
  HierarchyLevel,
  TraceOutcome,
  TraceSource,
  type HierarchicalTraceEntry,
} from '../llmunix-core/types';
import { type BytecodeEntry, actionToBytecode } from './trace_types';

export { type StartTraceOptions } from '../llmunix-core/trace_logger';

const TRACES_DIR = path.join(__dirname, 'traces');

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

export class HierarchicalTraceLogger extends CoreTraceLogger {
  constructor(tracesDir?: string) {
    super(tracesDir ?? TRACES_DIR);
  }

  /**
   * Append a bytecode entry to an active trace (RoClaw-specific).
   */
  appendBytecode(traceId: string, vlmOutput: string, bytecode: Buffer): void {
    const entry = super.getActiveTrace(traceId);
    if (!entry) {
      logger.warn('TraceLogger', `appendBytecode: unknown trace ${traceId}, falling back to legacy`);
      appendTrace('(unknown trace)', vlmOutput, bytecode);
      return;
    }

    this.appendAction(traceId, vlmOutput, formatHex(bytecode));
  }

  /**
   * End a trace with an outcome. Overrides core to add logging.
   */
  endTrace(
    traceId: string,
    outcome: TraceOutcome,
    reason?: string,
    confidence?: number,
  ): void {
    const entry = super.getActiveTrace(traceId);
    if (!entry) {
      logger.warn('TraceLogger', `endTrace: unknown trace ${traceId}`);
      return;
    }
    logger.debug('TraceLogger', `Ending trace ${traceId}: ${outcome}`);
    super.endTrace(traceId, outcome, reason, confidence);
    logger.debug('TraceLogger', `Ended trace ${traceId}: ${outcome} (${entry.durationMs}ms)`);
  }

  /**
   * Start a new hierarchical trace. Overrides core to add logging.
   */
  startTrace(
    level: HierarchyLevel,
    goal: string,
    opts?: StartTraceOptions,
  ): string {
    const traceId = super.startTrace(level, goal, opts);
    logger.debug('TraceLogger', `Started trace ${traceId} (L${level}): ${goal}`);
    return traceId;
  }

  /**
   * Get an active trace entry with backward-compatible bytecodeEntries.
   */
  getActiveTrace(traceId: string): RoClawTraceEntry | undefined {
    const entry = super.getActiveTrace(traceId);
    if (!entry) return undefined;
    return {
      ...entry,
      bytecodeEntries: entry.actionEntries.map(actionToBytecode),
    };
  }

  /**
   * Legacy wrapper: append a single bytecode as a self-contained reactive trace.
   */
  appendTraceLegacy(goal: string, vlmOutput: string, bytecode: Buffer): void {
    appendTrace(goal, vlmOutput, bytecode);
  }

  // ---------------------------------------------------------------------------
  // Override writeTrace to use RoClaw's VLM/Bytecode format
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

    // Write action entries in RoClaw's VLM/Bytecode format for backward compat
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
