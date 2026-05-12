#!/usr/bin/env tsx
// src/orchestrator/run_sim.ts
//
// Integrated simulation runner: ISA orchestrator + 20 Hz motor control loop
// with 2D browser visualization via WebSocket.
//
// The script drives the robot's "brain" (Gemma 4 via OpenRouter) and
// "motor cortex" (ReactiveController → dead-reckoning kinematics).
// A WebSocket server broadcasts pose, goal, speech, and arrival events
// to sim/sim2d.html for real-time 2D top-down visualization.
//
// Run:
//   OPENROUTER_API_KEY=sk-or-v1-... npx tsx src/orchestrator/run_sim.ts
//
// Then open in browser:
//   http://localhost:9092

import * as dotenv from 'dotenv';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { OpenRouterBackend } from './backend';
import { Executor } from './executor';
import { StubIOAdapter } from './io';
import { setRobotState } from '../cartridge/state';
import { SceneGraph } from '../brain/memory/scene_graph';
import { ReactiveController, type ControllerGoal } from '../control/reactive_controller';
import { HierarchicalPlanner } from '../brain/planning/planner';
import { MemoryManager } from '../brain/memory/memory_manager';
import { UDPTransmitter } from '../bridge/udp_transmitter';
import { Opcode, encodeFrame } from '../control/bytecode_compiler';
import type { InferenceFunction } from '../llmunix-core/interfaces';

dotenv.config();

