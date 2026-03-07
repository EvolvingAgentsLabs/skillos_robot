/**
 * LLMunix Core — Strategy Store
 *
 * Persistent storage and retrieval of hierarchical strategies.
 * Strategies are stored as markdown files with YAML-like frontmatter.
 *
 * Generic: directory names are configurable via LevelDirectoryConfig.
 * Default level dirs use generic names (level_1_goals, level_2_strategy, etc.).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  HierarchyLevel,
  type Strategy,
  type NegativeConstraint,
  type DreamJournalEntry,
} from './types';
import type { LevelDirectoryConfig } from './interfaces';

// =============================================================================
// Default Constants
// =============================================================================

const DEFAULT_LEVEL_DIRS: Record<HierarchyLevel, string> = {
  [HierarchyLevel.GOAL]: 'level_1_goals',
  [HierarchyLevel.STRATEGY]: 'level_2_strategy',
  [HierarchyLevel.TACTICAL]: 'level_3_tactical',
  [HierarchyLevel.REACTIVE]: 'level_4_reactive',
};

const CONSTRAINTS_FILE = '_negative_constraints.md';
const JOURNAL_FILE = '_dream_journal.md';
const SEEDS_DIR = '_seeds';

// =============================================================================
// YAML-like Frontmatter Parser
// =============================================================================

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) return { meta, body: content };

  const fmBlock = fmMatch[1];
  const body = fmMatch[2];

  for (const line of fmBlock.split('\n')) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (kv) {
      meta[kv[1].trim()] = kv[2].trim();
    }
  }

  return { meta, body };
}

function parseStringArray(value: string | undefined): string[] {
  if (!value) return [];
  const cleaned = value.replace(/^\[|\]$/g, '').trim();
  if (!cleaned) return [];
  return cleaned.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

export function strategyFromMarkdown(content: string, filePath: string): Strategy | null {
  try {
    const { meta, body } = parseFrontmatter(content);

    const id = meta.id || path.basename(filePath, '.md');
    const level = parseInt(meta.level || '4', 10) as HierarchyLevel;

    // Parse steps from body: numbered list items
    const steps: string[] = [];
    const stepRegex = /^\d+\.\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = stepRegex.exec(body)) !== null) {
      steps.push(match[1].trim());
    }

    // Parse negative constraints from body
    const negatives: string[] = [];
    const negSection = body.match(/## (?:Negative Constraints|Don't|Avoid)([\s\S]*?)(?=\n## |\n$|$)/i);
    if (negSection) {
      const negRegex = /^[-*]\s+(.+)$/gm;
      while ((match = negRegex.exec(negSection[1])) !== null) {
        negatives.push(match[1].trim());
      }
    }

    // Parse spatial rules from body
    const spatialRules: string[] = [];
    const spatialSection = body.match(/## Spatial Rules([\s\S]*?)(?=\n## |\n$|$)/i);
    if (spatialSection) {
      const spatialRegex = /^[-*]\s+(.+)$/gm;
      while ((match = spatialRegex.exec(spatialSection[1])) !== null) {
        spatialRules.push(match[1].trim());
      }
    }

    return {
      id,
      version: parseInt(meta.version || '1', 10),
      hierarchyLevel: level,
      title: meta.title || id,
      preconditions: parseStringArray(meta.preconditions),
      triggerGoals: parseStringArray(meta.trigger_goals),
      steps,
      negativeConstraints: negatives,
      confidence: parseFloat(meta.confidence || '0.5'),
      successCount: parseInt(meta.success_count || '0', 10),
      failureCount: parseInt(meta.failure_count || '0', 10),
      sourceTraceIds: parseStringArray(meta.source_traces),
      deprecated: meta.deprecated === 'true',
      ...(spatialRules.length > 0 ? { spatialRules } : {}),
    };
  } catch (err) {
    console.warn(`[StrategyStore] Failed to parse strategy: ${filePath}`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function strategyToMarkdown(strategy: Strategy): string {
  const lines: string[] = [
    '---',
    `id: ${strategy.id}`,
    `version: ${strategy.version}`,
    `level: ${strategy.hierarchyLevel}`,
    `title: ${strategy.title}`,
    `trigger_goals: [${strategy.triggerGoals.map(g => `"${g}"`).join(', ')}]`,
    `preconditions: [${strategy.preconditions.map(p => `"${p}"`).join(', ')}]`,
    `confidence: ${strategy.confidence}`,
    `success_count: ${strategy.successCount}`,
    `failure_count: ${strategy.failureCount}`,
    `source_traces: [${strategy.sourceTraceIds.map(t => `"${t}"`).join(', ')}]`,
    `deprecated: ${strategy.deprecated}`,
    '---',
    '',
    `# ${strategy.title}`,
    '',
    '## Steps',
    '',
    ...strategy.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
  ];

  if (strategy.negativeConstraints.length > 0) {
    lines.push('## Negative Constraints', '');
    for (const nc of strategy.negativeConstraints) {
      lines.push(`- ${nc}`);
    }
    lines.push('');
  }

  if (strategy.spatialRules && strategy.spatialRules.length > 0) {
    lines.push('## Spatial Rules', '');
    for (const rule of strategy.spatialRules) {
      lines.push(`- ${rule}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// =============================================================================
// Constraint parsing
// =============================================================================

export function parseNegativeConstraints(content: string): NegativeConstraint[] {
  const constraints: NegativeConstraint[] = [];
  const entryRegex = /### (.+?)\n([\s\S]*?)(?=\n### |\n$|$)/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(content)) !== null) {
    const description = match[1].trim();
    const body = match[2];

    const contextMatch = body.match(/\*\*Context:\*\*\s*(.+)/);
    const severityMatch = body.match(/\*\*Severity:\*\*\s*(.+)/);
    const learnedMatch = body.match(/\*\*Learned from:\*\*\s*(.+)/);

    constraints.push({
      description,
      context: contextMatch ? contextMatch[1].trim() : 'general',
      severity: (severityMatch ? severityMatch[1].trim() : 'medium') as 'low' | 'medium' | 'high',
      learnedFrom: learnedMatch
        ? learnedMatch[1].split(',').map(s => s.trim()).filter(Boolean)
        : [],
    });
  }

  return constraints;
}

// =============================================================================
// StrategyStore Configuration
// =============================================================================

export interface StrategyStoreConfig {
  strategiesDir: string;
  levelDirs?: LevelDirectoryConfig;
}

// =============================================================================
// StrategyStore
// =============================================================================

export class StrategyStore {
  protected strategiesDir: string;
  protected levelDirs: Record<HierarchyLevel, string>;
  private strategyCache: Map<string, Strategy[]> | null = null;

  constructor(config: string | StrategyStoreConfig) {
    if (typeof config === 'string') {
      this.strategiesDir = config;
      this.levelDirs = { ...DEFAULT_LEVEL_DIRS };
    } else {
      this.strategiesDir = config.strategiesDir;
      this.levelDirs = { ...DEFAULT_LEVEL_DIRS, ...config.levelDirs };
    }
  }

  isAvailable(): boolean {
    return fs.existsSync(this.strategiesDir);
  }

  getStrategiesForLevel(level: HierarchyLevel): Strategy[] {
    if (!this.isAvailable()) return [];

    const levelDir = path.join(this.strategiesDir, this.levelDirs[level]);
    const seedsDir = path.join(this.strategiesDir, SEEDS_DIR);
    const strategies: Strategy[] = [];

    strategies.push(...this.readStrategiesFromDir(levelDir));

    for (const strat of this.readStrategiesFromDir(seedsDir)) {
      if (strat.hierarchyLevel === level) {
        strategies.push(strat);
      }
    }

    return strategies.filter(s => !s.deprecated);
  }

  findStrategies(goal: string, level: HierarchyLevel, _context?: string): Strategy[] {
    const all = this.getStrategiesForLevel(level);
    if (all.length === 0) return [];

    const goalLower = goal.toLowerCase();
    const goalWords = goalLower.split(/\s+/).filter(w => w.length > 2);

    const scored: Array<{ strategy: Strategy; score: number }> = [];

    for (const s of all) {
      let triggerScore = 0;
      for (const trigger of s.triggerGoals) {
        const triggerLower = trigger.toLowerCase();
        if (goalLower === triggerLower) {
          triggerScore = Math.max(triggerScore, 1.0);
        } else if (goalLower.includes(triggerLower) || triggerLower.includes(goalLower)) {
          triggerScore = Math.max(triggerScore, 0.7);
        } else {
          const triggerWords = triggerLower.split(/\s+/);
          for (const tw of triggerWords) {
            if (tw.length > 2 && goalWords.some(gw => gw.includes(tw) || tw.includes(gw))) {
              triggerScore = Math.max(triggerScore, 0.4);
            }
          }
        }
      }

      if (triggerScore === 0) continue;

      const confidenceScore = s.confidence;
      const totalUses = s.successCount + s.failureCount;
      const successRate = totalUses > 0 ? s.successCount / totalUses : 0.5;
      const composite = triggerScore * 0.5 + confidenceScore * 0.3 + successRate * 0.2;

      if (composite >= 0.2) {
        scored.push({ strategy: s, score: composite });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .map(s => s.strategy);
  }

  getNegativeConstraints(context?: string): NegativeConstraint[] {
    if (!this.isAvailable()) return [];

    const filePath = path.join(this.strategiesDir, CONSTRAINTS_FILE);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const all = parseNegativeConstraints(content);

      if (!context) return all;
      const ctxLower = context.toLowerCase();
      return all.filter(c =>
        c.context.toLowerCase().includes(ctxLower) || c.context === 'general'
      );
    } catch {
      return [];
    }
  }

  saveStrategy(strategy: Strategy): void {
    if (!this.isAvailable()) {
      fs.mkdirSync(this.strategiesDir, { recursive: true });
    }

    const levelDir = path.join(this.strategiesDir, this.levelDirs[strategy.hierarchyLevel]);
    if (!fs.existsSync(levelDir)) {
      fs.mkdirSync(levelDir, { recursive: true });
    }

    const slug = strategy.id.replace(/[^a-z0-9_-]/gi, '_');
    const filePath = path.join(levelDir, `${slug}.md`);
    const content = strategyToMarkdown(strategy);
    fs.writeFileSync(filePath, content);

    this.clearCache();
  }

  saveNegativeConstraint(constraint: NegativeConstraint): void {
    if (!this.isAvailable()) {
      fs.mkdirSync(this.strategiesDir, { recursive: true });
    }

    // Deduplicate: skip if a constraint with very similar description already exists
    const existing = this.getNegativeConstraints();
    const descLower = constraint.description.toLowerCase();
    const isDuplicate = existing.some(c => {
      const existingLower = c.description.toLowerCase();
      return existingLower === descLower || existingLower.includes(descLower) || descLower.includes(existingLower);
    });
    if (isDuplicate) return;

    const filePath = path.join(this.strategiesDir, CONSTRAINTS_FILE);
    const entry = [
      '',
      `### ${constraint.description}`,
      `**Context:** ${constraint.context}`,
      `**Severity:** ${constraint.severity}`,
      `**Learned from:** ${constraint.learnedFrom.join(', ') || 'unknown'}`,
      '',
    ].join('\n');

    fs.appendFileSync(filePath, entry);
  }

  reinforceStrategy(id: string): void {
    const strategy = this.findStrategyById(id);
    if (!strategy) return;

    strategy.successCount++;
    strategy.confidence = Math.min(1.0, strategy.confidence + 0.05);
    this.saveStrategy(strategy);
  }

  decayUnusedStrategies(maxAgeDays: number = 30): number {
    if (!this.isAvailable()) return 0;
    let decayed = 0;

    for (const level of Object.values(HierarchyLevel).filter(v => typeof v === 'number') as HierarchyLevel[]) {
      const strategies = this.getStrategiesForLevel(level);
      for (const strat of strategies) {
        if (strat.sourceTraceIds.length === 0) continue;
        if (strat.confidence <= 0.1) continue;

        strat.confidence = Math.max(0.1, strat.confidence - 0.02);
        this.saveStrategy(strat);
        decayed++;
      }
    }

    return decayed;
  }

  rebuildIndex(): void {
    this.clearCache();
  }

  getSummaryForLevel(level: HierarchyLevel, maxEntries: number = 5): string {
    const strategies = this.getStrategiesForLevel(level);
    if (strategies.length === 0) return '';

    const sorted = strategies.sort((a, b) => b.confidence - a.confidence).slice(0, maxEntries);
    const lines = sorted.map(s =>
      `- **${s.title}** (confidence: ${s.confidence.toFixed(2)}, ${s.successCount}/${s.failureCount} success/fail)`
    );
    return lines.join('\n');
  }

  appendDreamJournal(entry: DreamJournalEntry): void {
    if (!this.isAvailable()) {
      fs.mkdirSync(this.strategiesDir, { recursive: true });
    }

    const filePath = path.join(this.strategiesDir, JOURNAL_FILE);
    const text = [
      '',
      `## ${entry.timestamp}`,
      `- Traces processed: ${entry.tracesProcessed}`,
      `- Strategies created: ${entry.strategiesCreated}`,
      `- Strategies updated: ${entry.strategiesUpdated}`,
      `- Constraints learned: ${entry.constraintsLearned}`,
      `- Traces pruned: ${entry.tracesPruned}`,
      '',
      entry.summary,
      '',
    ].join('\n');

    fs.appendFileSync(filePath, text);
  }

  getLastDreamTimestamp(): string | null {
    const filePath = path.join(this.strategiesDir, JOURNAL_FILE);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const matches = content.match(/## (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/g);
      if (!matches || matches.length === 0) return null;
      return matches[matches.length - 1].replace('## ', '');
    } catch {
      return null;
    }
  }

  findStrategyById(id: string): Strategy | null {
    for (const level of Object.values(HierarchyLevel).filter(v => typeof v === 'number') as HierarchyLevel[]) {
      const strategies = this.getStrategiesForLevel(level);
      const found = strategies.find(s => s.id === id);
      if (found) return found;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Protected / Private
  // ---------------------------------------------------------------------------

  protected readStrategiesFromDir(dirPath: string): Strategy[] {
    if (!fs.existsSync(dirPath)) return [];

    try {
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
      const results: Strategy[] = [];

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const strategy = strategyFromMarkdown(content, filePath);
        if (strategy) results.push(strategy);
      }

      return results;
    } catch {
      return [];
    }
  }

  protected clearCache(): void {
    this.strategyCache = null;
  }
}
