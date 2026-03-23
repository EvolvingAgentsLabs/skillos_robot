/**
 * RoClaw Hardware Test Script — V1 Interactive Diagnostics
 *
 * Tests the V1 hardware setup: ESP32-S3 motor controller + external Android camera.
 * Sends raw bytecodes via UDP and verifies responses.
 *
 * Usage:
 *   npm run hardware:test                      # Interactive menu
 *   npm run hardware:test -- --test connectivity
 *   npm run hardware:test -- --test single-motor
 *   npm run hardware:test -- --test forward
 *   npm run hardware:test -- --test rotate
 *   npm run hardware:test -- --test status
 *   npm run hardware:test -- --test full-loop
 *   npm run hardware:test -- --test calibrate-forward
 *   npm run hardware:test -- --test calibrate-rotation
 *   npm run hardware:test -- --test navigate --goal "go to the red object"
 */

import * as dgram from 'dgram';
import * as dotenv from 'dotenv';
import { encodeFrame, formatHex, decodeFrame, Opcode, type BytecodeFrame } from '../src/2_qwen_cerebellum/bytecode_compiler';
import { ExternalCameraSource } from '../src/2_qwen_cerebellum/external_camera';

dotenv.config();

// =============================================================================
// Configuration
// =============================================================================

const ESP32_HOST = process.env.ESP32_S3_HOST || '192.168.1.100';
const ESP32_PORT = parseInt(process.env.ESP32_S3_PORT || '4210', 10);
const CAM_HOST = process.env.ESP32_CAM_HOST || '';
const CAM_PORT = parseInt(process.env.ESP32_CAM_PORT || '8080', 10);
const CAM_PATH = process.env.ESP32_CAM_PATH || '/video';

// =============================================================================
// UDP Helper
// =============================================================================

function sendBytecode(frame: BytecodeFrame, host: string, port: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const encoded = encodeFrame(frame);
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, 3000);

    socket.on('message', (msg) => {
      clearTimeout(timer);
      socket.close();
      resolve(msg);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.close();
      resolve(null);
    });

    socket.send(encoded, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.close();
        resolve(null);
      }
    });
  });
}

