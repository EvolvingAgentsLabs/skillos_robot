/**
 * RoClaw Dream Simulator — Text-based dream simulation + consolidation
 *
 * Runs the robot through dream scenarios using text-only scene simulation,
 * then feeds the generated traces into the DreamEngine for strategy consolidation.
 *
 * Usage:
 *   npm run dream:sim                          # Claude mode (default)
 *   npm run dream:sim -- --mode gemini         # Real Gemini
 *   npm run dream:sim -- --mode dual           # Both (compare)
 *   npm run dream:sim -- --scenario corridor-target  # Single scenario
 *   npm run dream:sim -- --no-consolidate      # Skip dream consolidation
 *   npm run dream:sim -- --verbose             # Detailed per-frame output
 */

import * as path from 'path';
import * as dotenv from 'dotenv';

import {
  DreamScenarioRunner,
  generateDreamReport,
  SCENARIOS,
  type DreamInferenceMode,
} from '../src/3_llmunix_memory/dream_simulator';

import { DreamEngine } from '../src/llmunix-core/dream_engine';
import { StrategyStore } from '../src/3_llmunix_memory/strategy_store';
import { createDreamInference } from '../src/3_llmunix_memory/dream_inference';
import { roClawDreamAdapter } from '../src/3_llmunix_memory/roclaw_dream_adapter';

dotenv.config();

// =============================================================================
// CLI
// =============================================================================

interface CLIConfig {
  mode: DreamInferenceMode;
  scenarioId: string | null;
  consolidate: boolean;
  verbose: boolean;
}

function parseArgs(): CLIConfig {
  const args = process.argv.slice(2);
  const config: CLIConfig = {
    mode: 'claude',
    scenarioId: null,
    consolidate: true,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--mode':
        config.mode = args[++i] as DreamInferenceMode;
        if (!['claude', 'gemini', 'dual'].includes(config.mode)) {
          console.error(`Invalid mode: ${config.mode}. Use: claude, gemini, dual`);
          process.exit(1);
        }
        break;
      case '--scenario':
        config.scenarioId = args[++i];
        break;
      case '--no-consolidate':
        config.consolidate = false;
        break;
      case '--verbose':
        config.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log(`
RoClaw Dream Simulator — Text-based dream simulation

Usage: npm run dream:sim -- [options]

Options:
  --mode <claude|gemini|dual>  Inference mode (default: claude)
    claude  - Uses Claude via OpenRouter to simulate Gemini's motor decisions
    gemini  - Uses real Gemini Robotics API
    dual    - Runs both and compares agreement

  --scenario <id>              Run a single scenario (default: all)
    Available: ${SCENARIOS.map(s => s.id).join(', ')}

  --no-consolidate             Skip DreamEngine consolidation after simulation
  --verbose                    Print per-frame progress
  --help, -h                   Show this help

Environment:
  OPENROUTER_API_KEY   Required for claude/dual modes
  GOOGLE_API_KEY       Required for gemini/dual modes
  DREAM_CLAUDE_MODEL   Claude model override (default: anthropic/claude-sonnet-4)
  GEMINI_MODEL         Gemini model override (default: gemini-2.0-flash)
`);
        process.exit(0);
    }
  }

  return config;
}

// =============================================================================
// Main
// =============================================================================

const TRACES_DIR = path.join(__dirname, '..', 'src', '3_llmunix_memory', 'traces');
const STRATEGIES_DIR = path.join(__dirname, '..', 'src', '3_llmunix_memory', 'strategies');

async function main(): Promise<void> {
  const config = parseArgs();

  console.log('=== RoClaw Dream Simulator ===\n');
  console.log(`Mode: ${config.mode}`);
  console.log(`Consolidation: ${config.consolidate ? 'enabled' : 'disabled'}`);

  // Select scenarios
  const scenarios = config.scenarioId
    ? SCENARIOS.filter(s => s.id === config.scenarioId)
    : SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`Scenario not found: ${config.scenarioId}`);
    console.error(`Available: ${SCENARIOS.map(s => s.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`Scenarios: ${scenarios.map(s => s.title).join(', ')}\n`);

  // Create runner
  const runner = new DreamScenarioRunner({
    inferenceMode: config.mode,
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    googleApiKey: process.env.GOOGLE_API_KEY,
    tracesDir: TRACES_DIR,
    verbose: config.verbose,
    claudeModel: process.env.DREAM_CLAUDE_MODEL,
    geminiModel: process.env.GEMINI_MODEL,
  });

  // Run scenarios
  const results = await runner.runAll(scenarios);

  // Print report
  const report = generateDreamReport(results);
  console.log('\n' + report);

  // Print inference stats
  const inferStats = runner.getInferenceStats();
  console.log('--- Inference Stats ---');
  console.log(`  Total calls: ${inferStats.totalCalls}`);
  console.log(`  Claude: ${inferStats.claudeCalls} | Gemini: ${inferStats.geminiCalls} | Dual: ${inferStats.dualCalls}`);
  if (inferStats.dualCalls > 0) {
    const agreementRate = inferStats.agreements / (inferStats.agreements + inferStats.disagreements) * 100;
    console.log(`  Agreement rate: ${agreementRate.toFixed(1)}% (${inferStats.agreements}/${inferStats.agreements + inferStats.disagreements})`);
  }
  console.log(`  Errors: ${inferStats.errors}`);
  console.log(`  Avg latency: ${inferStats.avgLatencyMs}ms`);
  console.log('');

  // Dream consolidation
  if (config.consolidate) {
    console.log('--- Dream Consolidation ---\n');

    const apiKey = process.env.OPENROUTER_API_KEY || '';
    if (!apiKey && !process.env.GOOGLE_API_KEY && !process.env.LOCAL_INFERENCE_URL) {
      console.log('No inference API key available for consolidation. Skipping.');
      console.log('Set OPENROUTER_API_KEY, GOOGLE_API_KEY, or LOCAL_INFERENCE_URL to enable.');
      return;
    }

    const store = new StrategyStore(STRATEGIES_DIR);
    const dreamInfer = createDreamInference({ apiKey });

    const engine = new DreamEngine({
      adapter: roClawDreamAdapter,
      infer: dreamInfer,
      store,
      tracesDir: TRACES_DIR,
    });

    const dreamResult = await engine.dream();

    console.log('\n--- Consolidation Summary ---');
    console.log(`  Traces processed: ${dreamResult.tracesProcessed}`);
    console.log(`  Strategies created: ${dreamResult.strategiesCreated.length}`);
    console.log(`  Strategies updated: ${dreamResult.strategiesUpdated.length}`);
    console.log(`  Constraints learned: ${dreamResult.constraintsLearned.length}`);
    console.log(`  Traces pruned: ${dreamResult.tracesPruned}`);
    console.log(`  Journal: ${dreamResult.journalEntry.summary}`);
  }

  console.log('\nDream simulation complete.');
}

main().catch(err => {
  console.error('Dream simulator error:', err);
  process.exit(1);
});
