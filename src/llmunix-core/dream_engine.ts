/**
 * LLMunix Core — Dream Engine
 *
 * LLM-powered memory consolidation modeled on biological sleep phases:
 *
 * Phase 1 — Slow Wave Sleep: Replay traces, prune low-value, extract failure constraints.
 * Phase 2 — REM Sleep: Abstract successful traces into reusable strategies via LLM.
 * Phase 3 — Consolidation: Write strategies to disk, append journal, prune old traces.
 *
 * Domain-agnostic: all domain-specific behavior comes via DreamDomainAdapter.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  HierarchyLevel,
  TraceOutcome,
  TraceSource,
  TRACE_FIDELITY_WEIGHTS,
  type Strategy,
  type NegativeConstraint,
  type DreamJournalEntry,
  type ActionEntry,
} from './types';
import type { DreamDomainAdapter, InferenceFunction } from './interfaces';
import { StrategyStore } from './strategy_store';
import { parseJSONSafe } from './utils';

// =============================================================================
// Types
// =============================================================================

export interface ParsedTrace {
  timestamp: string;
  traceId: string | null;
  level: HierarchyLevel | null;
  parentTraceId: string | null;
  goal: string;
  /** Where this trace originated (real robot, 3D sim, dream, etc.) */
  source: TraceSource;
  outcome: TraceOutcome;
  outcomeReason: string | null;
  durationMs: number | null;
  confidence: number | null;
  strategyId: string | null;
  actions: ActionEntry[];
}

export interface TraceSequence {
  traces: ParsedTrace[];
  goal: string;
  outcome: TraceOutcome;
  score: number;
  level: HierarchyLevel;
  /** Dominant source of traces in this sequence */
  source: TraceSource;
  /** Fidelity weight derived from source (1.0 = real world, 0.3 = dream) */
  fidelityWeight: number;
}

export interface DreamConfig {
  traceBatchSize: number;
  traceWindowDays: number;
  traceRetentionDays: number;
  sequenceTimeWindowMs: number;
}

export interface DreamResult {
  tracesProcessed: number;
  strategiesCreated: Strategy[];
  strategiesUpdated: Strategy[];
  constraintsLearned: NegativeConstraint[];
  tracesPruned: number;
  journalEntry: DreamJournalEntry;
}

const DEFAULT_CONFIG: DreamConfig = {
  traceBatchSize: 10,
  traceWindowDays: 7,
  traceRetentionDays: 7,
  sequenceTimeWindowMs: 30_000,
};

// =============================================================================
// DreamEngine
// =============================================================================

export class DreamEngine {
  private adapter: DreamDomainAdapter;
  private infer: InferenceFunction;
  private store: StrategyStore;
  private tracesDir: string;
  private config: DreamConfig;

  constructor(opts: {
    adapter: DreamDomainAdapter;
    infer: InferenceFunction;
    store: StrategyStore;
    tracesDir: string;
    config?: Partial<DreamConfig>;
  }) {
    this.adapter = opts.adapter;
    this.infer = opts.infer;
    this.store = opts.store;
    this.tracesDir = opts.tracesDir;
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
  }

  /**
   * Run the full dream cycle. Returns a summary of what was learned.
   */
  async dream(): Promise<DreamResult> {
    console.log('=== Dream Engine — Memory Consolidation ===\n');

    // 1. Parse traces
    const lastDream = this.store.getLastDreamTimestamp();
    if (lastDream) {
      console.log(`Last dream session: ${lastDream}`);
    }

    const traces = this.parseTraceFiles(lastDream ?? undefined);
    if (traces.length === 0) {
      console.log('\nNo new traces to dream about.');
      return this.emptyResult();
    }

    // 2. Group into sequences
    const sequences = this.groupIntoSequences(traces);
    console.log(`Grouped into ${sequences.length} sequence(s)`);

    // 3. Score sequences
    const scored = this.scoreSequences(sequences);
    console.log(`Top sequences: ${scored.slice(0, 5).map(s => `${s.goal} (${s.score.toFixed(2)})`).join(', ')}`);

    // 4. Phase 1 — Slow Wave Sleep
    const { failureConstraints, prunedCount } = await this.slowWaveSleep(scored);

    // 5. Phase 2 — REM Sleep
    const { created, updated } = await this.remSleep(scored);

    // 6. Phase 3 — Consolidation
    const journalEntry = await this.consolidate(failureConstraints, created, updated, traces.length, prunedCount);

    console.log('\n=== Dream complete! ===');

    return {
      tracesProcessed: traces.length,
      strategiesCreated: created,
      strategiesUpdated: updated,
      constraintsLearned: failureConstraints,
      tracesPruned: prunedCount,
      journalEntry,
    };
  }

