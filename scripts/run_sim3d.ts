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
 *   npx tsx scripts/run_sim3d.ts --goal "the door" --constraints "stay close to walls"
 *   npx tsx scripts/run_sim3d.ts --serve --gemini           # HTTP tool server on :8440
 *   npx tsx scripts/run_sim3d.ts --serve --serve-port 9000  # custom port
 *   npx tsx scripts/run_sim3d.ts --help
 */

import * as dgram from 'dgram';
import * as http from 'http';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { logger } from '../src/shared/logger';
import { BytecodeCompiler, Opcode, encodeFrame, formatHex } from '../src/2_qwen_cerebellum/bytecode_compiler';
import { UDPTransmitter } from '../src/2_qwen_cerebellum/udp_transmitter';
import { VisionLoop } from '../src/2_qwen_cerebellum/vision_loop';
import { CerebellumInference } from '../src/2_qwen_cerebellum/inference';
import { GeminiRoboticsInference, ROCLAW_TOOL_DECLARATIONS } from '../src/2_qwen_cerebellum/gemini_robotics';
import { handleTool, type ToolContext } from '../src/1_openclaw_cortex/roclaw_tools';
import { TraceSource, TraceOutcome } from '../src/llmunix-core/types';
import { TelemetryMonitor } from '../src/2_qwen_cerebellum/telemetry_monitor';
import { Sim3DTraceCollector } from '../src/3_llmunix_memory/sim3d_trace_collector';
import { SceneGraph } from '../src/3_llmunix_memory/scene_graph';
import { ReactiveController } from '../src/1_openclaw_cortex/reactive_controller';
import { ShadowPerceptionLoop } from '../src/2_qwen_cerebellum/shadow_perception_loop';
import { ReflexGuard, attachReflexGuard } from '../src/2_qwen_cerebellum/reflex_guard';
import { SceneGraphPolicy } from '../src/2_qwen_cerebellum/scene_graph_policy';
import { createPerceptionInference } from '../src/2_qwen_cerebellum/gemini_robotics';
import type { ArenaConfig } from '../src/2_qwen_cerebellum/vision_projector';

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
let constraints: string | undefined;
let useGemini = false;
let useOllama = false;
let ollamaModelName = 'roclaw-nav:q8_0';
let serveMode = false;
let servePort = 8440;
let collectTraces = true;
let describeScene = false;
let useSceneGraphPolicy = process.env.RF_POLICY === 'scene_graph';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--goal':
      goal = args[++i] || '';
      break;
    case '--explore':
      mode = 'explore';
      break;
    case '--constraints':
      constraints = args[++i] || '';
      break;
    case '--gemini':
      useGemini = true;
      break;
    case '--ollama':
      useOllama = true;
      break;
    case '--ollama-model':
      ollamaModelName = args[++i] || ollamaModelName;
      break;
    case '--serve':
      serveMode = true;
      break;
    case '--serve-port':
      servePort = parseInt(args[++i] || '8440', 10);
      break;
    case '--no-traces':
      collectTraces = false;
      break;
    case '--describe-scene':
      describeScene = true;
      break;
    case '--scene-graph':
      useSceneGraphPolicy = true;
      break;
    case '--help':
      console.log(`Usage: npx tsx scripts/run_sim3d.ts [options]

Options:
  --goal <text>         Navigate to a described location (default mode)
  --explore             Explore the environment autonomously
  --constraints <text>  Additional constraints for navigation
  --gemini              Use Gemini Robotics-ER instead of Qwen-VL (requires GOOGLE_API_KEY)
  --ollama              Use Ollama with a fine-tuned local model
  --ollama-model <name> Ollama model name (default: roclaw-nav:q8_0)
  --serve               Start HTTP tool server instead of running a single goal
  --serve-port <port>   Port for the HTTP tool server (default: 8440)
  --no-traces           Disable trace file collection
  --describe-scene      Ask VLM to describe camera scenes as text (gap analysis)
  --scene-graph         Use SceneGraphPolicy (VLM perceives, local controller decides)
  --help                Show this help message

Examples:
  npx tsx scripts/run_sim3d.ts --goal "navigate to the red box"
  npx tsx scripts/run_sim3d.ts --explore
  npx tsx scripts/run_sim3d.ts --goal "the door" --constraints "stay close to walls"
  GOOGLE_API_KEY=... npx tsx scripts/run_sim3d.ts --gemini --goal "find the red cube"
  npx tsx scripts/run_sim3d.ts --ollama --goal "find the red cube"  # Local fine-tuned model
  npx tsx scripts/run_sim3d.ts --ollama --ollama-model roclaw-nav:q4km --goal "the red cube"
  npx tsx scripts/run_sim3d.ts --serve --gemini  # Tool server on :8440
  npx tsx scripts/run_sim3d.ts --serve --serve-port 9000 --gemini
  # Collect traces with scene descriptions for gap analysis:
  npx tsx scripts/run_sim3d.ts --gemini --describe-scene --goal "find the red cube"
`);
      process.exit(0);
  }
}

