/**
 * RoClaw Real A/B Test Runner — Gemini Robotics Integration Test
 *
 * Runs all 5 dream scenarios in two conditions:
 *   1. Baseline: Raw Gemini inference with no strategy/constraint injection
 *   2. Full Stack: Gemini inference augmented with learned strategies + negative constraints
 *
 * Produces a markdown report with per-scenario metrics and aggregate improvements.
 *
 * Usage:
 *   npm run ab:test                          # Run full A/B test
 *   npm run ab:test -- --verbose             # With per-frame logging
 *   npm run ab:test -- --scenario corridor-target  # Single scenario
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

import {
  DreamScenarioRunner,
  SCENARIOS,
  type ScenarioResult,
  type RunnerConfig,
} from '../src/3_llmunix_memory/dream_simulator';

import { StrategyStore } from '../src/3_llmunix_memory/strategy_store';
import { HierarchyLevel } from '../src/llmunix-core/types';

dotenv.config();

// =============================================================================
// CLI
// =============================================================================

interface CLIConfig {
  scenarioId: string | null;
  verbose: boolean;
  textModel: string | null;
}

function parseArgs(): CLIConfig {
  const args = process.argv.slice(2);
  const config: CLIConfig = { scenarioId: null, verbose: false, textModel: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--scenario':
        config.scenarioId = args[++i];
        break;
      case '--text-model':
        config.textModel = args[++i];
        break;
      case '--verbose':
        config.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log(`
RoClaw Real A/B Test — Gemini Robotics

Usage: npm run ab:test -- [options]

Options:
  --scenario <id>   Run a single scenario (default: all)
    Available: ${SCENARIOS.map(s => s.id).join(', ')}
  --text-model <m>  Text model override (default: gemini-3-flash-preview)
  --verbose         Print per-frame progress
  --help, -h        Show this help

Environment:
  GOOGLE_API_KEY    Required — Gemini Robotics API key
  GEMINI_MODEL      Image model override (default: gemini-3-flash-preview)
  GEMINI_TEXT_MODEL Text model override (default: gemini-3-flash-preview)
`);
        process.exit(0);
    }
  }

  return config;
}

// =============================================================================
// Strategy & Constraint Loading
// =============================================================================

const STRATEGIES_DIR = path.join(__dirname, '..', 'system', 'memory', 'strategies');

interface StackConfig {
  strategies: string[];
  constraints: string[];
}

function loadFullStackConfig(): StackConfig {
  const store = new StrategyStore(STRATEGIES_DIR);
  const strategies: string[] = [];
  const constraints: string[] = [];

  // Load strategies from all levels
  for (const level of [HierarchyLevel.GOAL, HierarchyLevel.STRATEGY, HierarchyLevel.TACTICAL, HierarchyLevel.REACTIVE]) {
    const strats = store.getStrategiesForLevel(level);
    for (const s of strats) {
      // Only include navigation-relevant strategies with steps
      if (s.steps.length > 0 && s.triggerGoals.some(t =>
        /obstacle|avoid|wall|corridor|door|navigate|stuck|collision|block/i.test(t)
      )) {
        for (const step of s.steps) {
          strategies.push(step);
        }
      }
    }
  }

  // Load negative constraints — filter to navigation-relevant only
  const NAV_CONSTRAINT_KEYWORDS = /obstacle|wall|speed|collision|stuck|rotate|forward|backward|doorway|navigate|motor|clearance|oscillat/i;
  const allConstraints = store.getNegativeConstraints();
  for (const c of allConstraints) {
    if (NAV_CONSTRAINT_KEYWORDS.test(c.description) || NAV_CONSTRAINT_KEYWORDS.test(c.context || '')) {
      constraints.push(`NEVER: ${c.description} (severity: ${c.severity})`);
    }
  }

  // If the parser didn't match any (format mismatch), read the file directly
  // and extract constraint descriptions with a simple regex
  if (constraints.length === 0) {
    const constraintFile = path.join(STRATEGIES_DIR, '_negative_constraints.md');
    if (fs.existsSync(constraintFile)) {
      const content = fs.readFileSync(constraintFile, 'utf-8');
      const descRegex = /\*\*Description:\*\*\s*(.+)/g;
      let match: RegExpExecArray | null;
      while ((match = descRegex.exec(content)) !== null) {
        constraints.push(`NEVER: ${match[1].trim()}`);
      }
    }
  }

  // If still empty, use hardcoded defaults derived from known constraints
  if (strategies.length === 0) {
    strategies.push(
      'When obstacle or wall is detected, immediately reduce speed to 60-80',
      'If path ahead is blocked, rotate 90 degrees to systematically survey alternative paths',
      'If collision warning, move backward at speed 60 before attempting rotation',
      'When approaching a doorway, center alignment and reduce speed to 60-80',
      'If stuck (same action repeated 6+ times), break with 90-120 degree rotation',
      'After clearing an obstacle, resume at moderate speed (100-120), not maximum',
    );
  }

  if (constraints.length === 0) {
    constraints.push(
      'NEVER move forward into obstacles at full speed when distance < 50cm',
      'NEVER charge through doorways at speed > 100',
      'NEVER use rotation angles under 45 degrees to clear blocked paths',
    );
  }

  return { strategies, constraints };
}

// =============================================================================
// Metrics
// =============================================================================

interface ConditionMetrics {
  condition: 'Baseline' | 'Full Stack';
  results: ScenarioResult[];
  successCount: number;
  totalCollisions: number;
  totalStuck: number;
  totalFrames: number;
  totalDurationMs: number;
  avgLatencyMs: number;
}

function aggregateMetrics(
  condition: 'Baseline' | 'Full Stack',
  results: ScenarioResult[],
  avgLatencyMs: number,
): ConditionMetrics {
  return {
    condition,
    results,
    successCount: results.filter(r => r.goalReached).length,
    totalCollisions: results.reduce((s, r) => s + r.collisionCount, 0),
    totalStuck: results.reduce((s, r) => s + r.stuckCount, 0),
    totalFrames: results.reduce((s, r) => s + r.framesExecuted, 0),
    totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
    avgLatencyMs,
  };
}

function pctChange(baseline: number, fullstack: number): string {
  if (baseline === 0 && fullstack === 0) return '—';
  if (baseline === 0) return `+${fullstack}`;
  const pct = ((fullstack - baseline) / baseline) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// =============================================================================
// Report Generation
// =============================================================================

function generateReport(
  baseline: ConditionMetrics,
  fullStack: ConditionMetrics,
  stackConfig: StackConfig,
  imageModel: string,
  textModel: string,
): string {
  const date = new Date().toISOString().slice(0, 10);
  const scenarioCount = baseline.results.length;

  const avgCollisionsB = baseline.totalCollisions / scenarioCount;
  const avgCollisionsF = fullStack.totalCollisions / scenarioCount;
  const avgStuckB = baseline.totalStuck / scenarioCount;
  const avgStuckF = fullStack.totalStuck / scenarioCount;
  const avgFramesB = baseline.totalFrames / scenarioCount;
  const avgFramesF = fullStack.totalFrames / scenarioCount;

  const lines: string[] = [];

  lines.push(`# RoClaw A/B Test Report — Real Gemini Robotics`);
  lines.push(`**Date:** ${date} | **Image model:** ${imageModel} | **Text model:** ${textModel} | **Scenarios:** ${scenarioCount}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('| Metric | Baseline | Full Stack | Change |');
  lines.push('|--------|----------|------------|--------|');
  lines.push(`| Success Rate | ${baseline.successCount}/${scenarioCount} | ${fullStack.successCount}/${scenarioCount} | ${pctChange(baseline.successCount, fullStack.successCount)} |`);
  lines.push(`| Avg Collisions | ${avgCollisionsB.toFixed(1)} | ${avgCollisionsF.toFixed(1)} | ${pctChange(avgCollisionsB, avgCollisionsF)} |`);
  lines.push(`| Avg Stuck Events | ${avgStuckB.toFixed(1)} | ${avgStuckF.toFixed(1)} | ${pctChange(avgStuckB, avgStuckF)} |`);
  lines.push(`| Avg Frames to End | ${avgFramesB.toFixed(1)} | ${avgFramesF.toFixed(1)} | ${pctChange(avgFramesB, avgFramesF)} |`);
  lines.push(`| Total Duration | ${(baseline.totalDurationMs / 1000).toFixed(1)}s | ${(fullStack.totalDurationMs / 1000).toFixed(1)}s | — |`);
  lines.push(`| Avg Inference Latency | ${baseline.avgLatencyMs}ms | ${fullStack.avgLatencyMs}ms | — |`);
  lines.push('');

  // Per-scenario table
  lines.push('## Per-Scenario Results');
  lines.push('| Scenario | Condition | Goal? | Frames | Collisions | Stuck | Distance | Duration |');
  lines.push('|----------|-----------|-------|--------|------------|-------|----------|----------|');

  for (let i = 0; i < baseline.results.length; i++) {
    const b = baseline.results[i];
    const f = fullStack.results[i];

    const bGoal = b.goalReached ? 'YES' : 'NO';
    const fGoal = f.goalReached ? 'YES' : 'NO';
    const bDist = b.finalTargetDistance !== null ? `${b.finalTargetDistance.toFixed(0)}cm` : 'N/A';
    const fDist = f.finalTargetDistance !== null ? `${f.finalTargetDistance.toFixed(0)}cm` : 'N/A';

    lines.push(`| ${b.title} | Baseline | ${bGoal} | ${b.framesExecuted} | ${b.collisionCount} | ${b.stuckCount} | ${bDist} | ${(b.durationMs / 1000).toFixed(1)}s |`);
    lines.push(`| ${f.title} | Full Stack | ${fGoal} | ${f.framesExecuted} | ${f.collisionCount} | ${f.stuckCount} | ${fDist} | ${(f.durationMs / 1000).toFixed(1)}s |`);
  }
  lines.push('');

  // Strategies injected
  lines.push('## Strategies Injected (Full Stack condition)');
  for (const step of stackConfig.strategies) {
    lines.push(`- ${step}`);
  }
  lines.push('');

  // Constraints applied
  lines.push('## Constraints Applied (Full Stack condition)');
  for (const c of stackConfig.constraints) {
    lines.push(`- ${c}`);
  }
  lines.push('');

  return lines.join('\n');
}

// =============================================================================
// Main
// =============================================================================

const TRACES_DIR = path.join(__dirname, '..', 'src', '3_llmunix_memory', 'traces');
const OUTPUT_DIR = path.join(__dirname, '..', 'projects', 'GeminiCore', 'output');

async function main(): Promise<void> {
  const config = parseArgs();
  const googleApiKey = process.env.GOOGLE_API_KEY || '';
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
  const textModel = config.textModel || process.env.GEMINI_TEXT_MODEL || 'gemini-3-flash-preview';

  if (!googleApiKey) {
    console.error('Error: GOOGLE_API_KEY is required.');
    console.error('Set it in your .env file or export GOOGLE_API_KEY=<your-key>');
    process.exit(1);
  }

  // Select scenarios
  const scenarios = config.scenarioId
    ? SCENARIOS.filter(s => s.id === config.scenarioId)
    : SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`Scenario not found: ${config.scenarioId}`);
    console.error(`Available: ${SCENARIOS.map(s => s.id).join(', ')}`);
    process.exit(1);
  }

  console.log('=== RoClaw Real A/B Test (Gemini Robotics) ===\n');
  console.log(`Image model: ${geminiModel}`);
  console.log(`Text model:  ${textModel}`);
  console.log(`Scenarios: ${scenarios.map(s => s.title).join(', ')}\n`);

  // Load Full Stack config
  const stackConfig = loadFullStackConfig();
  console.log(`Loaded ${stackConfig.strategies.length} strategy steps, ${stackConfig.constraints.length} constraints\n`);

  // --- BASELINE CONDITION ---
  console.log('========== BASELINE (no strategies/constraints) ==========\n');

  const baselineConfig: RunnerConfig = {
    inferenceMode: 'gemini',
    googleApiKey,
    tracesDir: path.join(TRACES_DIR, 'ab-baseline'),
    verbose: config.verbose,
    geminiModel,
    textModel,
  };
  const baselineRunner = new DreamScenarioRunner(baselineConfig);
  const baselineResults = await baselineRunner.runAll(scenarios);
  const baselineStats = baselineRunner.getInferenceStats();

  console.log(`\nBaseline complete: ${baselineResults.filter(r => r.goalReached).length}/${scenarios.length} goals reached\n`);

  // --- FULL STACK CONDITION ---
  console.log('========== FULL STACK (strategies + constraints) ==========\n');

  const fullStackConfig: RunnerConfig = {
    inferenceMode: 'gemini',
    googleApiKey,
    tracesDir: path.join(TRACES_DIR, 'ab-fullstack'),
    verbose: config.verbose,
    geminiModel,
    textModel,
    strategies: stackConfig.strategies,
    constraints: stackConfig.constraints,
  };
  const fullStackRunner = new DreamScenarioRunner(fullStackConfig);
  const fullStackResults = await fullStackRunner.runAll(scenarios);
  const fullStackStats = fullStackRunner.getInferenceStats();

  console.log(`\nFull Stack complete: ${fullStackResults.filter(r => r.goalReached).length}/${scenarios.length} goals reached\n`);

  // --- AGGREGATE ---
  const baselineMetrics = aggregateMetrics('Baseline', baselineResults, baselineStats.avgLatencyMs);
  const fullStackMetrics = aggregateMetrics('Full Stack', fullStackResults, fullStackStats.avgLatencyMs);

  // --- REPORT ---
  const report = generateReport(baselineMetrics, fullStackMetrics, stackConfig, geminiModel, textModel);

  // Write report
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(OUTPUT_DIR, `ab-test-report-${date}.md`);
  fs.writeFileSync(reportPath, report);

  // --- CONSOLE SUMMARY ---
  console.log('========== RESULTS ==========\n');
  console.log(report);
  console.log(`\nReport saved to: ${reportPath}`);

  // Inference stats
  console.log('\n--- Inference Stats ---');
  console.log(`  Baseline:   ${baselineStats.totalCalls} calls, ${baselineStats.errors} errors, avg ${baselineStats.avgLatencyMs}ms`);
  console.log(`  Full Stack: ${fullStackStats.totalCalls} calls, ${fullStackStats.errors} errors, avg ${fullStackStats.avgLatencyMs}ms`);
  console.log('');
}

main().catch(err => {
  console.error('A/B test error:', err);
  process.exit(1);
});
