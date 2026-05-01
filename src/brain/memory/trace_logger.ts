/**
 * RoClaw Trace Logger — Records physical experiences to markdown
 *
 * Extends the core HierarchicalTraceLogger with RoClaw-specific formatting:
 * - Uses YAML frontmatter + markdown body (v2 schema)
 * - Supports appendBytecode() for Buffer-based bytecode logging
 * - Schema validation on write
 */

import * as fs from 'fs';
import * as path from 'path';
import { formatHex } from '../../control/bytecode_compiler';
import { logger } from '../../shared/logger';
import {
  HierarchyLevel,
  TraceOutcome,
  TraceSource,
  type HierarchicalTraceEntry,
  type ActionEntry,
} from '../../llmunix-core/types';
import {
  HierarchicalTraceLogger as CoreTraceLogger,
  type StartTraceOptions,
} from '../../llmunix-core/trace_logger';
import { type BytecodeEntry, actionToBytecode } from './trace_types';

const TRACES_DIR = path.join(__dirname, 'traces');

// Re-export StartTraceOptions for backward compat
export type { StartTraceOptions } from '../../llmunix-core/trace_logger';

// =============================================================================
// Trace Schema Validation (Phase 4c)
// =============================================================================

export interface TraceSchema {
  timestamp: string;    // ISO 8601
  goal: string;         // Non-empty
  outcome: string;      // 'success' | 'failure' | 'unknown' | 'timeout'
  source: string;       // 'real_world' | 'sim_3d' | 'sim_2d' | 'dream_text'
  fidelity: number;     // 0.0–1.0
  frames: number;       // >= 0
  duration_ms: number;  // >= 0
}

const VALID_OUTCOMES = ['success', 'failure', 'unknown', 'timeout', 'partial', 'aborted'];
const VALID_SOURCES = ['real_world', 'sim_3d', 'sim_2d', 'dream_text', 'dream_sim'];

/**
 * Validate a trace's frontmatter against the v2 schema.
 * Returns an array of validation errors (empty = valid).
 */
export function validateTraceSchema(meta: Partial<TraceSchema>): string[] {
  const errors: string[] = [];

  if (!meta.timestamp || !/^\d{4}-\d{2}-\d{2}T/.test(meta.timestamp)) {
    errors.push('timestamp must be ISO 8601 format');
  }
  if (!meta.goal || meta.goal.trim().length === 0) {
    errors.push('goal must be non-empty');
  }
  if (!meta.outcome || !VALID_OUTCOMES.includes(meta.outcome)) {
    errors.push(`outcome must be one of: ${VALID_OUTCOMES.join(', ')}`);
  }
  if (!meta.source || !VALID_SOURCES.includes(meta.source)) {
    errors.push(`source must be one of: ${VALID_SOURCES.join(', ')}`);
  }
  if (meta.fidelity === undefined || meta.fidelity < 0 || meta.fidelity > 1) {
    errors.push('fidelity must be a number between 0.0 and 1.0');
  }
  if (meta.frames === undefined || meta.frames < 0) {
    errors.push('frames must be a non-negative integer');
  }
  if (meta.duration_ms === undefined || meta.duration_ms < 0) {
    errors.push('duration_ms must be a non-negative integer');
  }

  return errors;
}

// =============================================================================
// RoClaw Hierarchical Trace Logger (extends core)
// =============================================================================

/** Extended entry type with backward-compatible bytecodeEntries */
export interface RoClawTraceEntry extends HierarchicalTraceEntry {
  bytecodeEntries: BytecodeEntry[];
}

export class HierarchicalTraceLogger extends CoreTraceLogger {
  constructor(tracesDir?: string) {
    super(tracesDir ?? TRACES_DIR);
  }

  startTrace(
    level: HierarchyLevel,
    goal: string,
    opts?: StartTraceOptions,
  ): string {
    const traceId = super.startTrace(level, goal, opts);
    logger.debug('TraceLogger', `Started trace ${traceId} (L${level}): ${goal}`);
    return traceId;
  }