// Default goal for go_to mode if none specified
if (mode === 'go_to' && !goal) {
  goal = 'explore the arena and avoid obstacles';
  mode = 'explore'; // no goal means explore
}

// =============================================================================
// Boot
// =============================================================================

async function main(): Promise<void> {
  logger.info('Sim3D', '=== RoClaw mjswan Full Cognitive Stack ===');
  if (serveMode) {
    logger.info('Sim3D', `Mode: SERVE (HTTP tool server on :${servePort})`);
  } else {
    logger.info('Sim3D', `Mode: ${mode}${mode === 'go_to' ? ` | Goal: "${goal}"` : ''}`);
  }
  if (constraints) logger.info('Sim3D', `Constraints: "${constraints}"`);
  if (collectTraces) logger.info('Sim3D', 'Trace collection enabled → traces/sim3d/');
  if (describeScene) logger.info('Sim3D', 'Scene description enabled (gap analysis)');

  // 1. Compiler
  const compiler = new BytecodeCompiler('fewshot');

  // 2. UDP transmitter -> bridge
  const transmitter = new UDPTransmitter({
    host: config.esp32Host,
    port: config.esp32Port,
  });
  await transmitter.connect();
  logger.info('Sim3D', `UDP transmitter -> ${config.esp32Host}:${config.esp32Port}`);

  // 3. Inference (Ollama, Gemini, OpenRouter, or local)
  let infer;
  if (useOllama) {
    const { OllamaInference } = await import('../src/2_qwen_cerebellum/ollama_inference');
    const ollama = new OllamaInference({
      model: ollamaModelName,
      temperature: 0.1,
      maxTokens: 128,
    });
    infer = ollama.createInferenceFunction();
    logger.info('Sim3D', `Inference: Ollama (${ollamaModelName})`);
  } else if (useGemini) {
    const googleApiKey = process.env.GOOGLE_API_KEY;
    if (!googleApiKey) {
      logger.error('Sim3D', 'GOOGLE_API_KEY required for --gemini mode');
      process.exit(1);
    }
    const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
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
  //    coastDuringInference: let previous motor command keep running while VLM thinks (~2s).
  //    Without this, STOP-before-inference cancels all movement between frames.
  const cameraUrl = `http://${config.cameraHost}:${config.cameraPort}${config.cameraPath}`;
  const visionLoop = new VisionLoop(
    { cameraUrl, targetFPS: 2, frameHistorySize: config.frameHistorySize, useToolCallingPrompt: useGemini, coastDuringInference: true },
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

  // 5. Telemetry monitor — listens for telemetry push from the bridge via UDP
  const telemetryMonitor = new TelemetryMonitor();
  transmitter.onMessage((msg) => {
    telemetryMonitor.processMessage(msg);
  });

  // 5a. Wire telemetry into VisionLoop for pose-aware VLM prompts
  visionLoop.setTelemetryProvider(() => {
    const data = telemetryMonitor.getLastTelemetry();
    if (!data) return null;
    return {
      pose: data.pose,
      targetDist: data.targetDist,
      targetBearing: data.targetBearing,
    };
  });

  // 5b. Trace collector — captures camera-based traces as local .md files
  let traceCollector: Sim3DTraceCollector | null = null;
  if (collectTraces) {
    traceCollector = new Sim3DTraceCollector({
      describeScene,
    });
    if (describeScene) {
      traceCollector.setInferenceFunction(infer);
    }
  }

  // 5c. Scene description loop — periodically asks VLM to describe what it sees as text
  //     This runs alongside navigation for gap analysis between camera and text-only input.
  let sceneDescriptionLog: Array<{ timestamp: number; frameIndex: number; description: string; vlmOutput: string }> = [];
  let describeFrameCount = 0;
  const DESCRIBE_EVERY_N = 5; // Describe every 5th frame to avoid excessive API calls

  if (describeScene && infer) {
    visionLoop.on('bytecode', async (_bytecode: Buffer, vlmOutput: string) => {
      describeFrameCount++;
      if (describeFrameCount % DESCRIBE_EVERY_N !== 0) return;

      const latestFrame = visionLoop.getLatestFrameBase64();
      if (!latestFrame) return;

      try {
        const description = await infer(
          'You are a robot scene analyst. Describe exactly what you see in this camera frame. ' +
          'Include: all visible objects (color, shape, approximate size and distance), ' +
          'spatial layout (what is to the left, right, center, near, far), ' +
          'any obstacles or walls, open paths for navigation, and the floor/ground texture. ' +
          'Be precise about relative positions and estimated distances in centimeters. ' +
          'Output ONLY the scene description as plain text. Do NOT output any motor commands.',
          'Describe this scene in detail for a text-based robot navigation system.',
          [latestFrame],
        );
        sceneDescriptionLog.push({
          timestamp: Date.now(),
          frameIndex: describeFrameCount,
          description,
          vlmOutput,
        });
        logger.info('Describe', `Frame #${describeFrameCount}: ${description.slice(0, 120)}...`);
      } catch (err) {
        logger.warn('Describe', `Failed at frame #${describeFrameCount}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  // 6a. Arena config for scene-graph pipeline
  const ARENA: ArenaConfig = {
    widthCm: parseInt(process.env.ARENA_WIDTH_CM || '300', 10),
    heightCm: parseInt(process.env.ARENA_HEIGHT_CM || '200', 10),
  };

  // 6b. Scene-graph instances (shared by shadow loop, policy, and reflex guard)
  let sceneGraph: SceneGraph | undefined;

  // 6c. Shadow Perception Loop (PR-1) — read-only sidecar that logs divergence
  if (process.env.RF_PERCEPTION_SHADOW === '1') {
    sceneGraph = sceneGraph ?? new SceneGraph();
    const controller = new ReactiveController();
    const shadow = new ShadowPerceptionLoop(sceneGraph, controller, compiler, infer, ARENA);
    shadow.setGoalText(goal);

    // Wire telemetry
    shadow.setTelemetryProvider(telemetryMonitor);

    // Hook into VisionLoop bytecode events
    visionLoop.on('bytecode', (bytecode: Buffer, _vlmOutput: string) => {
      const frame = visionLoop.getLatestFrameBase64();
      if (frame) shadow.onFrame(frame, bytecode);
    });

    shadow.on('divergence', (info: Record<string, unknown>) => {
      logger.info('Sim3D', `Shadow divergence: ${info.action} vs VLM (${info.vlmHex})`, info);
    });

    logger.info('Sim3D', 'Shadow Perception Loop enabled (RF_PERCEPTION_SHADOW=1)');
  }

  // 6d. Reflex Guard (shadow or active depending on env)
  if (process.env.RF_REFLEX_ENABLED || process.env.RF_PERCEPTION_SHADOW === '1') {
    sceneGraph = sceneGraph ?? new SceneGraph();
    const reflexMode = useSceneGraphPolicy ? 'active' as const : 'shadow' as const;
    const guard = new ReflexGuard(sceneGraph, { mode: reflexMode });
    const detach = attachReflexGuard(transmitter, guard);
    logger.info('Sim3D', `Reflex Guard attached (mode: ${reflexMode})`);
  }

  // 6e. Scene Graph Policy (PR-3) — replaces VLM motor policy
  if (useSceneGraphPolicy && useGemini) {
    sceneGraph = sceneGraph ?? new SceneGraph();
    const googleApiKey = process.env.GOOGLE_API_KEY!;
    const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
    const perceptionInfer = createPerceptionInference({
      apiKey: googleApiKey,
      model: geminiModel,
    });
    const controller = new ReactiveController();
    const sgPolicy = new SceneGraphPolicy(
      sceneGraph, controller, perceptionInfer, compiler, ARENA,
    );
    visionLoop.setPolicy(sgPolicy);
    logger.info('Sim3D', `SceneGraphPolicy active (model: ${geminiModel})`);
  } else if (useSceneGraphPolicy && !useGemini) {
    logger.warn('Sim3D', '--scene-graph requires --gemini (Gemini API key needed for perception inference)');
  }

  // 6. Build ToolContext and dispatch via handleTool
  //    Tag traces as SIM_3D: physics-based simulation with rendered frames + real VLM
  const ctx: ToolContext = { compiler, transmitter, visionLoop, infer, traceSource: TraceSource.SIM_3D, sceneGraph };

  // ===================================================================
  // SERVE MODE — HTTP tool server for external callers (e.g. skillos)
  // ===================================================================
  if (serveMode) {
    const toolNames = [
      'robot.go_to', 'robot.explore', 'robot.describe_scene',
      'robot.stop', 'robot.status', 'robot.read_memory',
      'robot.record_observation', 'robot.analyze_scene', 'robot.get_map',
    ];

    let shuttingDown = false;

    const server = http.createServer(async (req, res) => {
      const sendJson = (status: number, data: unknown) => {
        const body = JSON.stringify(data, null, 2);
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
      };

      const readBody = (): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            if (chunks.length === 0) return resolve({});
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch (e) {
              reject(e);
            }
          });
          req.on('error', reject);
        });

      const urlPath = (req.url || '').replace(/\/$/, '') || '/';

      try {
        // GET /health
        if (req.method === 'GET' && urlPath === '/health') {
          sendJson(200, { status: 'ok', tools: toolNames });
          return;
        }

        // GET /telemetry — latest telemetry from the bridge
        if (req.method === 'GET' && urlPath === '/telemetry') {
          const data = telemetryMonitor.getLastTelemetry();
          sendJson(200, {
            success: true,
            data: data ?? { pose: { x: 0, y: 0, h: 0 }, vel: { left: 0, right: 0 }, stall: false, ts: 0 },
            stall: telemetryMonitor.isStalled(),
          });
          return;
        }

        // POST /invoke
        if (req.method === 'POST' && urlPath === '/invoke') {
          const body = await readBody();
          const tool = body.tool as string;
          const args = (body.args || {}) as Record<string, unknown>;

          if (!tool || !toolNames.includes(tool)) {
            sendJson(400, { success: false, message: `Unknown tool: ${tool}`, available: toolNames });
            return;
          }

          logger.info('Serve', `POST /invoke → ${tool}`, args);
          const result = await handleTool(tool, args, ctx);
          sendJson(200, result);
          return;
        }

        // POST /shutdown
        if (req.method === 'POST' && urlPath === '/shutdown') {
          sendJson(200, { success: true, message: 'Shutting down...' });

          if (!shuttingDown) {
            shuttingDown = true;
            logger.info('Serve', 'Shutdown requested via HTTP');
            await handleTool('robot.stop', {}, ctx);
            await transmitter.disconnect();
            server.close();
            process.exit(0);
          }
          return;
        }

        sendJson(404, { error: `Unknown endpoint: ${req.method} ${urlPath}` });
      } catch (err) {
        logger.error('Serve', 'Request error', {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(500, { success: false, message: err instanceof Error ? err.message : String(err) });
      }
    });

    server.listen(servePort, '0.0.0.0', () => {
      logger.info('Serve', `Tool server listening on http://0.0.0.0:${servePort}`);
      logger.info('Serve', `Available tools: ${toolNames.join(', ')}`);
      logger.info('Serve', 'Endpoints: GET /health, POST /invoke, POST /shutdown');
    });

    // Graceful shutdown on signals
    const shutdownServe = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('Serve', 'Shutting down...');
      await handleTool('robot.stop', {}, ctx);
      await transmitter.disconnect();
      server.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdownServe);
    process.on('SIGTERM', shutdownServe);

    // Keep alive — server handles the event loop
    return;
  }

  // ===================================================================
  // SINGLE-GOAL MODE — existing behavior
  // ===================================================================

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

  // Attach trace collector before navigation starts
  if (traceCollector) {
    const traceGoal = mode === 'go_to' ? goal : 'explore and avoid obstacles';
    traceCollector.attach(visionLoop, traceGoal);

    // Also track physics-confirmed arrival in the collector
    visionLoop.on('arrival', (reason: string) => {
      traceCollector?.setOutcome(TraceOutcome.SUCCESS, typeof reason === 'string' ? reason : 'Arrival');
    });
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

  // 7. Write traces + scene analysis helper
  async function writeCollectedTraces(): Promise<void> {
    if (!traceCollector) return;

    traceCollector.detach(visionLoop);
    const summary = traceCollector.getSummary();
    logger.info('Sim3D', `Trace collection: ${summary.frames} frames, outcome=${summary.outcome}, ${summary.durationMs}ms`);

    const tracePath = traceCollector.writeTrace();
    if (tracePath) {
      logger.info('Sim3D', `Trace written: ${tracePath}`);
    }

    // Print scene description gap analysis if enabled
    if (describeScene && sceneDescriptionLog.length > 0) {
      logger.info('Describe', `\n${'='.repeat(60)}`);
      logger.info('Describe', 'SCENE DESCRIPTION GAP ANALYSIS');
      logger.info('Describe', `${'='.repeat(60)}`);
      logger.info('Describe', `Collected ${sceneDescriptionLog.length} scene descriptions`);
      for (const entry of sceneDescriptionLog) {
        logger.info('Describe', `\n--- Frame #${entry.frameIndex} ---`);
        logger.info('Describe', `VLM motor output: ${entry.vlmOutput}`);
        logger.info('Describe', `Scene description: ${entry.description}`);
      }
      logger.info('Describe', `${'='.repeat(60)}\n`);
    }
  }

  // 8. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Sim3D', 'Shutting down...');
    await handleTool('robot.stop', {}, ctx);
    await writeCollectedTraces();
    await transmitter.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 9. For go_to: wait for navigation to complete, then write traces and exit
  if (mode === 'go_to') {
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!visionLoop.isRunning()) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
    logger.info('Sim3D', 'Navigation completed');
    await writeCollectedTraces();
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
