/**
 * RoClaw Strategy Store — Local filesystem reader for strategy markdown files.
 *
 * Strategy management has moved to evolving-memory server. This file provides
 * backward-compatible read access to local strategy files (seeds, existing
 * strategies) for migration purposes.
 *
 * For new strategy queries, use MemoryClient instead.
 */

import * as fs from 'fs';
import * as path from 'path';
import { HierarchyLevel, type Strategy, type NegativeConstraint } from '../llmunix-core/types';

const DEFAULT_LEVEL_DIRS: Record<number, string> = {
  [HierarchyLevel.GOAL]: 'level_1_goals',
  [HierarchyLevel.STRATEGY]: 'level_2_routes',
  [HierarchyLevel.TACTICAL]: 'level_3_tactical',
  [HierarchyLevel.REACTIVE]: 'level_4_motor',
};

export class StrategyStore {
  private strategiesDir: string;

  constructor(strategiesDir?: string) {
    this.strategiesDir = strategiesDir ?? path.join(__dirname, 'strategies');
  }

  isAvailable(): boolean {
    return fs.existsSync(this.strategiesDir);
  }

  getStrategiesForLevel(level: HierarchyLevel): Strategy[] {
    const dirName = DEFAULT_LEVEL_DIRS[level] ?? `level_${level}`;
    const dirPath = path.join(this.strategiesDir, dirName);
    if (!fs.existsSync(dirPath)) return [];
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const content = fs.readFileSync(path.join(dirPath, f), 'utf-8');
      return strategyFromMarkdown(content, level);
    });
  }

  findStrategies(goal: string, level: HierarchyLevel): Strategy[] {
    const all = this.getStrategiesForLevel(level);
    const goalLower = goal.toLowerCase();
    return all.filter(s =>
      s.triggerGoals.some(tg => goalLower.includes(tg.toLowerCase()))
    );
  }

  getNegativeConstraints(context?: string): NegativeConstraint[] {
    const constraintsFile = path.join(this.strategiesDir, '_negative_constraints.md');
    if (!fs.existsSync(constraintsFile)) return [];
    const content = fs.readFileSync(constraintsFile, 'utf-8');
    return parseNegativeConstraints(content, context);
  }

  getLastDreamTimestamp(): string | null {
    const journalFile = path.join(this.strategiesDir, '_dream_journal.md');
    if (!fs.existsSync(journalFile)) return null;
    const content = fs.readFileSync(journalFile, 'utf-8');
    const match = content.match(/\*\*Timestamp:\*\*\s*(\S+)/g);
    if (!match) return null;
    const last = match[match.length - 1];
    return last.replace('**Timestamp:** ', '');
  }

  rebuildIndex(): void {
    // No-op — local filesystem needs no index
  }
}

// =============================================================================
// Parsing utilities
// =============================================================================

export function strategyFromMarkdown(content: string, level: HierarchyLevel): Strategy {
  const lines = content.split('\n');
  const title = (lines.find(l => l.startsWith('# '))?.slice(2) ?? 'Untitled').trim();
  return {
    id: `strat_${level}_${title.toLowerCase().replace(/\s+/g, '-').slice(0, 30)}`,
    version: 1,
    hierarchyLevel: level,
    title,
    preconditions: [],
    triggerGoals: [title],
    steps: [],
    negativeConstraints: [],
    confidence: 0.5,
    successCount: 0,
    failureCount: 0,
    sourceTraceIds: [],
    deprecated: false,
  };
}

export function strategyToMarkdown(strategy: Strategy): string {
  const lines = [
    `# ${strategy.title}`,
    '',
    `**Level:** ${strategy.hierarchyLevel}`,
    `**Confidence:** ${strategy.confidence}`,
    '',
  ];
  if (strategy.steps.length > 0) {
    lines.push('## Steps');
    strategy.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');
  }
  return lines.join('\n');
}

export function parseNegativeConstraints(content: string, context?: string): NegativeConstraint[] {
  const constraints: NegativeConstraint[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^-\s+\*\*(\w+)\*\*:\s+(.+?)(?:\s+\(context:\s+(.+?)\))?$/);
    if (match) {
      const severity = match[1].toLowerCase() as 'low' | 'medium' | 'high';
      const desc = match[2];
      const ctx = match[3] ?? '';
      if (!context || ctx.includes(context)) {
        constraints.push({ description: desc, context: ctx, learnedFrom: [], severity });
      }
    }
  }
  return constraints;
}
