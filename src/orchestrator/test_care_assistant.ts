#!/usr/bin/env tsx
// src/orchestrator/test_care_assistant.ts
//
// Test scenario: 2 people cubes + 2 door cubes.
// The robot approaches a person, asks which door they want, then navigates.
//
// Scene layout (centimeters, matching roclaw_care_assistant.xml):
//   person_1: yellow cube at (-60, -50)
//   person_2: orange cube at (60, -50)
//   blue_door: tall blue cube at (-80, 150)
//   green_door: tall green cube at (80, 150)
//   obstacle: gray cube at (30, 50)
//   robot: starts at (0, -100), heading north (90°)
//
// Run:
//   OPENROUTER_API_KEY=sk-or-v1-... npx tsx src/orchestrator/test_care_assistant.ts

import * as dotenv from 'dotenv';
import { OpenRouterBackend } from './backend';
import { Executor } from './executor';
import { StubIOAdapter } from './io';
import { setRobotState } from '../cartridge/state';
import { SceneGraph } from '../brain/memory/scene_graph';
import { ReactiveController } from '../control/reactive_controller';
import { HierarchicalPlanner } from '../brain/planning/planner';
import { MemoryManager } from '../brain/memory/memory_manager';
import type { InferenceFunction } from '../llmunix-core/interfaces';

dotenv.config();

async function main(): Promise<void> {
  const model = process.env.ORCHESTRATOR_MODEL || 'google/gemma-4-26b-a4b-it';

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Care Assistant Test — Door Choice Scenario               ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Scene: 2 people (yellow, orange) + 2 doors (blue, green) ║');
  console.log('║  Task:  Ask person which door → navigate to it            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`  Model: ${model}`);
  console.log();

  // ── Build SceneGraph matching the MJCF scene ───────────────────
  // MuJoCo uses meters, SceneGraph uses centimeters.
  const sceneGraph = new SceneGraph();

  // People (yellow and orange cubes)
  sceneGraph.addOrUpdateNode({
    id: 'person_1', label: 'person_1 (yellow cube)',
    x: -60, y: -50, confidence: 0.95,
  });
  sceneGraph.addOrUpdateNode({
    id: 'person_2', label: 'person_2 (orange cube)',
    x: 60, y: -50, confidence: 0.93,
  });

  // Doors (blue and green tall cubes)
  sceneGraph.addOrUpdateNode({
    id: 'blue_door', label: 'blue_door (tall blue cube)',
    x: -80, y: 150, confidence: 0.97,
  });
  sceneGraph.addOrUpdateNode({
    id: 'green_door', label: 'green_door (tall green cube)',
    x: 80, y: 150, confidence: 0.96,
  });

  // Obstacle
  sceneGraph.addOrUpdateNode({
    id: 'obstacle', label: 'obstacle (gray cube)',
    x: 30, y: 50, confidence: 0.90,
  });

  // Robot starts at (0, -100), facing north
  sceneGraph.updateRobotPose(0, -100, 90);

  // ── Stub subsystems ────────────────────────────────────────────
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

  // ── Stub I/O: person says they want the green door ─────────────
  const ioAdapter = new StubIOAdapter({
    responses: [
      'Hello! My name is Maria.',
      'I would like to go to the green door please.',
      'Yes, the green door.',
      'Thank you so much for helping me!',
      'Goodbye!',
    ],
  });

  // ── Register everything in state ───────────────────────────────
  setRobotState({
    sceneGraph,
    reactiveController,
    planner,
    ioAdapter,
    lastDescription: {
      text: 'A room with two people nearby (yellow cube to the left, orange cube to the right). Two tall door cubes are visible in the distance: a blue door to the northwest and a green door to the northeast. A small gray obstacle sits in the middle of the room. The robot is facing north.',
      timestamp: Date.now(),
    },
  });

  // ── Initialize backend ────────────────────────────────────────
  const backend = new OpenRouterBackend({
    apiKey: process.env.OPENROUTER_API_KEY,
    model,
    maxTokens: 300,
    temperature: 0.3,
  });

  // ── Task description ──────────────────────────────────────────
  const task = `You are a care assistant robot in a room with two people and two doors.

SCENE:
- person_1 (yellow cube) is to your left at (-60, -50)
- person_2 (orange cube) is to your right at (60, -50)
- blue_door (tall blue cube) is far ahead to the left at (-80, 150)
- green_door (tall green cube) is far ahead to the right at (80, 150)
- You are at (0, -100), facing north

YOUR TASK:
1. Greet the nearest person
2. Ask them which door they would like to go to (blue or green)
3. Listen to their answer
4. Confirm their choice
5. Navigate to the door they selected
6. When you arrive (or timeout), tell them you've arrived
7. Halt with success

Use robot.speak to talk, robot.listen to hear, robot.observe to see, and robot.navigate to move.`;

  // ── Custom fd=3 handler: simulate arrival after 2s ──────────
  // In a real scenario, VisionLoop would emit 'arrival' when the robot
  // reaches the target. Here we simulate it so the full flow completes.
  let navWaitCount = 0;
  const simNavHandler = {
    wait: () => new Promise<unknown>((resolve) => {
      navWaitCount++;
      setTimeout(() => {
        resolve({ event: 'arrived', reason: `simulated arrival at target (nav wait #${navWaitCount})` });
      }, 2000);
    }),
    read: async () => ({ status: 'no navigation events pending' }),
  };

  // ── Create and run executor ───────────────────────────────────
  const executor = new Executor({
    backend,
    task,
    maxSteps: 30,
    ioAdapter,
    ioHandlers: { 'fd:3': simNavHandler },
    onOpcode: (op, step) => {
      const thinkStr = op.think ? ` [think: ${op.think.slice(0, 80)}...]` : '';
      console.log(`  [${step}] ${op.type}${thinkStr}`);
    },
    onResult: (result, step) => {
      const str = typeof result === 'string' ? result : JSON.stringify(result);
      if (str.length > 150) {
        console.log(`  [${step}] -> ${str.slice(0, 147)}...`);
      } else {
        console.log(`  [${step}] -> ${str}`);
      }
    },
  });

  try {
    const result = await executor.run();

    console.log('\n' + '='.repeat(60));
    console.log(`Execution complete: status=${result.status}, steps=${result.steps}`);
    if (Object.keys(result.state).length > 0) {
      console.log('Committed state:', JSON.stringify(result.state, null, 2));
    }

    // Show opcode distribution
    const opTypes = result.trace.reduce((acc, t) => {
      acc[t.type] = (acc[t.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log('Opcode distribution:', JSON.stringify(opTypes));

    // Show what the robot spoke
    const spoken = ioAdapter.getSpoken();
    if (spoken.length > 0) {
      console.log('\nRobot spoke:');
      spoken.forEach((text, i) => console.log(`  ${i + 1}. "${text}"`));
    }
  } finally {
    ioAdapter.destroy();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
