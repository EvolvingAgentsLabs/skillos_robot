/**
 * RoClaw mjswan Full Loop — Full cognitive stack runner
 *
 * Runs the complete cognitive pipeline via handleTool():
 *   MemoryManager → HierarchicalPlanner → NavigationSession → VisionLoop
 *   + SemanticMapLoop (background) + TraceLogger (hierarchical traces)
 *
 * Prerequisites:
 *   1. mjswan scene running: cd sim && python build_scene.py
 *   2. Bridge running: npm run sim:3d
 *   3. Browser open: http://localhost:8000?bridge=ws://localhost:9090
 *
 * Usage:
 *   npx tsx scripts/run_sim3d.ts --goal "navigate to the red box"
 *   npx tsx scripts/run_sim3d.ts --explore
 *   npx tsx scripts/run_sim3d.ts --goal "the red cube" --dream
 *   npx tsx scripts/run_sim3d.ts --goal "the door" --constraints "stay close to walls"
 *   npx tsx scripts/run_sim3d.ts --help
 */

import * as dgram from 'dgram';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { logger } from '../src/shared/logger';
import { BytecodeCompiler, Opcode, encodeFrame, formatHex } from '../src/2_qwen_cerebellum/bytecode_compiler';
import { UDPTransmitter } from '../src/2_qwen_cerebellum/udp_transmitter';
import { VisionLoop } from '../src/2_qwen_cerebellum/vision_loop';
import { CerebellumInference } from '../src/2_qwen_cerebellum/inference';
import { GeminiRoboticsInference, ROCLAW_TOOL_DECLARATIONS } from '../src/2_qwen_cerebellum/gemini_robotics';
import { handleTool, type ToolContext } from '../src/1_openclaw_cortex/roclaw_tools';
import { MemoryClient } from '../src/llmunix-core/memory_client';
import { TraceSource } from '../src/llmunix-core/types';

dotenv.config();

// =============================================================================
// Configuration
// =============================================================================

const config = {
  esp32Host: process.env.ESP32_S3_HOST || '127.0.0.1',
  esp32Port: parseInt(process.env.ESP32_S3_PORT || '4210', 10),
  cameraHost: process.env.ESP32_CAM_HOST || '127.0.0.1',
  cameraPort: parseInt(process.env.ESP32_CAM_PORT || '8081', 10),
  cameraPath: process.env.ESP32_CAM_PATH || '/stream',
  frameHistorySize: parseInt(process.env.FRAME_HISTORY_SIZE || '4', 10),
  apiKey: process.env.OPENROUTER_API_KEY || '',
  model: process.env.QWEN_MODEL || 'qwen/qwen-2.5-vl-72b-instruct',
  localInferenceUrl: process.env.LOCAL_INFERENCE_URL,
};

// =============================================================================
// CLI parsing
// =============================================================================

let goal = '';
let mode: 'go_to' | 'explore' = 'go_to';
let dreamOnShutdown: boolean | undefined;
let constraints: string | undefined;
let useGemini = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--goal':
      goal = args[++i] || '';
      break;
    case '--explore':
      mode = 'explore';
      break;
    case '--dream':
      dreamOnShutdown = true;
      break;
    case '--no-dream':
      dreamOnShutdown = false;
      break;
    case '--constraints':
      constraints = args[++i] || '';
      break;
    case '--gemini':
      useGemini = true;
      break;
    case '--help':
      console.log(`Usage: npx tsx scripts/run_sim3d.ts [options]

Options:
  --goal <text>         Navigate to a described location (default mode)
  --explore             Explore the environment autonomously
  --dream               Run dream consolidation on shutdown (default for go_to)
  --no-dream            Disable dream consolidation on shutdown
  --constraints <text>  Additional constraints for navigation
  --gemini              Use Gemini Robotics-ER instead of Qwen-VL (requires GOOGLE_API_KEY)
  --help                Show this help message

Examples:
  npx tsx scripts/run_sim3d.ts --goal "navigate to the red box"
  npx tsx scripts/run_sim3d.ts --explore
  npx tsx scripts/run_sim3d.ts --goal "the red cube" --dream
  npx tsx scripts/run_sim3d.ts --goal "the door" --constraints "stay close to walls"
  GOOGLE_API_KEY=... npx tsx scripts/run_sim3d.ts --gemini --goal "find the red cube"
`);
      process.exit(0);
  }
}