function sendBytecodeFireAndForget(frame: BytecodeFrame, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const encoded = encodeFrame(frame);

    socket.send(encoded, port, host, (err) => {
      socket.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Tests
// =============================================================================

async function testConnectivity(): Promise<boolean> {
  console.log('\n=== Test: Connectivity ===\n');
  let allOk = true;

  // Test ESP32-S3
  console.log(`[1/2] ESP32-S3 at ${ESP32_HOST}:${ESP32_PORT}...`);
  const response = await sendBytecode(
    { opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );

  if (response) {
    try {
      const status = JSON.parse(response.toString());
      console.log(`  OK — RSSI: ${status.rssi ?? 'N/A'}dBm, pose: (${status.pose?.x}, ${status.pose?.y})`);
    } catch {
      console.log(`  OK — Response: ${response.toString().slice(0, 100)}`);
    }
  } else {
    console.log('  FAIL — No response (check WiFi, IP address, and firmware)');
    allOk = false;
  }

  // Test Camera
  console.log(`[2/2] Camera at ${CAM_HOST}:${CAM_PORT}${CAM_PATH}...`);
  if (!CAM_HOST) {
    console.log('  SKIP — ESP32_CAM_HOST not set in .env');
  } else {
    const camera = new ExternalCameraSource({ host: CAM_HOST, port: CAM_PORT, path: CAM_PATH, enableSensors: false });
    const health = await camera.checkHealth();
    if (health.streamActive) {
      console.log(`  OK — Stream active, ${health.resolution ?? 'unknown resolution'}, ${health.latencyMs}ms latency`);
    } else {
      console.log('  FAIL — Cannot reach camera stream (check IP Webcam app is running)');
      allOk = false;
    }
  }

  console.log(`\nResult: ${allOk ? 'ALL PASSED' : 'SOME FAILED'}`);
  return allOk;
}

async function testSingleMotor(): Promise<void> {
  console.log('\n=== Test: Single Motor (Left Only) ===\n');
  console.log('Sending MOVE_FORWARD left=128, right=0...');

  const frame: BytecodeFrame = { opcode: Opcode.MOVE_FORWARD, paramLeft: 0x80, paramRight: 0x00 };
  console.log(`  Bytecode: ${formatHex(encodeFrame(frame))}`);

  await sendBytecodeFireAndForget(frame, ESP32_HOST, ESP32_PORT);
  console.log('  Sent! Left wheel should spin for ~2 seconds.');
  console.log('  If the RIGHT wheel spins instead, swap the motor connectors.');

  await sleep(3000);

  // Send stop
  await sendBytecodeFireAndForget(
    { opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );
  console.log('  STOP sent.');
}

async function testForward(): Promise<void> {
  console.log('\n=== Test: Both Motors Forward ===\n');
  console.log('Sending MOVE_FORWARD left=128, right=128...');

  const frame: BytecodeFrame = { opcode: Opcode.MOVE_FORWARD, paramLeft: 0x80, paramRight: 0x80 };
  console.log(`  Bytecode: ${formatHex(encodeFrame(frame))}`);

  await sendBytecodeFireAndForget(frame, ESP32_HOST, ESP32_PORT);
  console.log('  Sent! Robot should drive forward ~5cm.');
  console.log('  If it curves, this is normal — calibration will fix it.');

  await sleep(3000);

  await sendBytecodeFireAndForget(
    { opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );
  console.log('  STOP sent.');
}

async function testRotate(): Promise<void> {
  console.log('\n=== Test: Rotation (90 degrees CW) ===\n');
  console.log('Sending ROTATE_CW degrees=90, speed=128...');

  const frame: BytecodeFrame = { opcode: Opcode.ROTATE_CW, paramLeft: 90, paramRight: 0x80 };
  console.log(`  Bytecode: ${formatHex(encodeFrame(frame))}`);

  await sendBytecodeFireAndForget(frame, ESP32_HOST, ESP32_PORT);
  console.log('  Sent! Robot should rotate ~90 degrees clockwise.');

  await sleep(5000);

  await sendBytecodeFireAndForget(
    { opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );
  console.log('  STOP sent.');
}

async function testStatus(): Promise<void> {
  console.log('\n=== Test: Status Query ===\n');
  console.log('Sending GET_STATUS...');

  const response = await sendBytecode(
    { opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );

  if (response) {
    try {
      const status = JSON.parse(response.toString());
      console.log('  Response:');
      console.log(JSON.stringify(status, null, 2).split('\n').map(l => '    ' + l).join('\n'));
    } catch {
      console.log(`  Raw response: ${response.toString()}`);
    }
  } else {
    console.log('  FAIL — No response from ESP32-S3');
  }
}

async function testFullLoop(): Promise<void> {
  console.log('\n=== Test: Full Loop (Camera + Motor) ===\n');

  if (!CAM_HOST) {
    console.log('SKIP — ESP32_CAM_HOST not set in .env');
    return;
  }

  const camera = new ExternalCameraSource({ host: CAM_HOST, port: CAM_PORT, path: CAM_PATH, enableSensors: false });

  // Step 1: Capture frame
  console.log('[1/5] Capturing frame from camera...');
  const frame1 = await camera.captureFrame();
  if (frame1) {
    console.log(`  OK — Frame captured: ${frame1.length} bytes`);
  } else {
    console.log('  FAIL — Could not capture frame');
    return;
  }

  // Step 2: Query initial status
  console.log('[2/5] Querying initial status...');
  const status1 = await sendBytecode(
    { opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );
  if (status1) {
    const s = JSON.parse(status1.toString());
    console.log(`  OK — Pose: (${s.pose?.x}, ${s.pose?.y}), heading: ${s.pose?.h}`);
  } else {
    console.log('  FAIL — No status response');
    return;
  }

  // Step 3: Send forward command
  console.log('[3/5] Sending MOVE_FORWARD...');
  await sendBytecodeFireAndForget(
    { opcode: Opcode.MOVE_FORWARD, paramLeft: 0x60, paramRight: 0x60 },
    ESP32_HOST,
    ESP32_PORT,
  );
  console.log('  Sent! Waiting 3 seconds...');
  await sleep(3000);

  // Step 4: Stop and query new status
  console.log('[4/5] Stopping and querying new status...');
  await sendBytecodeFireAndForget(
    { opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );
  await sleep(500);
  const status2 = await sendBytecode(
    { opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );
  if (status2) {
    const s = JSON.parse(status2.toString());
    console.log(`  OK — New pose: (${s.pose?.x}, ${s.pose?.y}), heading: ${s.pose?.h}`);
  }

  // Step 5: Capture another frame
  console.log('[5/5] Capturing post-movement frame...');
  const frame2 = await camera.captureFrame();
  if (frame2) {
    console.log(`  OK — Frame captured: ${frame2.length} bytes`);
  }

  console.log('\nFull loop test complete!');
}

async function testCalibrateForward(): Promise<void> {
  console.log('\n=== Calibration: Forward Distance ===\n');
  console.log('This will command the robot to move forward for ~50cm.');
  console.log('Mark the starting position and measure actual distance traveled.\n');

  // Reset pose first
  await sendBytecodeFireAndForget(
    { opcode: Opcode.RESET, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );
  console.log('Pose reset. Sending 10 forward commands (5cm each = ~50cm total)...\n');

  for (let i = 0; i < 10; i++) {
    await sendBytecodeFireAndForget(
      { opcode: Opcode.MOVE_FORWARD, paramLeft: 0x80, paramRight: 0x80 },
      ESP32_HOST,
      ESP32_PORT,
    );
    console.log(`  Command ${i + 1}/10 sent`);
    await sleep(2000);
  }

  await sendBytecodeFireAndForget(
    { opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );

  // Query final pose
  const response = await sendBytecode(
    { opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );

  if (response) {
    const status = JSON.parse(response.toString());
    const estimatedCm = Math.sqrt(status.pose.x ** 2 + status.pose.y ** 2);
    console.log(`\nOdometry reports: ${estimatedCm.toFixed(1)}cm traveled`);
  }

  console.log('\nMeasure the actual distance with a ruler.');
  console.log('If actual < expected: reduce WHEEL_DIAMETER_CM in firmware.');
  console.log('If actual > expected: increase WHEEL_DIAMETER_CM in firmware.');
  console.log('Formula: new_diameter = 6.0 * (actual_cm / 50.0)');
}

async function testCalibrateRotation(): Promise<void> {
  console.log('\n=== Calibration: Rotation ===\n');
  console.log('This will command the robot to rotate 360 degrees.');
  console.log('Mark the starting heading and measure actual rotation.\n');

  // Reset pose
  await sendBytecodeFireAndForget(
    { opcode: Opcode.RESET, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );
  console.log('Pose reset. Sending 4 x 90-degree rotation commands...\n');

  for (let i = 0; i < 4; i++) {
    await sendBytecodeFireAndForget(
      { opcode: Opcode.ROTATE_CW, paramLeft: 90, paramRight: 0x80 },
      ESP32_HOST,
      ESP32_PORT,
    );
    console.log(`  Rotation ${i + 1}/4 sent (90 degrees)`);
    await sleep(4000);
  }

  await sendBytecodeFireAndForget(
    { opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 },
    ESP32_HOST,
    ESP32_PORT,
  );

  console.log('\nDone! The robot should be facing the same direction as the start.');
  console.log('If it under-rotated: decrease WHEEL_BASE_CM in firmware.');
  console.log('If it over-rotated: increase WHEEL_BASE_CM in firmware.');
  console.log('Formula: new_base = 10.0 * (actual_degrees / 360)');
}

async function testNavigate(goal: string): Promise<void> {
  console.log(`\n=== Test: Navigate — "${goal}" ===\n`);
  console.log('This test requires a running LLM inference endpoint.');
  console.log('Starting VisionLoop for 30 seconds...\n');

  // Import the full stack dynamically to avoid loading when not needed
  const { BytecodeCompiler } = await import('../src/2_qwen_cerebellum/bytecode_compiler');
  const { UDPTransmitter } = await import('../src/2_qwen_cerebellum/udp_transmitter');
  const { VisionLoop } = await import('../src/2_qwen_cerebellum/vision_loop');

  const compiler = new BytecodeCompiler('fewshot');
  const transmitter = new UDPTransmitter({ host: ESP32_HOST, port: ESP32_PORT });
  await transmitter.connect();

  // Try to create a basic inference function
  let infer: (system: string, user: string, images: string[]) => Promise<string>;

  if (process.env.GOOGLE_API_KEY) {
    const { GeminiRoboticsInference } = await import('../src/2_qwen_cerebellum/gemini_robotics');
    const inference = new GeminiRoboticsInference({
      apiKey: process.env.GOOGLE_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
      maxOutputTokens: 64,
      temperature: 0.1,
      timeoutMs: 10000,
      thinkingBudget: 0,
      useToolCalling: true,
    });
    infer = inference.createInferenceFunction();
    console.log('Using Gemini Robotics inference');
  } else {
    console.log('FAIL — No inference backend configured (set GOOGLE_API_KEY or OPENROUTER_API_KEY)');
    await transmitter.disconnect();
    return;
  }

  const cameraUrl = `http://${CAM_HOST}:${CAM_PORT}${CAM_PATH}`;
  const visionLoop = new VisionLoop(
    { cameraUrl, targetFPS: 2, frameHistorySize: 4, useToolCallingPrompt: true },
    compiler,
    transmitter,
    infer,
  );

  let bytecodeCount = 0;
  visionLoop.on('bytecode', (bytecode: Buffer) => {
    bytecodeCount++;
    console.log(`  [${bytecodeCount}] ${formatHex(bytecode)}`);
  });

  visionLoop.on('arrival', () => {
    console.log('\n  ARRIVAL DETECTED!');
  });

  visionLoop.on('stuck', () => {
    console.log('\n  STUCK DETECTED — recovery triggered');
  });

  console.log(`Starting VisionLoop → ${cameraUrl}`);
  console.log('Press Ctrl+C to stop early.\n');

  await visionLoop.start(goal);

  // Run for 30 seconds
  await sleep(30000);

  visionLoop.stop();
  await transmitter.disconnect();

  console.log(`\nNavigate test complete. ${bytecodeCount} bytecodes sent.`);
}

// =============================================================================
// CLI
// =============================================================================

const TEST_MAP: Record<string, () => Promise<void>> = {
  'connectivity': async () => { await testConnectivity(); },
  'single-motor': testSingleMotor,
  'forward': testForward,
  'rotate': testRotate,
  'status': testStatus,
  'full-loop': testFullLoop,
  'calibrate-forward': testCalibrateForward,
  'calibrate-rotation': testCalibrateRotation,
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let testName: string | null = null;
  let goal = 'go to the red object';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--test': testName = args[++i]; break;
      case '--goal': goal = args[++i]; break;
      case '--help': case '-h':
        console.log(`
RoClaw Hardware Test Script — V1 Interactive Diagnostics

Usage: npm run hardware:test -- [options]

Options:
  --test <name>    Run a specific test:
                     connectivity       Test ESP32 + camera reachability
                     single-motor       Spin left motor only
                     forward            Drive both motors forward
                     rotate             Rotate 90 degrees CW
                     status             Query ESP32 status (JSON)
                     full-loop          Camera + motor + status
                     calibrate-forward  Drive 50cm for distance calibration
                     calibrate-rotation Rotate 360 for heading calibration
                     navigate           Run VisionLoop with a goal (30s)
  --goal <text>    Navigation goal (default: "go to the red object")
  --help, -h       Show this help

Environment (.env):
  ESP32_S3_HOST    ESP32-S3 IP address (default: 192.168.1.100)
  ESP32_S3_PORT    UDP port (default: 4210)
  ESP32_CAM_HOST   Camera IP address
  ESP32_CAM_PORT   Camera HTTP port (default: 8080)
  ESP32_CAM_PATH   MJPEG stream path (default: /video)
`);
        process.exit(0);
    }
  }

  console.log('RoClaw Hardware Test');
  console.log(`  ESP32-S3: ${ESP32_HOST}:${ESP32_PORT}`);
  console.log(`  Camera:   ${CAM_HOST ? `${CAM_HOST}:${CAM_PORT}${CAM_PATH}` : '(not configured)'}`);

  if (testName === 'navigate') {
    await testNavigate(goal);
    return;
  }

  if (testName && TEST_MAP[testName]) {
    await TEST_MAP[testName]();
  } else if (testName) {
    console.error(`Unknown test: ${testName}`);
    console.error(`Available tests: ${Object.keys(TEST_MAP).join(', ')}, navigate`);
    process.exit(1);
  } else {
    // Run all basic tests sequentially
    console.log('\nRunning all basic tests...\n');
    const ok = await testConnectivity();
    if (ok) {
      await testStatus();
      await testSingleMotor();
      await sleep(1000);
      await testForward();
      await sleep(1000);
      await testRotate();
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
