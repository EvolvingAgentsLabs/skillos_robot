/**
 * RoClaw Dream Simulator — Text-based dream simulation + consolidation
 *
 * Runs the robot through dream scenarios using text-only scene simulation,
 * then feeds the generated traces into the DreamEngine for strategy consolidation.
 * Powered 100% by Gemini Robotics.
 *
 * Usage:
 *   npm run dream:sim                               # Run all scenarios
 *   npm run dream:sim -- --scenario corridor-target  # Single scenario
 *   npm run dream:sim -- --no-consolidate            # Skip dream consolidation
 *   npm run dream:sim -- --verbose                   # Detailed per-frame output
 */

import * as path from 'path';
import * as dotenv from 'dotenv';

import {
  DreamScenarioRunner,
  generateDreamReport,
  SCENARIOS,
} from '../src/3_llmunix_memory/dream_simulator';

import { MemoryClient } from '../src/llmunix-core/memory_client';

dotenv.config();

// =============================================================================
// CLI
// =============================================================================

interface CLIConfig {
  scenarioId: string | null;
  consolidate: boolean;
  verbose: boolean;
}

function parseArgs(): CLIConfig {
  const args = process.argv.slice(2);
  const config: CLIConfig = {
    scenarioId: null,
    consolidate: true,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
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
RoClaw Dream Simulator — Powered by Gemini Robotics

Usage: npm run dream:sim -- [options]

Options:
  --scenario <id>              Run a single scenario (default: all)
    Available: ${SCENARIOS.map(s => s.id).join(', ')}

  --no-consolidate             Skip DreamEngine consolidation after simulation
  --verbose                    Print per-frame progress
  --help, -h                   Show this help

Environment:
  GOOGLE_API_KEY       Required — Gemini Robotics API key
  GEMINI_MODEL         Model override (default: gemini-3-flash-preview)
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
  const googleApiKey = process.env.GOOGLE_API_KEY || '';

  if (!googleApiKey) {
    console.error('Error: GOOGLE_API_KEY is required for Gemini Robotics inference.');
    console.error('Set it in your .env file or export GOOGLE_API_KEY=<your-key>');
    process.exit(1);
  }

  console.log('=== RoClaw Dream Simulator (Gemini Robotics) ===\n');
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

  // Create runner — Gemini only
  const runner = new DreamScenarioRunner({
    inferenceMode: 'gemini',
    googleApiKey,
    tracesDir: TRACES_DIR,
    verbose: config.verbose,
    geminiModel: process.env.GEMINI_MODEL,
  });

  // Run scenarios
  const results = await runner.runAll(scenarios);

  // Print report
  const report = generateDreamReport(results);
  console.log('\n' + report);

  // Print inference stats
  const inferStats = runner.getInferenceStats();
  console.log('--- Gemini Inference Stats ---');
  console.log(`  Total calls: ${inferStats.totalCalls}`);
  console.log(`  Gemini calls: ${inferStats.geminiCalls}`);
  console.log(`  Errors: ${inferStats.errors}`);
  console.log(`  Avg latency: ${inferStats.avgLatencyMs}ms`);
  console.log('');

  // Dream consolidation via evolving-memory server
  if (config.consolidate) {
    console.log('--- Dream Consolidation (Remote) ---\n');

    const memoryServerUrl = process.env.MEMORY_SERVER_URL || 'http://localhost:8420';
    const client = new MemoryClient(memoryServerUrl);

    try {
      const dreamResult = await client.runDream('robotics');
      console.log('\n--- Consolidation Summary ---');
      console.log(`  Traces processed: ${dreamResult.traces_processed}`);
      console.log(`  Nodes created: ${dreamResult.nodes_created}`);
      console.log(`  Nodes merged: ${dreamResult.nodes_merged}`);
      console.log(`  Edges created: ${dreamResult.edges_created}`);
      console.log(`  Constraints: ${dreamResult.constraints_extracted}`);
    } catch (err) {
      console.error(`Dream consolidation failed — is evolving-memory server running at ${memoryServerUrl}?`);
      console.error(err);
    }
  }

  console.log('\nDream simulation complete.');
}

main().catch(err => {
  console.error('Dream simulator error:', err);
  process.exit(1);
});
