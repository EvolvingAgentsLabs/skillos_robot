/**
 * RoClaw Dreaming Engine v3 — Remote Memory Consolidation
 *
 * Delegates all dream processing to the evolving-memory server.
 * The local DreamEngine, StrategyStore, and TraceLogger are replaced
 * by a single HTTP call to the evolving-memory REST API.
 *
 * Prerequisites:
 *   python -m evolving_memory.server --port 8420
 *
 * Usage: npm run dream
 */

import * as dotenv from 'dotenv';
import { MemoryClient } from '../src/llmunix-core/memory_client';

dotenv.config();

// =============================================================================
// Configuration
// =============================================================================

const MEMORY_SERVER_URL = process.env.MEMORY_SERVER_URL || 'http://localhost:8420';

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  console.log('=== RoClaw Dreaming Engine v3 (Remote) ===\n');

  const client = new MemoryClient(MEMORY_SERVER_URL);

  // Health check
  try {
    const health = await client.health();
    console.log(`Memory server: ${health.status}`);
  } catch (err) {
    console.error(`Cannot reach memory server at ${MEMORY_SERVER_URL}`);
    console.error('Start it with: python -m evolving_memory.server');
    process.exit(1);
  }

  // Run dream cycle with robotics domain adapter
  console.log('\nRunning dream cycle (domain: robotics)...');
  const result = await client.runDream('robotics');

  console.log(`\nDream complete:`);
  console.log(`  Traces processed: ${result.traces_processed}`);
  console.log(`  Nodes created:    ${result.nodes_created}`);
  console.log(`  Nodes merged:     ${result.nodes_merged}`);
  console.log(`  Edges created:    ${result.edges_created}`);
  console.log(`  Constraints:      ${result.constraints_extracted}`);

  if (result.phase_log.length > 0) {
    console.log('\nPhase log:');
    for (const line of result.phase_log) {
      console.log(`  ${line}`);
    }
  }

  // Show stats
  const stats = await client.stats();
  console.log(`\nMemory stats:`);
  console.log(`  Parent nodes: ${stats.parent_nodes}`);
  console.log(`  Child nodes:  ${stats.child_nodes}`);
  console.log(`  Edges:        ${stats.edges}`);
  console.log(`  Sessions:     ${stats.sessions}`);
  console.log(`  Dream cycles: ${stats.dream_cycles}`);
}

main().catch(err => {
  console.error('Dream engine error:', err);
  process.exit(1);
});
