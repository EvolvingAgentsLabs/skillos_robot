/**
 * RoClaw Standalone Test — Bypasses OpenClaw, fires tools directly
 *
 * Run the simulator first:   npm run sim -- --mock-inference
 * Then run this script:      npx tsx scripts/standalone-test.ts
 *
 * This proves the full loop: Tool → VisionLoop → Camera → VLM → Bytecode → UDP
 */

import * as dotenv from 'dotenv';
import { logger } from '../src/shared/logger';
import { BytecodeCompiler } from '../src/2_qwen_cerebellum/bytecode_compiler';
import { UDPTransmitter } from '../src/2_qwen_cerebellum/udp_transmitter';
import { VisionLoop } from '../src/2_qwen_cerebellum/vision_loop';
import { CerebellumInference } from '../src/2_qwen_cerebellum/inference';
import { handleTool, type ToolContext } from '../src/1_openclaw_cortex/roclaw_tools';

dotenv.config();

// =============================================================================
// Config
// =============================================================================

const config = {
  esp32Host: process.env.ESP32_S3_HOST || '127.0.0.1',
  esp32Port: parseInt(process.env.ESP32_S3_PORT || '4210', 10),
  cameraHost: process.env.ESP32_CAM_HOST || '127.0.0.1',
  cameraPort: parseInt(process.env.ESP32_CAM_PORT || '8081', 10),
  apiKey: process.env.OPENROUTER_API_KEY || 'local',
  model: process.env.QWEN_MODEL || 'qwen/qwen-2.5-vl-72b-instruct',
  localInferenceUrl: process.env.LOCAL_INFERENCE_URL,
};

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function header(text: string): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${text}`);
  console.log(`${'='.repeat(60)}\n`);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  header('RoClaw Standalone Test — No OpenClaw Required');

  // --- Boot ---
  const compiler = new BytecodeCompiler('fewshot');
  const transmitter = new UDPTransmitter({ host: config.esp32Host, port: config.esp32Port });
  await transmitter.connect();
  console.log(`  UDP connected → ${config.esp32Host}:${config.esp32Port}`);

  const inferenceConfig = config.localInferenceUrl
    ? { apiKey: config.apiKey, apiBaseUrl: config.localInferenceUrl, model: config.model }
    : { apiKey: config.apiKey, model: config.model };

  const inference = new CerebellumInference(inferenceConfig);
  const infer = inference.createInferenceFunction();
  console.log(`  Inference → ${config.localInferenceUrl || 'OpenRouter'}`);

  const cameraUrl = `http://${config.cameraHost}:${config.cameraPort}/stream`;
  const visionLoop = new VisionLoop({ cameraUrl, targetFPS: 2 }, compiler, transmitter, infer);
  console.log(`  Camera → ${cameraUrl}`);

  const ctx: ToolContext = { compiler, transmitter, visionLoop, infer };

  // --- Test 1: robot.status ---
  header('Test 1: robot.status');
  const statusResult = await handleTool('robot.status', {}, ctx);
  console.log(`  Success: ${statusResult.success}`);
  console.log(`  Message: ${statusResult.message}`);
  if (statusResult.data) console.log(`  Data:`, statusResult.data);

  // --- Test 2: robot.read_memory ---
  header('Test 2: robot.read_memory');
  const memoryResult = await handleTool('robot.read_memory', {}, ctx);
  console.log(`  Success: ${memoryResult.success}`);
  console.log(`  Preview: ${memoryResult.message.slice(0, 200)}...`);

  // --- Test 3: robot.describe_scene ---
  header('Test 3: robot.describe_scene');
  const sceneResult = await handleTool('robot.describe_scene', {}, ctx);
  console.log(`  Success: ${sceneResult.success}`);
  console.log(`  Message: ${sceneResult.message}`);

  // --- Test 4: robot.explore (5 seconds) ---
  header('Test 4: robot.explore (5 seconds)');
  const exploreResult = await handleTool('robot.explore', {}, ctx);
  console.log(`  Success: ${exploreResult.success}`);
  console.log(`  Message: ${exploreResult.message}`);
  console.log(`  Waiting 5 seconds for vision loop to process frames...`);
  await sleep(5000);
  console.log(`  Frame history buffer: ${visionLoop.getFrameHistory().length} frames`);

  // --- Test 5: robot.stop ---
  header('Test 5: robot.stop');
  const stopResult = await handleTool('robot.stop', {}, ctx);
  console.log(`  Success: ${stopResult.success}`);
  console.log(`  Message: ${stopResult.message}`);

  // --- Test 6: robot.go_to with constraints ---
  header('Test 6: robot.go_to "the kitchen" (5 seconds)');
  const goToResult = await handleTool(
    'robot.go_to',
    { location: 'the kitchen', constraints: 'Max speed 4.7 cm/s. 20cm wide body.' },
    ctx,
  );
  console.log(`  Success: ${goToResult.success}`);
  console.log(`  Message: ${goToResult.message}`);
  console.log(`  Waiting 5 seconds for vision loop...`);
  await sleep(5000);
  console.log(`  Frame history buffer: ${visionLoop.getFrameHistory().length} frames`);

  // --- Stop and cleanup ---
  header('Cleanup');
  visionLoop.stop();
  await transmitter.disconnect();
  console.log('  All stopped. Test complete!\n');

  // --- Summary ---
  const stats = inference.getStats();
  header('Inference Stats');
  console.log(`  Total calls:    ${stats.totalCalls}`);
  console.log(`  Successful:     ${stats.successfulCalls}`);
  console.log(`  Failed:         ${stats.failedCalls}`);
  console.log(`  Avg latency:    ${Math.round(stats.averageLatencyMs)}ms`);
  console.log(`  Total tokens:   ${stats.totalTokens}`);
  console.log('');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
