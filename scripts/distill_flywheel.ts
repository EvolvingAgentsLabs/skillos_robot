/**
 * Distill Flywheel — Overnight scenario generation + trace posting
 *
 * Generates random navigation scenarios, runs them through the dream simulator
 * with Gemini as teacher, posts traces to evolving-memory, and periodically
 * triggers dream consolidation. Learned strategies are injected into subsequent
 * batches for continuous improvement.
 *
 * Usage:
 *   npx tsx scripts/distill_flywheel.ts --count 200 --batch-size 20
 *   npx tsx scripts/distill_flywheel.ts --count 5 --batch-size 5 --verbose
 *   npx tsx scripts/distill_flywheel.ts --count 50 --seed 12345 --inference-delay-ms 200
 */

import * as dotenv from 'dotenv';
import { DreamScenarioRunner, generateDreamReport, type RunnerConfig, type ScenarioResult } from '../src/3_llmunix_memory/dream_simulator/scenario_runner';
import { ScenarioGenerator } from '../src/3_llmunix_memory/dream_simulator/scenario_generator';
import { TracePoster } from '../src/3_llmunix_memory/dream_simulator/trace_poster';
import type { DreamScenario } from '../src/3_llmunix_memory/dream_simulator/text_scene';
import { TraceOutcome } from '../src/llmunix-core/types';

dotenv.config();

// =============================================================================
// CLI Parsing
// =============================================================================

let totalCount = 200;
let batchSize = 20;
let baseSeed = Date.now();
let verbose = false;
let inferenceDelayMs = 100;
let textModel = 'gemini-3.1-flash-lite-preview';
let memoryServerUrl = 'http://localhost:8420';
let tracesDir = './traces/distill';
let skipDream = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--count': totalCount = parseInt(args[++i] || '200', 10); break;
    case '--batch-size': batchSize = parseInt(args[++i] || '20', 10); break;
    case '--seed': baseSeed = parseInt(args[++i] || String(Date.now()), 10); break;
    case '--verbose': verbose = true; break;
    case '--inference-delay-ms': inferenceDelayMs = parseInt(args[++i] || '100', 10); break;
    case '--text-model': textModel = args[++i] || textModel; break;
    case '--memory-server': memoryServerUrl = args[++i] || memoryServerUrl; break;
    case '--traces-dir': tracesDir = args[++i] || tracesDir; break;
    case '--skip-dream': skipDream = true; break;
    case '--help':
      console.log(`Usage: npx tsx scripts/distill_flywheel.ts [options]

Options:
  --count <n>              Total scenarios to generate (default: 200)
  --batch-size <n>         Scenarios per batch before dream consolidation (default: 20)
  --seed <n>               Base seed for reproducibility (default: Date.now())
  --verbose                Print live progress per scenario
  --inference-delay-ms <n> Delay between inferences in ms (default: 100)
  --text-model <model>     Gemini text model (default: gemini-3.1-flash-lite-preview)
  --memory-server <url>    evolving-memory server URL (default: http://localhost:8420)
  --traces-dir <dir>       Local traces directory (default: ./traces/distill)
  --skip-dream             Skip dream consolidation between batches
  --help                   Show this help
`);
      process.exit(0);
  }
}

// =============================================================================
// Main Flywheel
// =============================================================================

