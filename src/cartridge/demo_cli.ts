/**
 * src/cartridge/demo_cli.ts
 *
 * Demo cartridge adapter — starts the WebSocket adapter with FRESH stub
 * subsystems registered in state.ts. Useful for testing the cartridge
 * protocol end-to-end without booting the full RoClaw runtime (which
 * requires real ESP32 hardware + Gemini API keys).
 *
 * Each cartridge method returns structurally-correct data:
 *   stop      — sends a real STOP frame if --robot-host is given;
 *               else returns HARDWARE_UNAVAILABLE (transmitter unset)
 *   observe   — returns the demo SceneGraph snapshot (red cube + blue
 *               square, planted at startup so observe always has data)
 *   describe  — returns the canned scene description
 *   set_speed — actually mutates the demo ReactiveController; subsequent
 *               getConfig() reflects the new tier
 *   navigate  — runs HierarchicalPlanner.planGoal() with a stub infer
 *               function; returns the multi-step plan
 *
 * Run with:
 *   npm run cartridge:demo
 *   npm run cartridge:demo -- --port 7424 --robot-host 192.168.1.100
 */

import { startCartridgeAdapter } from './adapter';
import { setRobotState } from './state';
import { UDPTransmitter } from '../bridge/udp_transmitter';
import { SceneGraph } from '../brain/memory/scene_graph';
import { ReactiveController } from '../control/reactive_controller';
import { HierarchicalPlanner } from '../brain/planning/planner';
import { MemoryManager } from '../brain/memory/memory_manager';
import type { InferenceFunction } from '../llmunix-core/interfaces';

// Parse args
const args = process.argv.slice(2);
let port = 7424;
let robotHost: string | undefined;
let robotPort = 4210;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
  else if (args[i] === '--robot-host' && args[i + 1]) robotHost = args[++i];
  else if (args[i] === '--robot-port' && args[i + 1]) robotPort = parseInt(args[++i], 10);
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`Usage: tsx src/cartridge/demo_cli.ts [options]

Options:
  --port <n>           WebSocket port (default 7424)
  --robot-host <ip>    Optional ESP32 IP for stop method
  --robot-port <n>     ESP32 UDP port (default 4210)

Starts the cartridge adapter with FRESH stub subsystems wired into
state.ts so all 5 cartridge methods return structurally-correct
responses without needing real hardware. Useful for testing the
cartridge protocol end-to-end.`);
    process.exit(0);
  }
}

// ── Stub inference function for HierarchicalPlanner ────────────────
// The planner calls this with (systemPrompt, userPrompt) and expects
// JSON-shaped output. We return a canned 2-step plan so navigate() has
// something realistic to return.
const stubInfer: InferenceFunction = async (_system, user) => {
  // Extract goal from user prompt (last "Goal: ..." line, if present).
  const m = user.match(/Goal:\s*(.+)/);
  const goal = m ? m[1].trim() : 'unknown';
  return JSON.stringify({
    steps: [
      { description: `Navigate toward: ${goal}`, targetLabel: goal },
      { description: `Confirm arrival at ${goal}`, targetLabel: null },
    ],
  });
};

async function main() {
  console.log('[demo] constructing stub subsystems...');

  // SceneGraph with a couple of demo objects so observe() is non-empty.
  const sceneGraph = new SceneGraph();
  sceneGraph.addOrUpdateNode({ id: 'red_cube',    label: 'red_cube',    x: 120, y: 35, confidence: 0.94 });
  sceneGraph.addOrUpdateNode({ id: 'blue_square', label: 'blue_square', x: 40,  y: 220, confidence: 0.88 });
  sceneGraph.updateRobotPose(80, 100, 90);

  // ReactiveController with default tuning.
  const reactiveController = new ReactiveController();

  // MemoryManager + HierarchicalPlanner (stub infer).
  const memoryManager = new MemoryManager();
  const planner = new HierarchicalPlanner(stubInfer, memoryManager);

  // Optional UDP transmitter for stop().
  let transmitter: UDPTransmitter | undefined;
  if (robotHost) {
    transmitter = new UDPTransmitter({ host: robotHost, port: robotPort });
    try {
      await transmitter.connect();
      console.log(`[demo] UDP transmitter → ${robotHost}:${robotPort}`);
    } catch (err) {
      console.warn(`[demo] UDP connect failed: ${(err as Error).message} — stop will return HARDWARE_UNAVAILABLE`);
      transmitter = undefined;
    }
  } else {
    console.log('[demo] no --robot-host; stop will return HARDWARE_UNAVAILABLE');
  }

  // Register everything in state.ts.
  setRobotState({
    transmitter,
    sceneGraph,
    reactiveController,
    planner,
    lastDescription: {
      text: 'A red cube and a blue square in an otherwise empty arena. The robot faces north.',
      timestamp: Date.now(),
    },
  });

  console.log('[demo] state.ts populated. Wired methods: ' +
    [
      transmitter ? 'stop' : 'stop(unavailable)',
      'observe',
      'describe',
      'set_speed',
      'navigate',
    ].join(', '));

  const server = startCartridgeAdapter({ port });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[demo] shutting down...');
    if (transmitter) await transmitter.disconnect().catch(() => undefined);
    await server.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[demo] fatal:', err);
  process.exit(1);
});
