#!/usr/bin/env tsx
// src/orchestrator/cli.ts
// Standalone CLI runner for the ISA orchestrator.
//
// Demo mode (no hardware):
//   OPENROUTER_API_KEY=sk-or-v1-... npm run orchestrator:demo
//
// Dataset generation (stub I/O, automated):
//   OPENROUTER_API_KEY=sk-or-v1-... npm run orchestrator:dataset
//
// With real hardware:
//   OPENROUTER_API_KEY=sk-or-v1-... npm run orchestrator -- --task "Go to the kitchen"

import * as dotenv from 'dotenv';
import { OpenRouterBackend } from './backend';
import { Executor } from './executor';
import { createIOAdapter, StubIOAdapter } from './io';
import { setRobotState } from '../cartridge/state';
import { SceneGraph } from '../brain/memory/scene_graph';
import { ReactiveController } from '../control/reactive_controller';
import { HierarchicalPlanner } from '../brain/planning/planner';
import { MemoryManager } from '../brain/memory/memory_manager';
import type { InferenceFunction } from '../llmunix-core/interfaces';

dotenv.config();

// ── Parse CLI args ──────────────────────────────────────────────

interface CLIArgs {
  task: string;
  model: string;
  io: 'console' | 'macos' | 'stub';
  maxSteps: number;
  dataset: boolean;
  datasetRuns: number;
  datasetOutput: string;
}

function parseArgs(): CLIArgs {
  const argv = process.argv.slice(2);
  const args: CLIArgs = {
    task: 'You are a friendly elderly care robot assistant. Greet the user, ask how you can help, and assist them with navigation or information.',
    model: process.env.ORCHESTRATOR_MODEL || 'google/gemma-4-26b-a4b-it',
    io: 'console',
    maxSteps: 100,
    dataset: false,
    datasetRuns: 10,
    datasetOutput: 'dataset/robot_isa_steps.jsonl',
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--task':
        args.task = argv[++i] || args.task;
        break;
      case '--model':
        args.model = argv[++i] || args.model;
        break;
      case '--io':
        args.io = (argv[++i] || 'console') as CLIArgs['io'];
        break;
      case '--max-steps':
        args.maxSteps = parseInt(argv[++i] || '100', 10);
        break;
      case '--dataset':
        args.dataset = true;
        break;
      case '--dataset-runs':
        args.datasetRuns = parseInt(argv[++i] || '10', 10);
        break;
      case '--dataset-output':
        args.datasetOutput = argv[++i] || args.datasetOutput;
        break;
      case '--help':
      case '-h':
        console.log(`Usage: tsx src/orchestrator/cli.ts [options]

Options:
  --task <text>           Task/instruction for the LLM (default: care assistant greeting)
  --model <id>            OpenRouter model ID (default: google/gemma-4-27b-it)
  --io <type>             I/O adapter: console, macos, stub (default: console)
  --max-steps <n>         Max ISA steps before forced halt (default: 100)
  --dataset               Dataset generation mode (uses stub I/O, no interaction)
  --dataset-runs <n>      Number of runs for dataset generation (default: 10)
  --dataset-output <path> Output JSONL file (default: dataset/robot_isa_steps.jsonl)

Environment:
  OPENROUTER_API_KEY      Required. OpenRouter API key.
  ORCHESTRATOR_MODEL      Default model (overridden by --model).

Examples:
  # Interactive demo (console I/O, no hardware):
  npm run orchestrator:demo

  # Interactive with macOS TTS:
  npm run orchestrator -- --io macos --task "Help me find the kitchen"

  # Automated dataset generation:
  npm run orchestrator:dataset`);
        process.exit(0);
    }
  }

  return args;
}

// ── Stub subsystems (for demo/dataset mode) ─────────────────────