async function main(): Promise<void> {
  console.log('=== RoClaw Distill Flywheel ===');
  console.log(`Scenarios: ${totalCount}, Batch size: ${batchSize}, Seed: ${baseSeed}`);
  console.log(`Text model: ${textModel}`);
  console.log(`Memory server: ${memoryServerUrl}`);
  console.log(`Inference delay: ${inferenceDelayMs}ms`);
  console.log('');

  // Check dependencies
  const googleApiKey = process.env.GOOGLE_API_KEY;
  if (!googleApiKey) {
    console.error('Error: GOOGLE_API_KEY required');
    process.exit(1);
  }

  const poster = new TracePoster({ serverUrl: memoryServerUrl });
  const serverUp = await poster.health();
  if (!serverUp) {
    console.error(`Error: Cannot reach memory server at ${memoryServerUrl}`);
    console.error('Start it with: PYTHONPATH=src GEMINI_API_KEY=... python3.12 -m evolving_memory.server --port 8420');
    process.exit(1);
  }

  const initialStats = await poster.stats();
  console.log(`Server stats: ${initialStats.traces} traces, ${initialStats.parent_nodes} parent nodes`);
  console.log('');

  const generator = new ScenarioGenerator();

  // Track cumulative stats
  let totalSuccess = 0;
  let totalFailure = 0;
  let totalPartial = 0;
  let totalFrames = 0;
  let totalCollisions = 0;
  let totalDurationMs = 0;

  // Strategies/constraints learned from dream consolidation
  let learnedStrategies: string[] = [];
  let learnedConstraints: string[] = [];

  const numBatches = Math.ceil(totalCount / batchSize);

  for (let batch = 0; batch < numBatches; batch++) {
    const batchStart = batch * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, totalCount);
    const batchCount = batchEnd - batchStart;

    console.log(`\n--- Batch ${batch + 1}/${numBatches} (scenarios ${batchStart + 1}-${batchEnd}) ---`);
    if (learnedStrategies.length > 0) {
      console.log(`  Injecting ${learnedStrategies.length} strategies + ${learnedConstraints.length} constraints from dream`);
    }

    // Create runner with current learned knowledge
    const runnerConfig: RunnerConfig = {
      googleApiKey,
      tracesDir,
      verbose,
      textModel,
      skipLocalTraces: true, // posting to server instead
      strategies: learnedStrategies,
      constraints: learnedConstraints,
    };
    const runner = new DreamScenarioRunner(runnerConfig);

    // Generate + run scenarios
    const batchResults: ScenarioResult[] = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const seed = baseSeed + i;
      const scenario: DreamScenario = generator.generate(seed);

      if (verbose) {
        console.log(`\n  [${i + 1}/${totalCount}] ${scenario.title} (seed=${seed})`);
      } else {
        process.stdout.write(`  Running ${i + 1}/${totalCount}...`);
      }

      try {
        const result = await runner.runScenario(scenario);
        batchResults.push(result);

        // Post trace to server
        try {
          const resp = await poster.postResult(result);
          if (verbose) {
            console.log(`    -> ${result.outcome} (${result.framesExecuted} frames) -> trace ${resp.trace_id.slice(0, 8)}`);
          }
        } catch (err) {
          console.error(`    [!] Failed to post trace: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Rate limiting
        if (inferenceDelayMs > 0) {
          await sleep(inferenceDelayMs);
        }

        if (!verbose) {
          const icon = result.outcome === TraceOutcome.SUCCESS ? 'OK' : result.outcome === TraceOutcome.FAILURE ? 'FAIL' : 'PART';
          process.stdout.write(` [${icon}]\n`);
        }
      } catch (err) {
        console.error(`  [!] Scenario error: ${err instanceof Error ? err.message : String(err)}`);
        if (!verbose) process.stdout.write(' [ERR]\n');
      }
    }

    // Batch summary
    const batchSuccess = batchResults.filter(r => r.outcome === TraceOutcome.SUCCESS).length;
    const batchFailure = batchResults.filter(r => r.outcome === TraceOutcome.FAILURE).length;
    const batchPartial = batchResults.filter(r => r.outcome === TraceOutcome.PARTIAL).length;
    const batchFrames = batchResults.reduce((s, r) => s + r.framesExecuted, 0);
    const batchCollisions = batchResults.reduce((s, r) => s + r.collisionCount, 0);
    const batchDuration = batchResults.reduce((s, r) => s + r.durationMs, 0);

    totalSuccess += batchSuccess;
    totalFailure += batchFailure;
    totalPartial += batchPartial;
    totalFrames += batchFrames;
    totalCollisions += batchCollisions;
    totalDurationMs += batchDuration;

    console.log(`\n  Batch ${batch + 1} summary:`);
    console.log(`    Success: ${batchSuccess}/${batchCount} (${(batchSuccess / batchCount * 100).toFixed(0)}%)`);
    console.log(`    Failure: ${batchFailure}, Partial: ${batchPartial}`);
    console.log(`    Frames: ${batchFrames}, Collisions: ${batchCollisions}`);
    console.log(`    Duration: ${(batchDuration / 1000).toFixed(1)}s`);

    // Dream consolidation between batches
    if (!skipDream && batch < numBatches - 1) {
      console.log('\n  Running dream consolidation...');
      try {
        const dreamResult = await poster.runDream();
        console.log(`    Dream: ${dreamResult.traces_processed} traces -> ${dreamResult.nodes_created} nodes, ${dreamResult.nodes_merged} merged`);

        // Extract learned strategies/constraints for next batch
        const updated = await extractLearnedKnowledge(poster);
        learnedStrategies = updated.strategies;
        learnedConstraints = updated.constraints;

        if (learnedStrategies.length > 0 || learnedConstraints.length > 0) {
          console.log(`    Learned: ${learnedStrategies.length} strategies, ${learnedConstraints.length} constraints`);
        }
      } catch (err) {
        console.error(`    [!] Dream error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Final dream consolidation
  if (!skipDream) {
    console.log('\n--- Final dream consolidation ---');
    try {
      const dreamResult = await poster.runDream();
      console.log(`Dream: ${dreamResult.traces_processed} traces -> ${dreamResult.nodes_created} nodes, ${dreamResult.nodes_merged} merged`);
    } catch (err) {
      console.error(`Dream error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Final report
  const finalStats = await poster.stats();
  const total = totalSuccess + totalFailure + totalPartial;
  console.log('\n=== Flywheel Complete ===');
  console.log(`Total scenarios: ${total}`);
  console.log(`Success: ${totalSuccess} (${(totalSuccess / total * 100).toFixed(0)}%)`);
  console.log(`Failure: ${totalFailure} (${(totalFailure / total * 100).toFixed(0)}%)`);
  console.log(`Partial: ${totalPartial}`);
  console.log(`Total frames: ${totalFrames}`);
  console.log(`Total collisions: ${totalCollisions}`);
  console.log(`Total duration: ${(totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`\nServer: ${finalStats.traces} traces, ${finalStats.parent_nodes} parent nodes, ${finalStats.dream_cycles} dream cycles`);
  console.log(`New traces: +${finalStats.traces - initialStats.traces}`);
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Query the server for learned strategies and constraints after dreaming.
 */
async function extractLearnedKnowledge(poster: TracePoster): Promise<{ strategies: string[]; constraints: string[] }> {
  const strategies: string[] = [];
  const constraints: string[] = [];

  try {
    // Query for navigation-related strategies
    const result = await poster.queryStrategies('navigate to target robot');
    if (result.entry_point) {
      const node = await poster.getNode(result.entry_point.node_id);
      if (node.type === 'parent') {
        const parentNode = node as { trigger_goals: string[]; negative_constraints: string[]; summary: string };
        // Use summary as a strategy step
        if (parentNode.summary) {
          strategies.push(parentNode.summary);
        }
        // Extract negative constraints
        for (const c of parentNode.negative_constraints ?? []) {
          constraints.push(c);
        }
      }
    }
  } catch {
    // Server may not have enough data yet — this is fine
  }

  return { strategies, constraints };
}

// =============================================================================
// Entry Point
// =============================================================================

main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