async function main(): Promise<void> {
  const model = process.env.ORCHESTRATOR_MODEL || 'google/gemma-4-26b-a4b-it';
  const bridgeHost = process.env.BRIDGE_HOST || '127.0.0.1';
  const bridgePort = Number(process.env.BRIDGE_PORT || '4210');

  const wsPort = Number(process.env.SIM_WS_PORT || '9091');
  const httpPort = Number(process.env.SIM_HTTP_PORT || '9092');

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Care Assistant — 2D Simulation                           ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Orchestrator: Gemma 4 via OpenRouter (ISA opcodes)       ║');
  console.log('║  Motor loop:   ReactiveController @ 20 Hz (dead reckon)  ║');
  console.log('║  Visualizer:   sim2d.html via WebSocket                   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`  Model:      ${model}`);
  console.log(`  Bridge UDP: ${bridgeHost}:${bridgePort} (optional)`);
  console.log(`  2D viewer:  http://localhost:${httpPort}`);
  console.log(`  WebSocket:  ws://localhost:${wsPort}`);
  console.log();

  // ── WebSocket server for 2D visualization ─────────────────────
  const wss = new WebSocketServer({ port: wsPort });
  const wsClients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    console.log(`  [ws] Client connected (${wsClients.size} total)`);
    ws.on('close', () => {
      wsClients.delete(ws);
      console.log(`  [ws] Client disconnected (${wsClients.size} total)`);
    });
  });

  function broadcast(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  // ── HTTP server to serve sim2d.html ───────────────────────────
  const simHtmlPath = path.resolve(__dirname, '../../sim/sim2d.html');
  const httpServer = http.createServer((_req, res) => {
    fs.readFile(simHtmlPath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('sim2d.html not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  });
  httpServer.listen(httpPort, () => {
    console.log(`  [http] Serving sim2d.html at http://localhost:${httpPort}`);
  });

  // ── Build SceneGraph (cm, matching MJCF * 100) ────────────────────
  const sceneGraph = new SceneGraph();

  sceneGraph.addOrUpdateNode({
    id: 'person_1', label: 'person_1 (yellow cube)',
    x: -60, y: -50, confidence: 0.95,
  });
  sceneGraph.addOrUpdateNode({
    id: 'person_2', label: 'person_2 (orange cube)',
    x: 60, y: -50, confidence: 0.93,
  });
  sceneGraph.addOrUpdateNode({
    id: 'blue_door', label: 'blue_door (tall blue cube)',
    x: -80, y: 150, confidence: 0.97,
  });
  sceneGraph.addOrUpdateNode({
    id: 'green_door', label: 'green_door (tall green cube)',
    x: 80, y: 150, confidence: 0.96,
  });
  sceneGraph.addOrUpdateNode({
    id: 'obstacle', label: 'obstacle (gray cube)',
    x: 30, y: 50, confidence: 0.90,
  });

  // Robot starts at (0, -100) cm, heading 90° (north in MuJoCo +Y)
  sceneGraph.updateRobotPose(0, -100, 90);

  // ── Motor control subsystems ──────────────────────────────────────
  const reactiveController = new ReactiveController({
    arrivalThresholdCm: 25,   // 25 cm arrival radius (generous for dead reckoning)
    cruiseSpeed: 240,         // fast cruise in sim
    approachSpeed: 120,
    rotationSpeed: 80,
  });

  // UDP transmitter is optional — works without bridge for dead-reckoning-only mode
  let transmitter: UDPTransmitter | null = null;
  try {
    transmitter = new UDPTransmitter({
      host: bridgeHost,
      port: bridgePort,
      timeoutMs: 500,
      maxRetries: 0,
    });
    await transmitter.connect();
    console.log('  UDP transmitter connected (bridge mode)\n');
  } catch {
    console.log('  UDP transmitter unavailable — dead reckoning only\n');
  }

  // ── Control loop state ────────────────────────────────────────────
  let currentGoal: ControllerGoal | null = null;
  let arrivalResolve: ((value: unknown) => void) | null = null;
  let controlTicks = 0;

  // Listen for bridge telemetry (JSON over UDP)
  if (transmitter) {
    transmitter.onMessage((msg) => {
      try {
        const json = JSON.parse(msg.toString());
        if (json.telemetry && json.pose) {
          const x = json.pose.x as number;
          const y = json.pose.y as number;
          const h = json.pose.h as number;
          if (x === 0 && y === 0 && h === 0) return;
          hasBridgeTelemetry = true;
          sceneGraph.updateRobotPose(x * 100, y * 100, (h * 180) / Math.PI);
        }
      } catch { /* ignore */ }
    });
    const stopFrame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
    await transmitter.send(stopFrame);
  }

  // ── Dead-reckoning kinematic model ──────────────────────────────
  // RoClaw chassis from MJCF: wheel radius 0.03m, wheel base 0.10m
  // Max wheel angular velocity: 1.5708 rad/s (from ctrlrange)
  const WHEEL_RADIUS_CM = 3.0;        // 0.03m → 3cm
  const WHEEL_BASE_CM = 10.0;         // 0.10m → 10cm
  const MAX_WHEEL_RAD_S = 1.5708;
  const speedToRadS = (param: number) => (param / 255) * MAX_WHEEL_RAD_S;
  let hasBridgeTelemetry = false;

  /**
   * Apply differential drive kinematics to update robot pose from a bytecode
   * frame. Used as fallback when no browser telemetry is available.
   */
  function deadReckon(bc: { opcode: number; paramLeft: number; paramRight: number }, dt: number): void {
    if (hasBridgeTelemetry) return; // prefer real physics

    let leftRadS = 0;
    let rightRadS = 0;

    switch (bc.opcode) {
      case Opcode.MOVE_FORWARD:
        leftRadS = speedToRadS(bc.paramLeft);
        rightRadS = speedToRadS(bc.paramRight);
        break;
      case Opcode.MOVE_BACKWARD:
        leftRadS = -speedToRadS(bc.paramLeft);
        rightRadS = -speedToRadS(bc.paramRight);
        break;
      case Opcode.ROTATE_CW: {
        const vel = speedToRadS(bc.paramRight || bc.paramLeft);
        leftRadS = vel;
        rightRadS = -vel;
        break;
      }
      case Opcode.ROTATE_CCW: {
        const vel = speedToRadS(bc.paramRight || bc.paramLeft);
        leftRadS = -vel;
        rightRadS = vel;
        break;
      }
      default:
        return; // STOP or unknown — no motion
    }

    const vLeft = leftRadS * WHEEL_RADIUS_CM;
    const vRight = rightRadS * WHEEL_RADIUS_CM;
    const v = (vLeft + vRight) / 2;
    const omega = (vRight - vLeft) / WHEEL_BASE_CM;

    const robot = sceneGraph.robot;
    const headingRad = (robot.getHeadingDegrees() * Math.PI) / 180;

    const newX = robot.position[0] + v * Math.cos(headingRad) * dt;
    const newY = robot.position[1] + v * Math.sin(headingRad) * dt;
    const newHeadingRad = headingRad + omega * dt;
    const newHeadingDeg = (newHeadingRad * 180) / Math.PI;

    sceneGraph.updateRobotPose(newX, newY, newHeadingDeg);
  }

  // 20 Hz reactive motor control loop
  const CONTROL_HZ = 20;
  const DT = 1 / CONTROL_HZ;
  const controlInterval = setInterval(() => {
    if (!currentGoal) return;

    const decision = reactiveController.decide(sceneGraph, currentGoal);

    // Apply dead reckoning BEFORE sending (so next tick has updated pose)
    deadReckon(decision.bytecode, DT);

    if (transmitter) {
      transmitter.send(decision.frame).catch((err) => {
        console.error('  [ctrl] UDP send error:', (err as Error).message);
      });
    }

    // Broadcast pose to 2D viewer (every 4th tick = 5 Hz — smooth enough, low overhead)
    controlTicks++;
    if (controlTicks % 4 === 0) {
      const robot = sceneGraph.robot;
      broadcast({
        type: 'pose',
        x: Math.round(robot.position[0]),
        y: Math.round(robot.position[1]),
        heading: Math.round(robot.getHeadingDegrees()),
        action: decision.action,
        distance: Math.round(decision.distanceCm),
      });
    }
    if (controlTicks % 40 === 0) {
      // Log every 2s
      const robot = sceneGraph.robot;
      console.log(
        `  [ctrl] tick=${controlTicks} action=${decision.action} ` +
        `d=${Math.round(decision.distanceCm)}cm bearing=${Math.round(decision.bearingDeg)}° ` +
        `robot=(${Math.round(robot.position[0])},${Math.round(robot.position[1])}) ` +
        `heading=${Math.round(robot.getHeadingDegrees())}°`,
      );
    }

    if (decision.action === 'arrived') {
      console.log(`  [ctrl] ARRIVED: ${decision.reason}`);
      broadcast({ type: 'arrived', reason: decision.reason });
      currentGoal = null;
      controlTicks = 0;
      if (transmitter) {
        const sf = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
        transmitter.send(sf).catch(() => {});
      }
      if (arrivalResolve) {
        const resolve = arrivalResolve;
        arrivalResolve = null;
        resolve({ event: 'arrived', reason: decision.reason });
      }
    }
  }, 1000 / CONTROL_HZ);

  // ── Planner (stub — returns goal as a single-step plan) ───────────
  const memoryManager = new MemoryManager();
  const stubInfer: InferenceFunction = async (_system, user) => {
    const m = user.match(/Goal:\s*(.+)/);
    const goal = m ? m[1].trim() : 'unknown';
    return JSON.stringify({
      steps: [
        { description: `Navigate toward: ${goal}`, targetLabel: goal },
      ],
    });
  };
  const planner = new HierarchicalPlanner(stubInfer, memoryManager);

  // ── I/O adapter (stub: canned responses for demo) ─────────────────
  const ioAdapter = new StubIOAdapter({
    responses: [
      'Hello! My name is Maria.',
      'I would like to go to the green door please.',
      'Yes, the green door.',
      'Thank you so much for helping me!',
      'Goodbye!',
    ],
  });

  // ── Register everything in global state ───────────────────────────
  setRobotState({
    sceneGraph,
    reactiveController,
    planner,
    ioAdapter,
    transmitter: transmitter ?? undefined,
    lastDescription: {
      text: 'A room with two people nearby (yellow cube to the left, orange cube to the right). Two tall door cubes are visible in the distance: a blue door to the northwest and a green door to the northeast. A small gray obstacle sits in the middle of the room. The robot is facing north.',
      timestamp: Date.now(),
    },
  });

  // ── OpenRouter backend ────────────────────────────────────────────
  const backend = new OpenRouterBackend({
    apiKey: process.env.OPENROUTER_API_KEY,
    model,
    maxTokens: 300,
    temperature: 0.3,
  });

  // ── Task description ──────────────────────────────────────────────
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

  // ── fd=3 navigation wait handler ──────────────────────────────────
  // Blocks until the 20 Hz control loop detects arrival, or 60s timeout.
  const navHandler = {
    wait: () =>
      new Promise<unknown>((resolve) => {
        const timeout = setTimeout(() => {
          if (arrivalResolve) {
            arrivalResolve = null;
            resolve({ event: 'timeout', reason: 'navigation timed out after 120s' });
          }
        }, 120_000);

        arrivalResolve = (value) => {
          clearTimeout(timeout);
          resolve(value);
        };
      }),
    read: async () => ({
      status: currentGoal ? 'navigating' : 'idle',
      robot: {
        x: Math.round(sceneGraph.robot.position[0]),
        y: Math.round(sceneGraph.robot.position[1]),
        heading: Math.round(sceneGraph.robot.getHeadingDegrees()),
      },
    }),
  };

  // ── Create executor ───────────────────────────────────────────────
  const executor = new Executor({
    backend,
    task,
    maxSteps: 30,
    ioAdapter,
    ioHandlers: { 'fd:3': navHandler },
    onOpcode: (op, step) => {
      const thinkStr = op.think ? ` [think: ${op.think.slice(0, 80)}...]` : '';
      console.log(`  [${step}] ${op.type}${thinkStr}`);

      // Broadcast opcode step to viewer
      broadcast({ type: 'opcode', step, opType: op.type });

      // Intercept navigate calls → set control loop goal
      // CallOpcode has { cartridge: 'robot', method: 'navigate', args: {...} }
      if (op.type === 'call') {
        const callOp = op as { cartridge: string; method: string; args: Record<string, unknown> } & typeof op;

        // Broadcast speak/listen calls
        if (callOp.method === 'speak') {
          const text = String(callOp.args?.text ?? '');
          broadcast({ type: 'speak', text, step });
        } else if (callOp.method === 'listen') {
          // listen result is broadcast in onResult
        }

        if (callOp.method === 'navigate') {
        const goalStr = String(callOp.args?.goal ?? '').trim();
        if (goalStr) {
          // Try exact match first
          let node = sceneGraph.getNode(goalStr);
          if (!node) {
            // Try partial match (e.g., "green_door" in "green_door (tall green cube)")
            const all = sceneGraph.getAllNodes();
            const match = all.find(
              (n) => n.id.includes(goalStr) || n.label.toLowerCase().includes(goalStr.toLowerCase()),
            );
            if (match) node = match;
          }
          if (node) {
            currentGoal = { kind: 'node', id: node.id };
            broadcast({ type: 'goal', goalId: node.id });
            console.log(
              `  [ctrl] → Goal set: ${node.id} at (${Math.round(node.position[0])}, ${Math.round(node.position[1])})`,
            );
          } else {
            console.log(`  [ctrl] ⚠ Could not resolve goal "${goalStr}" in scene graph`);
          }
        }
        }
      }

      // Broadcast halt
      if (op.type === 'halt') {
        const haltOp = op as { status?: string } & typeof op;
        broadcast({ type: 'halt', status: haltOp.status || 'unknown' });
      }
    },
    onResult: (result, step) => {
      const str = typeof result === 'string' ? result : JSON.stringify(result);
      if (str.length > 150) {
        console.log(`  [${step}] -> ${str.slice(0, 147)}...`);
      } else {
        console.log(`  [${step}] -> ${str}`);
      }

      // Broadcast listen results (person's response)
      if (typeof result === 'object' && result !== null && 'text' in result) {
        const listenResult = result as { text?: string };
        if (listenResult.text) {
          broadcast({ type: 'listen', text: listenResult.text, step });
        }
      }
    },
  });

  // ── Run ───────────────────────────────────────────────────────────
  try {
    const result = await executor.run();

    console.log('\n' + '='.repeat(60));
    console.log(`Execution complete: status=${result.status}, steps=${result.steps}`);

    if (Object.keys(result.state).length > 0) {
      console.log('Committed state:', JSON.stringify(result.state, null, 2));
    }

    const opTypes = result.trace.reduce((acc, t) => {
      acc[t.type] = (acc[t.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log('Opcode distribution:', JSON.stringify(opTypes));

    const spoken = ioAdapter.getSpoken();
    if (spoken.length > 0) {
      console.log('\nRobot spoke:');
      spoken.forEach((text, i) => console.log(`  ${i + 1}. "${text}"`));
    }
  } finally {
    // Cleanup
    clearInterval(controlInterval);
    if (transmitter) {
      const sf = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
      await transmitter.send(sf).catch(() => {});
      await transmitter.disconnect();
    }
    ioAdapter.destroy();
    wss.close();
    httpServer.close();
    console.log('\nCleanup complete.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