function setupStubSubsystems(): void {
  const sceneGraph = new SceneGraph();
  sceneGraph.addOrUpdateNode({ id: 'kitchen_door', label: 'kitchen_door', x: 200, y: 50, confidence: 0.92 });
  sceneGraph.addOrUpdateNode({ id: 'hallway', label: 'hallway', x: 100, y: 100, confidence: 0.88 });
  sceneGraph.addOrUpdateNode({ id: 'chair', label: 'chair', x: 60, y: 180, confidence: 0.85 });
  sceneGraph.updateRobotPose(80, 150, 0);

  const reactiveController = new ReactiveController();
  const memoryManager = new MemoryManager();

  const stubInfer: InferenceFunction = async (_system, user) => {
    const m = user.match(/Goal:\s*(.+)/);
    const goal = m ? m[1].trim() : 'unknown';
    return JSON.stringify({
      steps: [
        { description: `Navigate toward: ${goal}`, targetLabel: goal },
        { description: `Confirm arrival at ${goal}`, targetLabel: null },
      ],
    });
  };

  const planner = new HierarchicalPlanner(stubInfer, memoryManager);

  setRobotState({
    sceneGraph,
    reactiveController,
    planner,
    lastDescription: {
      text: 'An open room with a kitchen door ahead, a hallway to the left, and a chair nearby. The robot is facing north.',
      timestamp: Date.now(),
    },
  });
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('╔════════════════════════════════════════════╗');
  console.log('║  skillos_robot ISA Orchestrator            ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`  Model:     ${args.model}`);
  console.log(`  I/O:       ${args.io}`);
  console.log(`  Max steps: ${args.maxSteps}`);
  if (args.dataset) {
    console.log(`  Mode:      DATASET (${args.datasetRuns} runs → ${args.datasetOutput})`);
  } else {
    console.log(`  Task:      ${args.task.slice(0, 80)}...`);
  }
  console.log();

  // Initialize backend
  const backend = new OpenRouterBackend({
    apiKey: process.env.OPENROUTER_API_KEY,
    model: args.model,
    maxTokens: 300,
    temperature: 0.3,
  });

  // Setup stub subsystems (demo mode — no real hardware)
  setupStubSubsystems();

  if (args.dataset) {
    // Dataset generation mode: automated runs with stub I/O
    await runDatasetGeneration(backend, args);
  } else {
    // Interactive mode
    await runInteractive(backend, args);
  }
}

async function runInteractive(backend: OpenRouterBackend, args: CLIArgs): Promise<void> {
  const ioAdapter = createIOAdapter(args.io);

  // Register IO adapter in state for speak/listen methods
  setRobotState({ ioAdapter });

  const executor = new Executor({
    backend,
    task: args.task,
    maxSteps: args.maxSteps,
    ioAdapter,
    onOpcode: (op, step) => {
      const thinkStr = op.think ? ` [think: ${op.think.slice(0, 60)}...]` : '';
      console.log(`  [${step}] ${op.type}${thinkStr}`);
    },
    onResult: (result, step) => {
      const str = typeof result === 'string' ? result : JSON.stringify(result);
      console.log(`  [${step}] → ${str.slice(0, 120)}`);
    },
  });

  try {
    const result = await executor.run();
    console.log(`\nExecution complete: status=${result.status}, steps=${result.steps}`);
    if (Object.keys(result.state).length > 0) {
      console.log('Committed state:', JSON.stringify(result.state, null, 2));
    }
  } finally {
    ioAdapter.destroy();
  }
}

async function runDatasetGeneration(backend: OpenRouterBackend, args: CLIArgs): Promise<void> {
  const scenarios = [
    'You are a care robot. A person approaches. Greet them, ask their name, and offer to help.',
    'You are a care robot. Guide the user to the kitchen. Ask which route they prefer.',
    'You are a care robot. The user asks about their medication schedule. Help them.',
    'You are a care robot. Observe the room, describe what you see, and ask if the user needs anything moved.',
    'You are a care robot. The user seems lost. Ask where they want to go and navigate there.',
  ];

  let totalExamples = 0;

  for (let run = 0; run < args.datasetRuns; run++) {
    const scenario = scenarios[run % scenarios.length];
    const ioAdapter = new StubIOAdapter();
    setRobotState({ ioAdapter });

    console.log(`  Run ${run + 1}/${args.datasetRuns}: ${scenario.slice(0, 60)}...`);

    const executor = new Executor({
      backend,
      task: scenario,
      maxSteps: args.maxSteps,
      ioAdapter,
    });

    try {
      await executor.run();
      const count = executor.saveDataset(args.datasetOutput);
      totalExamples += count;
      console.log(`    → ${count} examples (total: ${totalExamples})`);
    } catch (err) {
      console.error(`    → ERROR: ${(err as Error).message}`);
    }

    ioAdapter.destroy();
  }

  console.log(`\nDataset generation complete: ${totalExamples} total examples → ${args.datasetOutput}`);
}

// ── Entry point ─────────────────────────────────────────────────

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
