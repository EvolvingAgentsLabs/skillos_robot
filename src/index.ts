/**
 * RoClaw — Main Entry Point (Gemini Robotics Edition)
 *
 * Boots the dual-brain system powered 100% by Gemini Robotics:
 * 1. Load configuration from .env
 * 2. Initialize UDP transmitter (→ ESP32-S3 spinal cord)
 * 3. Initialize bytecode compiler (neural compiler)
 * 4. Initialize Gemini Robotics inference (vision + motor control)
 * 5. Initialize vision loop (→ ESP32-CAM eyes)
 * 6. Connect to OpenClaw Gateway (cortex)
 * 7. Start listening for tool invocations
 */

import * as dotenv from 'dotenv';
import { logger } from './shared/logger';
import { BytecodeCompiler } from './2_qwen_cerebellum/bytecode_compiler';
import { UDPTransmitter } from './2_qwen_cerebellum/udp_transmitter';
import { VisionLoop } from './2_qwen_cerebellum/vision_loop';
import { GeminiRoboticsInference } from './2_qwen_cerebellum/gemini_robotics';
import { CortexNode } from './1_openclaw_cortex/index';
import type { ToolContext } from './1_openclaw_cortex/roclaw_tools';

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

  // Gemini Robotics Inference
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
};

// =============================================================================
// Boot
// =============================================================================

async function main(): Promise<void> {
  logger.info('RoClaw', '=== RoClaw — The Physical Embodiment for OpenClaw ===');
  logger.info('RoClaw', 'Powered by Gemini Robotics — 100% Google AI');

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
    logger.info('RoClaw', `UDP transmitter → ${config.esp32Host}:${config.esp32Port}`);
  } catch (err) {
    logger.warn('RoClaw', 'UDP transmitter offline (ESP32 not connected)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Initialize Gemini Robotics inference
  if (!config.googleApiKey) {
    logger.error('RoClaw', 'GOOGLE_API_KEY required for Gemini Robotics inference');
    process.exit(1);
  }

  const inference = new GeminiRoboticsInference({
    apiKey: config.googleApiKey,
    model: config.geminiModel,
    maxOutputTokens: 64,
    temperature: 0.1,
    timeoutMs: 10000,
    thinkingBudget: 0,
    useToolCalling: true,
  });
  const infer = inference.createInferenceFunction();
  logger.info('RoClaw', `Inference: Gemini Robotics (${config.geminiModel})`);

  // 4. Initialize vision loop (rolling video buffer for temporal/3D perception)
  const cameraUrl = `http://${config.cameraHost}:${config.cameraPort}${config.cameraPath}`;
  const visionLoop = new VisionLoop(
    { cameraUrl, targetFPS: 2, frameHistorySize: config.frameHistorySize, useToolCallingPrompt: true },
    compiler,
    transmitter,
    infer,
  );
  logger.info('RoClaw', `Vision loop → ${cameraUrl} (${config.frameHistorySize}-frame video buffer)`);

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
