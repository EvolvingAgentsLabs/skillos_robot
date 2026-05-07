/**
 * RoClaw — Main Entry Point
 *
 * Boots the dual-brain system with multi-backend VLM inference:
 * 1. Load configuration from .env
 * 2. Initialize UDP transmitter (-> ESP32-S3 spinal cord)
 * 3. Initialize bytecode compiler (neural compiler)
 * 4. Initialize VLM inference (OpenRouter Qwen3-VL or Gemini Robotics)
 * 5. Initialize vision loop (-> ESP32-CAM eyes)
 * 6. Connect to OpenClaw Gateway (cortex)
 * 7. Start listening for tool invocations
 *
 * Backend selection:
 *   - OPENROUTER_API_KEY set -> OpenRouter + Qwen3-VL-8B (default)
 *   - GOOGLE_API_KEY set     -> Gemini Robotics (with --gemini flag or as fallback)
 */

import * as dotenv from 'dotenv';
import { logger } from './shared/logger';
import { BytecodeCompiler } from './control/bytecode_compiler';
import { UDPTransmitter } from './bridge/udp_transmitter';
import { VisionLoop } from './brain/perception/vision_loop';
import { GeminiRoboticsInference } from './brain/inference/gemini_robotics';
import { CerebellumInference } from './brain/inference/inference';
import { CortexNode } from './brain/planning/index';
import type { ToolContext } from './brain/planning/roclaw_tools';
import type { InferenceFunction } from './llmunix-core/interfaces';

// Load .env
dotenv.config();

// =============================================================================
// Configuration
// =============================================================================

const config = {
  // OpenClaw Gateway
  gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || 'ws://localhost:8080',

  // ESP32 Hardware
  esp32Host: process.env.ESP32_S3_HOST || '192.168.1.100',
  esp32Port: parseInt(process.env.ESP32_S3_PORT || '4210', 10),
  cameraHost: process.env.ESP32_CAM_HOST || '192.168.1.101',
  cameraPort: parseInt(process.env.ESP32_CAM_PORT || '80', 10),
  cameraPath: process.env.ESP32_CAM_PATH || '/stream',

  // Vision Loop
  frameHistorySize: parseInt(process.env.FRAME_HISTORY_SIZE || '4', 10),

  // Inference backends
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  qwenModel: process.env.QWEN_MODEL || 'qwen/qwen3-vl-8b-instruct',
};

// CLI flag: --gemini forces Gemini backend
const useGemini = process.argv.includes('--gemini');

// =============================================================================
// Boot
// =============================================================================

async function main(): Promise<void> {
  logger.info('RoClaw', '=== RoClaw — The Physical Embodiment for OpenClaw ===');

  // 1. Initialize bytecode compiler
  const compiler = new BytecodeCompiler('fewshot');
  logger.info('RoClaw', 'Bytecode compiler initialized (fewshot mode)');

  // 2. Initialize UDP transmitter
  const transmitter = new UDPTransmitter({
    host: config.esp32Host,
    port: config.esp32Port,
  });

  try {
    await transmitter.connect();
    logger.info('RoClaw', `UDP transmitter -> ${config.esp32Host}:${config.esp32Port}`);
  } catch (err) {
    logger.warn('RoClaw', 'UDP transmitter offline (ESP32 not connected)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Initialize VLM inference
  let infer: InferenceFunction;

  if (useGemini && config.googleApiKey) {
    // Gemini Robotics mode (explicit --gemini flag)
    const inference = new GeminiRoboticsInference({
      apiKey: config.googleApiKey,
      model: config.geminiModel,
      maxOutputTokens: 64,
      temperature: 0.1,
      timeoutMs: 10000,
      thinkingBudget: 0,
      useToolCalling: true,
    });
    infer = inference.createInferenceFunction();
    logger.info('RoClaw', `Inference: Gemini Robotics (${config.geminiModel})`);
  } else if (config.openRouterApiKey) {
    // OpenRouter + Qwen3-VL (default)
    const inference = new CerebellumInference({
      apiKey: config.openRouterApiKey,
      model: config.qwenModel,
      maxTokens: 512,
      temperature: 0.1,
      timeoutMs: 15000,
    });
    infer = inference.createInferenceFunction();
    logger.info('RoClaw', `Inference: OpenRouter (${config.qwenModel})`);
  } else if (config.googleApiKey) {
    // Gemini fallback (no OpenRouter key, but Google key available)
    const inference = new GeminiRoboticsInference({
      apiKey: config.googleApiKey,
      model: config.geminiModel,
      maxOutputTokens: 64,
      temperature: 0.1,
      timeoutMs: 10000,
      thinkingBudget: 0,
      useToolCalling: true,
    });
    infer = inference.createInferenceFunction();
    logger.info('RoClaw', `Inference: Gemini Robotics (${config.geminiModel}) [fallback]`);
  } else {
    logger.error('RoClaw', 'No inference backend configured. Set OPENROUTER_API_KEY or GOOGLE_API_KEY in .env');
    process.exit(1);
  }

  // 4. Initialize vision loop (rolling video buffer for temporal/3D perception)
  const cameraUrl = `http://${config.cameraHost}:${config.cameraPort}${config.cameraPath}`;
  const visionLoop = new VisionLoop(
    { cameraUrl, targetFPS: 2, frameHistorySize: config.frameHistorySize },
    compiler,
    transmitter,
    infer,
  );
  logger.info('RoClaw', `Vision loop -> ${cameraUrl} (${config.frameHistorySize}-frame video buffer)`);

  // 5. Build tool context
  const toolContext: ToolContext = {
    compiler,
    transmitter,
    visionLoop,
    infer,
  };

  // 6. Connect to OpenClaw Gateway
  const cortex = new CortexNode(
    { gatewayUrl: config.gatewayUrl },
    toolContext,
  );

  try {
    await cortex.connect();
    logger.info('RoClaw', `Cortex connected to ${config.gatewayUrl}`);
  } catch (err) {
    logger.warn('RoClaw', 'Gateway not available (standalone mode)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('RoClaw', 'System ready. Waiting for tool invocations...');

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.info('RoClaw', 'Shutting down...');
    visionLoop.stop();
    cortex.disconnect();
    await transmitter.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('RoClaw', 'Fatal error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