  appendBytecode(traceId: string, vlmOutput: string, bytecode: Buffer): void {
    const entry = this.activeTraces.get(traceId);
    if (!entry) {
      logger.warn('TraceLogger', `appendBytecode: unknown trace ${traceId} — action dropped`);
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
    logger.debug('TraceLogger', `Ending trace ${traceId}: ${outcome}`);
    super.endTrace(traceId, outcome, reason, confidence);
    logger.debug('TraceLogger', `Ended trace ${traceId}: ${outcome}`);
  }

  getActiveTrace(traceId: string): RoClawTraceEntry | undefined {
    const entry = this.activeTraces.get(traceId);
    if (!entry) return undefined;
    return {
      ...entry,
      bytecodeEntries: entry.actionEntries.map(actionToBytecode),
    };
  }

  // ---------------------------------------------------------------------------
  // Override writeTrace — v2 schema: YAML frontmatter + markdown body
  // ---------------------------------------------------------------------------

  protected writeTrace(entry: HierarchicalTraceEntry): void {
    if (!fs.existsSync(this.tracesDir)) {
      fs.mkdirSync(this.tracesDir, { recursive: true });
    }

    const source = entry.source && entry.source !== TraceSource.UNKNOWN_SOURCE
      ? entry.source
      : TraceSource.REAL_WORLD;
    const fidelity = source === TraceSource.REAL_WORLD ? 1.0
      : source === TraceSource.SIM_3D ? 0.8
      : source === TraceSource.SIM_2D ? 0.5
      : 0.3;
    const confidence = entry.confidence ?? (entry.outcome === TraceOutcome.SUCCESS ? 0.8 : 0.3);
    const outcome = (entry.outcome ?? 'unknown').toLowerCase();
    const durationMs = entry.durationMs ?? 0;
    const frames = entry.actionEntries.length;

    // Lowercase source for YAML (convention: real_world, sim_3d, etc.)
    const sourceLower = source.toLowerCase();

    // Schema validation
    const errors = validateTraceSchema({
      timestamp: entry.timestamp,
      goal: entry.goal,
      outcome,
      source: sourceLower,
      fidelity,
      frames,
      duration_ms: durationMs,
    });
    if (errors.length > 0) {
      logger.warn('TraceLogger', `Schema validation warnings: ${errors.join('; ')}`);
    }

    // Generate unique filename per trace (not grouped by date)
    const goalSlug = entry.goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const dateStr = entry.timestamp.split('T')[0];
    const timeStr = entry.timestamp.split('T')[1]?.split('.')[0]?.replace(/:/g, '-') ?? '00-00-00';
    const filename = `${dateStr}_${timeStr}_${goalSlug}.md`;
    const tracePath = path.join(this.tracesDir, filename);

    // Build YAML frontmatter + markdown body
    const lines: string[] = [
      '---',
      `timestamp: "${entry.timestamp}"`,
      `goal: "${entry.goal.replace(/"/g, '\\"')}"`,
      `outcome: ${outcome}`,
      `source: ${sourceLower}`,
      `fidelity: ${fidelity}`,
      `confidence: ${confidence}`,
      `frames: ${frames}`,
      `duration_ms: ${durationMs}`,
      `level: ${entry.hierarchyLevel}`,
      `trace_id: "${entry.traceId}"`,
    ];

    if (entry.parentTraceId) lines.push(`parent_trace_id: "${entry.parentTraceId}"`);
    if (entry.outcomeReason) lines.push(`outcome_reason: "${entry.outcomeReason.replace(/"/g, '\\"')}"`);
    if (entry.locationNode) lines.push(`location: "${entry.locationNode}"`);
    if (entry.activeStrategyId) lines.push(`strategy: "${entry.activeStrategyId}"`);

    lines.push('---');
    lines.push('');
    lines.push(`# Trace: ${entry.goal}`);
    lines.push('');

    if (entry.sceneDescription) {
      lines.push(`**Scene:** ${entry.sceneDescription}`);
      lines.push('');
    }

    lines.push('## Actions');
    lines.push('');
    lines.push('| Time | VLM Reasoning | Bytecode |');
    lines.push('|------|---------------|----------|');

    for (const action of entry.actionEntries) {
      const time = action.timestamp.split('T')[1]?.split('.')[0] ?? '';
      const reasoning = action.reasoning.replace(/\|/g, '\\|').slice(0, 80);
      const payload = action.actionPayload.replace(/\|/g, '\\|');
      lines.push(`| ${time} | ${reasoning} | \`${payload}\` |`);
    }

    lines.push('');
    lines.push('---');

    fs.writeFileSync(tracePath, lines.join('\n'));
    logger.info('TraceLogger', `Trace written: ${filename} (${frames} actions, outcome=${outcome})`);
  }
}

// =============================================================================
// Singleton for shared use
// =============================================================================

export const traceLogger = new HierarchicalTraceLogger();