  // ---------------------------------------------------------------------------
  // Trace Parsing
  // ---------------------------------------------------------------------------

  parseTraceFiles(afterTimestamp?: string): ParsedTrace[] {
    if (!fs.existsSync(this.tracesDir)) {
      console.log('No traces directory found.');
      return [];
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.traceWindowDays);

    const files = fs.readdirSync(this.tracesDir)
      .filter(f => f.startsWith('trace_') && f.endsWith('.md'))
      .sort();

    if (files.length === 0) {
      console.log('No trace files found.');
      return [];
    }

    console.log(`Found ${files.length} trace file(s)`);
    const entries: ParsedTrace[] = [];

    for (const file of files) {
      const dateMatch = file.match(/trace_(\d{4}-\d{2}-\d{2})\.md/);
      if (dateMatch) {
        const fileDate = new Date(dateMatch[1]);
        if (fileDate < cutoffDate) continue;
      }

      const content = fs.readFileSync(path.join(this.tracesDir, file), 'utf-8');
      const blocks = content.split('---').filter(b => b.trim());

      for (const block of blocks) {
        const timestampMatch = block.match(/### Time:\s*(.+)/);
        const goalMatch = block.match(/\*\*Goal:\*\*\s*(.+)/);
        if (!timestampMatch || !goalMatch) continue;

        const timestamp = timestampMatch[1].trim();
        if (afterTimestamp && timestamp <= afterTimestamp) continue;

        const traceIdMatch = block.match(/\*\*Trace ID:\*\*\s*(.+)/);
        const levelMatch = block.match(/\*\*Level:\*\*\s*(\d+)/);
        const parentMatch = block.match(/\*\*Parent:\*\*\s*(.+)/);
        const outcomeMatch = block.match(/\*\*Outcome:\*\*\s*(.+)/);
        const reasonMatch = block.match(/\*\*Reason:\*\*\s*(.+)/);
        const durationMatch = block.match(/\*\*Duration:\*\*\s*(\d+)/);
        const confidenceMatch = block.match(/\*\*Confidence:\*\*\s*([\d.]+)/);
        const strategyMatch = block.match(/\*\*Strategy:\*\*\s*(.+)/);
        const sourceMatch = block.match(/\*\*Source:\*\*\s*(.+)/);

        // Parse actions — support both core (Reasoning/Action) and legacy (VLM/Bytecode) formats
        const actions: ActionEntry[] = [];

        // Core format
        const reasoningMatches = [...block.matchAll(/\*\*Reasoning:\*\*\s*(.+)/g)];
        const actionMatches = [...block.matchAll(/\*\*Action:\*\*\s*`(.+?)`/g)];

        // Legacy format (VLM/Bytecode)
        const vlmMatches = [...block.matchAll(/\*\*VLM Reasoning:\*\*\s*(.+)/g)];
        const bcMatches = [...block.matchAll(/\*\*Compiled Bytecode:\*\*\s*`(.+?)`/g)];

        if (reasoningMatches.length > 0 || actionMatches.length > 0) {
          for (let i = 0; i < Math.max(reasoningMatches.length, actionMatches.length); i++) {
            actions.push({
              timestamp: timestamp,
              reasoning: reasoningMatches[i]?.[1]?.trim() || '',
              actionPayload: actionMatches[i]?.[1]?.trim() || '',
            });
          }
        } else if (vlmMatches.length > 0 || bcMatches.length > 0) {
          const vlmArr = vlmMatches.map(m => m[1].trim());
          const bcArr = bcMatches.map(m => m[1].trim());
          for (let i = 0; i < Math.max(vlmArr.length, bcArr.length); i++) {
            actions.push({
              timestamp: timestamp,
              reasoning: vlmArr[i] || '',
              actionPayload: bcArr[i] || '',
            });
          }
        }

        const outcomeStr = outcomeMatch ? outcomeMatch[1].trim() : 'UNKNOWN';
        const outcome = (Object.values(TraceOutcome) as string[]).includes(outcomeStr)
          ? outcomeStr as TraceOutcome
          : TraceOutcome.UNKNOWN;

        // Parse trace source (defaults to UNKNOWN for legacy traces)
        const sourceStr = sourceMatch ? sourceMatch[1].trim() : '';
        const source = (Object.values(TraceSource) as string[]).includes(sourceStr)
          ? sourceStr as TraceSource
          : TraceSource.UNKNOWN_SOURCE;

        entries.push({
          timestamp,
          traceId: traceIdMatch ? traceIdMatch[1].trim() : null,
          level: levelMatch ? parseInt(levelMatch[1], 10) as HierarchyLevel : null,
          parentTraceId: parentMatch ? parentMatch[1].trim() : null,
          goal: goalMatch[1].trim(),
          source,
          outcome,
          outcomeReason: reasonMatch ? reasonMatch[1].trim() : null,
          durationMs: durationMatch ? parseInt(durationMatch[1], 10) : null,
          confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : null,
          strategyId: strategyMatch ? strategyMatch[1].trim() : null,
          actions,
        });
      }
    }

    console.log(`Parsed ${entries.length} trace entries`);
    return entries;
  }

  // ---------------------------------------------------------------------------
  // Sequence Grouping
  // ---------------------------------------------------------------------------

  /**
   * Compute the dominant trace source for a group of traces.
   * Uses the highest-fidelity source present (real > 3d > 2d > dream).
   */
  private dominantSource(traces: ParsedTrace[]): TraceSource {
    const sources = traces.map(t => t.source);
    // Return the highest-fidelity source present in the group
    for (const src of [TraceSource.REAL_WORLD, TraceSource.SIM_3D, TraceSource.SIM_2D, TraceSource.DREAM_TEXT]) {
      if (sources.includes(src)) return src;
    }
    return TraceSource.UNKNOWN_SOURCE;
  }

  groupIntoSequences(traces: ParsedTrace[]): TraceSequence[] {
    const sequences: TraceSequence[] = [];
    const parentGroups = new Map<string, ParsedTrace[]>();
    const ungrouped: ParsedTrace[] = [];

    for (const trace of traces) {
      if (trace.parentTraceId) {
        const group = parentGroups.get(trace.parentTraceId) ?? [];
        group.push(trace);
        parentGroups.set(trace.parentTraceId, group);
      } else {
        ungrouped.push(trace);
      }
    }

    for (const [, group] of parentGroups) {
      const sorted = group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const hasFailure = sorted.some(t => t.outcome === TraceOutcome.FAILURE);
      const source = this.dominantSource(sorted);
      sequences.push({
        traces: sorted,
        goal: sorted[0].goal,
        outcome: hasFailure ? TraceOutcome.FAILURE : (
          sorted.some(t => t.outcome === TraceOutcome.SUCCESS) ? TraceOutcome.SUCCESS : TraceOutcome.UNKNOWN
        ),
        score: 0,
        level: sorted[0].level ?? HierarchyLevel.REACTIVE,
        source,
        fidelityWeight: TRACE_FIDELITY_WEIGHTS[source],
      });
    }

    const sortedUngrouped = ungrouped.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let currentGroup: ParsedTrace[] = [];
    let currentGoal = '';

    for (const trace of sortedUngrouped) {
      const isNewGroup = currentGroup.length === 0
        || trace.goal !== currentGoal
        || (new Date(trace.timestamp).getTime() - new Date(currentGroup[currentGroup.length - 1].timestamp).getTime()) > this.config.sequenceTimeWindowMs;

      if (isNewGroup && currentGroup.length > 0) {
        const hasFailure = currentGroup.some(t => t.outcome === TraceOutcome.FAILURE);
        const source = this.dominantSource(currentGroup);
        sequences.push({
          traces: currentGroup,
          goal: currentGoal,
          outcome: hasFailure ? TraceOutcome.FAILURE : (
            currentGroup.some(t => t.outcome === TraceOutcome.SUCCESS) ? TraceOutcome.SUCCESS : TraceOutcome.UNKNOWN
          ),
          score: 0,
          level: currentGroup[0].level ?? HierarchyLevel.REACTIVE,
          source,
          fidelityWeight: TRACE_FIDELITY_WEIGHTS[source],
        });
        currentGroup = [];
      }

      currentGroup.push(trace);
      currentGoal = trace.goal;
    }

    if (currentGroup.length > 0) {
      const hasFailure = currentGroup.some(t => t.outcome === TraceOutcome.FAILURE);
      const source = this.dominantSource(currentGroup);
      sequences.push({
        traces: currentGroup,
        goal: currentGoal,
        outcome: hasFailure ? TraceOutcome.FAILURE : (
          currentGroup.some(t => t.outcome === TraceOutcome.SUCCESS) ? TraceOutcome.SUCCESS : TraceOutcome.UNKNOWN
        ),
        score: 0,
        level: currentGroup[0].level ?? HierarchyLevel.REACTIVE,
        source,
        fidelityWeight: TRACE_FIDELITY_WEIGHTS[source],
      });
    }

    return sequences;
  }

  // ---------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------

  /**
   * Score sequences using fidelity-weighted formula.
   *
   * score = (avgConfidence * outcomeWeight * recencyBonus * fidelityWeight) / durationPenalty
   *
   * The fidelityWeight ensures real-world traces have higher influence on strategy
   * formation than dream simulations. A dream trace with score 0.3 is equivalent
   * to a real-world trace with score 0.3 * 0.3 = 0.09 in terms of influence.
   */
  scoreSequences(sequences: TraceSequence[]): TraceSequence[] {
    const now = Date.now();

    for (const seq of sequences) {
      const avgConfidence = seq.traces
        .filter(t => t.confidence !== null)
        .reduce((sum, t) => sum + (t.confidence ?? 0), 0) /
        Math.max(1, seq.traces.filter(t => t.confidence !== null).length) || 0.5;

      const outcomeWeight = seq.outcome === TraceOutcome.SUCCESS ? 1.0
        : seq.outcome === TraceOutcome.FAILURE ? 0.8
        : seq.outcome === TraceOutcome.PARTIAL ? 0.6
        : 0.3;

      const age = now - new Date(seq.traces[0].timestamp).getTime();
      const recencyBonus = Math.max(0.1, 1.0 - (age / (this.config.traceWindowDays * 86400_000)));

      const totalDuration = seq.traces.reduce((sum, t) => sum + (t.durationMs ?? 1000), 0);
      const durationPenalty = Math.max(1, totalDuration / 10_000);

      // Fidelity weight: real-world experiences score higher than dreams
      const fidelity = seq.fidelityWeight;

      seq.score = (avgConfidence * outcomeWeight * recencyBonus * fidelity) / durationPenalty;
    }

    return sequences.sort((a, b) => b.score - a.score);
  }

  // ---------------------------------------------------------------------------
  // Summarize a sequence (uses adapter for action compression)
  // ---------------------------------------------------------------------------

  summarizeSequence(seq: TraceSequence): string {
    const lines = [
      `Goal: ${seq.goal}`,
      `Outcome: ${seq.outcome}`,
      `Level: ${seq.level}`,
      `Source: ${seq.source} (fidelity: ${seq.fidelityWeight})`,
      `Traces: ${seq.traces.length}`,
    ];

    const allActions = seq.traces.flatMap(t => t.actions);
    lines.push(`Actions: ${this.adapter.compressActions(allActions)}`);

    if (seq.traces[0].outcomeReason) {
      lines.push(`Reason: ${seq.traces[0].outcomeReason}`);
    }

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Phase 1 — Slow Wave Sleep
  // ---------------------------------------------------------------------------

  private async slowWaveSleep(
    sequences: TraceSequence[],
  ): Promise<{ failureConstraints: NegativeConstraint[]; prunedCount: number }> {
    console.log('\n=== Phase 1: Slow Wave Sleep (Replay & Pruning) ===\n');

    const failureConstraints: NegativeConstraint[] = [];
    let prunedCount = 0;

    const failures = sequences.filter(s => s.outcome === TraceOutcome.FAILURE);
    console.log(`Analyzing ${failures.length} failure sequence(s)...`);

    for (const seq of failures.slice(0, this.config.traceBatchSize)) {
      const summary = this.summarizeSequence(seq);

      try {
        const response = await this.infer(
          this.adapter.failureAnalysisSystemPrompt,
          this.adapter.buildFailurePrompt(summary),
        );
        const parsed = parseJSONSafe<{ description: string; context: string; severity: string }>(response);

        if (parsed) {
          const constraint: NegativeConstraint = {
            description: parsed.description,
            context: parsed.context || 'general',
            severity: (parsed.severity || 'medium') as 'low' | 'medium' | 'high',
            learnedFrom: seq.traces.filter(t => t.traceId).map(t => t.traceId!),
          };
          failureConstraints.push(constraint);
          console.log(`  Learned: "${constraint.description}" (${constraint.severity})`);
        }
      } catch (err) {
        console.error(`  Failed to analyze sequence: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Remove low-value sequences from the list so they aren't processed in REM
    const toPrune = sequences.filter(s => s.score < 0.1 && s.outcome !== TraceOutcome.FAILURE);
    prunedCount = toPrune.length;
    for (const seq of toPrune) {
      const idx = sequences.indexOf(seq);
      if (idx >= 0) sequences.splice(idx, 1);
    }

    console.log(`Pruned ${prunedCount} low-value sequence(s)`);
    return { failureConstraints, prunedCount };
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — REM Sleep
  // ---------------------------------------------------------------------------

  private async remSleep(
    sequences: TraceSequence[],
  ): Promise<{ created: Strategy[]; updated: Strategy[] }> {
    console.log('\n=== Phase 2: REM Sleep (Strategy Abstraction) ===\n');

    const created: Strategy[] = [];
    const updated: Strategy[] = [];

    const successByLevel = new Map<HierarchyLevel, TraceSequence[]>();
    for (const seq of sequences) {
      if (seq.outcome !== TraceOutcome.SUCCESS && seq.outcome !== TraceOutcome.UNKNOWN) continue;
      if (seq.score < 0.1) continue;

      const group = successByLevel.get(seq.level) ?? [];
      group.push(seq);
      successByLevel.set(seq.level, group);
    }

    for (const [level, seqs] of successByLevel) {
      console.log(`Processing ${seqs.length} sequence(s) at Level ${level}...`);

      for (const seq of seqs.slice(0, this.config.traceBatchSize)) {
        const summary = this.summarizeSequence(seq);

        const existing = this.store.findStrategies(seq.goal, level);
        const bestMatch = existing.length > 0 ? existing[0] : null;

        if (bestMatch) {
          const existingSummary = [
            `Title: ${bestMatch.title}`,
            `Steps: ${bestMatch.steps.join(' → ')}`,
            `Trigger goals: ${bestMatch.triggerGoals.join(', ')}`,
          ].join('\n');

          try {
            const response = await this.infer(
              this.adapter.strategyMergeSystemPrompt,
              this.adapter.buildMergePrompt(existingSummary, summary),
            );
            const parsed = parseJSONSafe<{
              title: string;
              trigger_goals: string[];
              preconditions: string[];
              steps: string[];
              negative_constraints: string[];
              spatial_rules?: string[];
            }>(response);

            if (parsed) {
              const mergedStrategy: Strategy = {
                ...bestMatch,
                version: bestMatch.version + 1,
                title: parsed.title || bestMatch.title,
                triggerGoals: parsed.trigger_goals || bestMatch.triggerGoals,
                preconditions: parsed.preconditions || bestMatch.preconditions,
                steps: parsed.steps || bestMatch.steps,
                negativeConstraints: parsed.negative_constraints || bestMatch.negativeConstraints,
                spatialRules: parsed.spatial_rules || bestMatch.spatialRules,
                successCount: bestMatch.successCount + 1,
                // Fidelity-weighted confidence boost: real-world = +0.05, dream = +0.015
                confidence: Math.min(1.0, bestMatch.confidence + 0.05 * seq.fidelityWeight),
                sourceTraceIds: [
                  ...bestMatch.sourceTraceIds,
                  ...seq.traces.filter(t => t.traceId).map(t => t.traceId!),
                ].slice(-20),
              };
              updated.push(mergedStrategy);
              console.log(`  Updated: "${mergedStrategy.title}" (v${mergedStrategy.version})`);
            }
          } catch (err) {
            console.error(`  Failed to merge strategy: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          try {
            const response = await this.infer(
              this.adapter.strategyAbstractionSystemPrompt,
              this.adapter.buildAbstractionPrompt(summary, level),
            );
            const parsed = parseJSONSafe<{
              title: string;
              trigger_goals: string[];
              preconditions: string[];
              steps: string[];
              negative_constraints: string[];
              spatial_rules?: string[];
            }>(response);

            if (parsed && parsed.title && parsed.steps) {
              const slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
              // Initial confidence scaled by fidelity: real-world = 0.5, dream = 0.15
              const initialConfidence = 0.5 * seq.fidelityWeight;
              const newStrategy: Strategy = {
                id: `strat_${level}_${slug}`,
                version: 1,
                hierarchyLevel: level,
                title: parsed.title,
                preconditions: parsed.preconditions || [],
                triggerGoals: parsed.trigger_goals || [],
                steps: parsed.steps,
                negativeConstraints: parsed.negative_constraints || [],
                ...(parsed.spatial_rules?.length ? { spatialRules: parsed.spatial_rules } : {}),
                confidence: initialConfidence,
                successCount: 1,
                failureCount: 0,
                sourceTraceIds: seq.traces.filter(t => t.traceId).map(t => t.traceId!),
                deprecated: false,
              };
              created.push(newStrategy);
              console.log(`  Created: "${newStrategy.title}" (${newStrategy.id})`);
            }
          } catch (err) {
            console.error(`  Failed to create strategy: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    // Deprecate high-failure strategies
    for (const level of [HierarchyLevel.GOAL, HierarchyLevel.STRATEGY, HierarchyLevel.TACTICAL, HierarchyLevel.REACTIVE]) {
      const strategies = this.store.getStrategiesForLevel(level);
      for (const strat of strategies) {
        if (strat.failureCount > 3 && strat.failureCount > strat.successCount * 2) {
          strat.deprecated = true;
          this.store.saveStrategy(strat);
          console.log(`  Deprecated: "${strat.title}" (${strat.failureCount} failures)`);
        }
      }
    }

    return { created, updated };
  }

  // ---------------------------------------------------------------------------
  // Phase 3 — Consolidation
  // ---------------------------------------------------------------------------

  private async consolidate(
    failureConstraints: NegativeConstraint[],
    created: Strategy[],
    updated: Strategy[],
    totalTraces: number,
    prunedCount: number,
  ): Promise<DreamJournalEntry> {
    console.log('\n=== Phase 3: Consolidation ===\n');

    for (const strategy of created) {
      this.store.saveStrategy(strategy);
      console.log(`  Wrote: ${strategy.id}`);
    }

    for (const strategy of updated) {
      this.store.saveStrategy(strategy);
      console.log(`  Updated: ${strategy.id}`);
    }

    for (const constraint of failureConstraints) {
      this.store.saveNegativeConstraint(constraint);
    }
    if (failureConstraints.length > 0) {
      console.log(`  Wrote ${failureConstraints.length} negative constraint(s)`);
    }

    // Generate dream journal entry
    const journalPrompt = [
      `Dream session results:`,
      `- Traces processed: ${totalTraces}`,
      `- New strategies: ${created.map(s => s.title).join(', ') || 'none'}`,
      `- Updated strategies: ${updated.map(s => s.title).join(', ') || 'none'}`,
      `- Failure constraints: ${failureConstraints.map(c => c.description).join(', ') || 'none'}`,
      `- Traces pruned: ${prunedCount}`,
    ].join('\n');

    let summary = `Processed ${totalTraces} traces. Created ${created.length} strategies, updated ${updated.length}. Learned ${failureConstraints.length} constraints.`;
    try {
      summary = await this.infer(this.adapter.dreamSummarySystemPrompt, journalPrompt);
    } catch {
      // Keep default summary
    }

    const journalEntry: DreamJournalEntry = {
      timestamp: new Date().toISOString(),
      tracesProcessed: totalTraces,
      strategiesCreated: created.length,
      strategiesUpdated: updated.length,
      constraintsLearned: failureConstraints.length,
      tracesPruned: prunedCount,
      summary: summary.trim(),
    };

    this.store.appendDreamJournal(journalEntry);
    console.log(`\nDream journal: ${journalEntry.summary}`);

    // Prune old trace files
    const deletedCount = this.pruneOldTraces();
    if (deletedCount > 0) {
      console.log(`Deleted ${deletedCount} trace file(s) older than ${this.config.traceRetentionDays} days`);
    }

    return journalEntry;
  }

  private pruneOldTraces(): number {
    if (!fs.existsSync(this.tracesDir)) return 0;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.traceRetentionDays);
    let deleted = 0;

    const files = fs.readdirSync(this.tracesDir)
      .filter(f => f.startsWith('trace_') && f.endsWith('.md'));

    for (const file of files) {
      const dateMatch = file.match(/trace_(\d{4}-\d{2}-\d{2})\.md/);
      if (dateMatch) {
        const fileDate = new Date(dateMatch[1]);
        if (fileDate < cutoff) {
          fs.unlinkSync(path.join(this.tracesDir, file));
          deleted++;
        }
      }
    }

    return deleted;
  }

  private emptyResult(): DreamResult {
    return {
      tracesProcessed: 0,
      strategiesCreated: [],
      strategiesUpdated: [],
      constraintsLearned: [],
      tracesPruned: 0,
      journalEntry: {
        timestamp: new Date().toISOString(),
        tracesProcessed: 0,
        strategiesCreated: 0,
        strategiesUpdated: 0,
        constraintsLearned: 0,
        tracesPruned: 0,
        summary: 'No traces to process.',
      },
    };
  }
}