// Default dream on for go_to mode (traces are always collected anyway)
if (mode === 'go_to' && dreamOnShutdown === undefined) {
  dreamOnShutdown = true;
}
dreamOnShutdown = dreamOnShutdown ?? false;

// Default goal for go_to mode if none specified
if (mode === 'go_to' && !goal) {
  goal = 'explore the arena and avoid obstacles';
  mode = 'explore'; // no goal means explore
}

// =============================================================================
// Dream consolidation
// =============================================================================

async function runDreamConsolidation(): Promise<void> {
  const memoryServerUrl = process.env.MEMORY_SERVER_URL || 'http://localhost:8420';
  const client = new MemoryClient(memoryServerUrl);

  try {
    await client.health();
  } catch {
    logger.warn('Sim3D', `Cannot reach memory server at ${memoryServerUrl} — run 'python -m evolving_memory.server' first.`);
    return;
  }

  logger.info('Sim3D', 'Running dream consolidation via evolving-memory server...');
  const result = await client.runDream('robotics');
  logger.info('Sim3D', `Dream: ${result.traces_processed} traces → ${result.nodes_created} created, ${result.nodes_merged} merged`);
}

// =============================================================================
// Boot
// =============================================================================

async function main(): Promise<void> {
  logger.info('Sim3D', '=== RoClaw mjswan Full Cognitive Stack ===');
  logger.info('Sim3D', `Mode: ${mode}${mode === 'go_to' ? ` | Goal: "${goal}"` : ''}`);
  if (constraints) logger.info('Sim3D', `Constraints: "${constraints}"`);
  if (dreamOnShutdown) logger.info('Sim3D', 'Dream consolidation enabled on shutdown');

  // 1. Compiler
  const compiler = new BytecodeCompiler('fewshot');

  // 2. UDP transmitter -> bridge
  const transmitter = new UDPTransmitter({
    host: config.esp32Host,
    port: config.esp32Port,
  });
  await transmitter.connect();
  logger.info('Sim3D', `UDP transmitter -> ${config.esp32Host}:${config.esp32Port}`);

  // 3. Inference (Gemini, OpenRouter, or local)
  let infer;
  if (useGemini) {
    const googleApiKey = process.env.GOOGLE_API_KEY;
    if (!googleApiKey) {
      logger.error('Sim3D', 'GOOGLE_API_KEY required for --gemini mode');
      process.exit(1);
    }
    const geminiModel = process.env.GEMINI_MODEL || 'gemini-robotics-er-1.5-preview';
    const thinkingBudget = parseInt(process.env.GEMINI_THINKING_BUDGET || '0', 10);
    const gemini = new GeminiRoboticsInference({
      apiKey: googleApiKey,
      model: geminiModel,
      thinkingBudget,
      useToolCalling: true,
      tools: ROCLAW_TOOL_DECLARATIONS,
    });
    infer = gemini.createInferenceFunction();
    logger.info('Sim3D', `Inference: Gemini (${geminiModel}, thinking=${thinkingBudget}, tools=on)`);
  } else {
    const inferenceConfig = config.localInferenceUrl
      ? { apiKey: config.apiKey || 'local', apiBaseUrl: config.localInferenceUrl, model: config.model }
      : { apiKey: config.apiKey, model: config.model };
    const inference = new CerebellumInference(inferenceConfig);
    infer = inference.createInferenceFunction();
    logger.info('Sim3D', `Inference: ${config.localInferenceUrl ? 'local' : 'OpenRouter'} (${config.model})`);
  }

  // 4. Vision loop -> bridge MJPEG stream
  const cameraUrl = `http://${config.cameraHost}:${config.cameraPort}${config.cameraPath}`;
  const visionLoop = new VisionLoop(
    { cameraUrl, targetFPS: 2, frameHistorySize: config.frameHistorySize, useToolCallingPrompt: useGemini },
    compiler,
    transmitter,
    infer,
  );

  // Event logging (fires regardless of who calls visionLoop.start())
  visionLoop.on('connected', () => {
    logger.info('Sim3D', 'Camera stream connected — VLM loop active');
  });

  visionLoop.on('bytecode', (bytecode: Buffer, vlmOutput: string) => {
    logger.info('Sim3D', `VLM -> ${formatHex(bytecode)}`, { vlm: vlmOutput?.slice(0, 80) });
  });

  visionLoop.on('arrival', () => {
    logger.info('Sim3D', 'STOP detected (arrival)');
  });

  visionLoop.on('stuck', () => {
    logger.warn('Sim3D', 'Stuck detection triggered');
  });

  visionLoop.on('reconnecting', () => {
    logger.warn('Sim3D', 'Camera reconnecting...');
  });

  // 5. Build ToolContext and dispatch via handleTool
  //    Tag traces as SIM_3D: physics-based simulation with rendered frames + real VLM
  const ctx: ToolContext = { compiler, transmitter, visionLoop, infer, traceSource: TraceSource.SIM_3D };

  // 6. Physics-based goal confirmation polling — start BEFORE handleTool
  //    (handleTool blocks on topo planning; we need to track distance immediately)
  let goalPollInterval: ReturnType<typeof setInterval> | undefined;
  let goalPollStopped = false;

  if (mode === 'go_to') {
    const statusSocket = dgram.createSocket('udp4');
    const statusFrame = encodeFrame({ opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 });

    // Permanent message handler — parses every response from the bridge
    statusSocket.on('message', (msg: Buffer) => {
      if (goalPollStopped) return;
      try {
        const status = JSON.parse(msg.toString());
        const dist = typeof status.targetDistance === 'number' ? status.targetDistance : null;
        const name = status.targetName || 'target';

        if (dist !== null) {
          logger.info('Sim3D', `Target "${name}": ${dist.toFixed(2)}m away`);
        }

        if (status.goalReached === true && dist !== null) {
          goalPollStopped = true;
          if (goalPollInterval) clearInterval(goalPollInterval);
          logger.info('Sim3D', `GOAL CONFIRMED by physics engine: within ${dist.toFixed(2)}m of "${name}"`);
          visionLoop.confirmArrival(`Physics: within ${dist.toFixed(2)}m of ${name}`);

          // Send STOP bytecode
          const stopFrame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
          transmitter.send(stopFrame).catch(() => {});

          statusSocket.close();
        }
      } catch {
        // Ignore parse errors from non-JSON responses
      }
    });

    // Bind first, then start polling
    statusSocket.bind(0, '0.0.0.0', () => {
      logger.info('Sim3D', `Goal polling socket bound on port ${statusSocket.address().port}`);
    });

    goalPollInterval = setInterval(() => {
      if (goalPollStopped) return;
      statusSocket.send(statusFrame, config.esp32Port, config.esp32Host, (err) => {
        if (err) logger.warn('Sim3D', `Goal poll send error: ${err.message}`);
      });
    }, 2000);

    // Clean up poll on shutdown
    process.on('SIGINT', () => { goalPollStopped = true; if (goalPollInterval) clearInterval(goalPollInterval); });
    process.on('SIGTERM', () => { goalPollStopped = true; if (goalPollInterval) clearInterval(goalPollInterval); });
  }

  logger.info('Sim3D', `Starting full cognitive stack: ${cameraUrl}`);

  let result;
  if (mode === 'explore') {
    result = await handleTool('robot.explore', constraints ? { constraints } : {}, ctx);
  } else {
    result = await handleTool('robot.go_to', {
      location: goal,
      ...(constraints ? { constraints } : {}),
    }, ctx);
  }

  logger.info('Sim3D', `handleTool result: ${result.message}`);
  logger.info('Sim3D', 'Cycle: 3D render -> MJPEG -> VLM -> bytecode -> UDP -> bridge -> MuJoCo physics');

  // 7. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Sim3D', 'Shutting down...');
    await handleTool('robot.stop', {}, ctx);
    if (dreamOnShutdown) await runDreamConsolidation();
    await transmitter.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 8. For go_to + dream: wait for navigation to complete, then dream and exit
  if (mode === 'go_to' && dreamOnShutdown) {
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!visionLoop.isRunning()) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
    logger.info('Sim3D', 'Navigation completed, running dream consolidation...');
    await runDreamConsolidation();
    await transmitter.disconnect();
    process.exit(0);
  }
}

main().catch((err) => {
  logger.error('Sim3D', 'Fatal error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
