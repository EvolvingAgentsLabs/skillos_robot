/**
 * RoClaw Virtual Simulator — Sim2Real validation
 *
 * Replaces both ESP32 microcontrollers with virtual servers on localhost,
 * allowing the full RoClaw stack to run without physical hardware.
 *
 *   - Virtual ESP32-S3:  UDP server receiving 6-byte bytecode, tracking pose
 *   - Virtual ESP32-CAM: HTTP MJPEG server streaming valid JPEG frames
 *   - Mock Inference:    Optional OpenRouter-compatible API (--mock-inference)
 *   - Terminal Dashboard: Live display of robot state and commands
 *
 * Usage:
 *   npm run sim                       # Basic simulation
 *   npm run sim -- --mock-inference   # With mock VLM inference
 *   npm run sim -- --verbose          # Log mode (pipe-friendly)
 */

import * as dgram from 'dgram';
import * as http from 'http';
import * as fs from 'fs';

import {
  Opcode, OPCODE_NAMES, decodeFrame, formatHex, FRAME_SIZE, encodeFrame,
  type BytecodeFrame,
} from '../control/bytecode_compiler';
import { StepperKinematics } from '../shared/stepper-kinematics';

// =============================================================================
// Types
// =============================================================================

interface CommandRecord {
  time: number;
  opcode: number;
  paramLeft: number;
  paramRight: number;
  hex: string;
}

interface RobotState {
  x: number;
  y: number;
  heading: number;
  motorRunning: boolean;
  leftSpeed: number;
  rightSpeed: number;
  ledState: number;
  commandHistory: CommandRecord[];
  commandCount: number;
  startTime: number;
}

interface SimConfig {
  udpPort: number;
  camPort: number;
  fps: number;
  mockInference: boolean;
  mockPort: number;
  imagePath: string | null;
  verbose: boolean;
}

// =============================================================================
// CLI Parsing
// =============================================================================

function parseArgs(): SimConfig {
  const args = process.argv.slice(2);
  const config: SimConfig = {
    udpPort: 4210,
    camPort: 8081,
    fps: 2,
    mockInference: false,
    mockPort: 8199,
    imagePath: null,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--udp-port':  config.udpPort = parseInt(args[++i], 10); break;
      case '--cam-port':  config.camPort = parseInt(args[++i], 10); break;
      case '--fps':       config.fps = parseInt(args[++i], 10); break;
      case '--mock-inference': config.mockInference = true; break;
      case '--mock-port': config.mockPort = parseInt(args[++i], 10); break;
      case '--image':     config.imagePath = args[++i]; break;
      case '--verbose':   config.verbose = true; break;
      case '--help': case '-h':
        console.log(`
RoClaw Virtual Simulator — Sim2Real validation

Usage: npm run sim -- [options]

Options:
  --udp-port <N>      UDP port for virtual ESP32-S3 (default: 4210)
  --cam-port <N>      HTTP port for virtual ESP32-CAM (default: 8081)
  --fps <N>           MJPEG frame rate (default: 2)
  --mock-inference    Start mock inference server
  --mock-port <N>     Mock inference port (default: 8199)
  --image <path>      Custom JPEG to stream instead of minimal test image
  --verbose           Line-by-line logs instead of dashboard
  --help, -h          Show this help
`);
        process.exit(0);
    }
  }

  return config;
}

// =============================================================================
// Minimal Valid JPEG (1x1 grayscale, ~141 bytes)
// =============================================================================

function createMinimalJpeg(): Buffer {
  return Buffer.from([
    // SOI
    0xFF, 0xD8,
    // DQT — quantization table (all-ones, table 0)
    0xFF, 0xDB, 0x00, 0x43, 0x00,
    ...Array(64).fill(0x01),
    // SOF0 — baseline, 1x1, 1 component (grayscale)
    0xFF, 0xC0, 0x00, 0x0B, 0x08,
    0x00, 0x01, 0x00, 0x01,
    0x01, 0x01, 0x11, 0x00,
    // DHT — DC Huffman table 0 (1 symbol: category 0)
    0xFF, 0xC4, 0x00, 0x14, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00,
    // DHT — AC Huffman table 0 (1 symbol: EOB)
    0xFF, 0xC4, 0x00, 0x14, 0x10,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00,
    // SOS — start of scan
    0xFF, 0xDA, 0x00, 0x08,
    0x01, 0x01, 0x00, 0x00, 0x3F, 0x00,
    // Entropy coded data (DC=0, EOB, padded with 1-bits)
    0x3F,
    // EOI
    0xFF, 0xD9,
  ]);
}

function loadJpeg(config: SimConfig): Buffer {
  if (config.imagePath) {
    const data = fs.readFileSync(config.imagePath);
    if (data.length < 2 || data[0] !== 0xFF || data[1] !== 0xD8) {
      console.error(`Error: ${config.imagePath} is not a valid JPEG (missing FFD8 header)`);
      process.exit(1);
    }
    return data;
  }
  return createMinimalJpeg();
}

// =============================================================================
// Kinematics Helpers
// =============================================================================

const PULSE_DURATION_S = 0.5;

function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function speedToCm(speed: number, kin: StepperKinematics): number {
  const fraction = speed / 255;
  const stepsPerPulse = fraction * kin.getSpec().maxStepsPerSecond * PULSE_DURATION_S;
  return kin.stepsToDistance(stepsPerPulse);
}

function applyDrive(
  state: RobotState,
  leftCm: number,
  rightCm: number,
  wheelBase: number,
): void {
  const headingRad = state.heading * Math.PI / 180;
  const avgCm = (leftCm + rightCm) / 2;
  const dTheta = (rightCm - leftCm) / wheelBase;

  state.x += avgCm * Math.sin(headingRad);
  state.y += avgCm * Math.cos(headingRad);
  state.heading = normalizeDegrees(state.heading + dTheta * 180 / Math.PI);
}

function applyCommand(state: RobotState, frame: BytecodeFrame, kin: StepperKinematics): void {
  const wheelBase = kin.getSpec().wheelBaseCm;

  switch (frame.opcode) {
    case Opcode.MOVE_FORWARD: {
      const l = speedToCm(frame.paramLeft, kin);
      const r = speedToCm(frame.paramRight, kin);
      applyDrive(state, l, r, wheelBase);
      state.leftSpeed = frame.paramLeft;
      state.rightSpeed = frame.paramRight;
      state.motorRunning = true;
      break;
    }
    case Opcode.MOVE_BACKWARD: {
      const l = speedToCm(frame.paramLeft, kin);
      const r = speedToCm(frame.paramRight, kin);
      applyDrive(state, -l, -r, wheelBase);
      state.leftSpeed = frame.paramLeft;
      state.rightSpeed = frame.paramRight;
      state.motorRunning = true;
      break;
    }
    case Opcode.TURN_LEFT:
    case Opcode.TURN_RIGHT: {
      const l = speedToCm(frame.paramLeft, kin);
      const r = speedToCm(frame.paramRight, kin);
      applyDrive(state, l, r, wheelBase);
      state.leftSpeed = frame.paramLeft;
      state.rightSpeed = frame.paramRight;
      state.motorRunning = true;
      break;
    }
    case Opcode.ROTATE_CW: {
      state.heading = normalizeDegrees(state.heading + frame.paramLeft);
      state.motorRunning = true;
      break;
    }
    case Opcode.ROTATE_CCW: {
      state.heading = normalizeDegrees(state.heading - frame.paramLeft);
      state.motorRunning = true;
      break;
    }
    case Opcode.STOP: {
      state.motorRunning = false;
      state.leftSpeed = 0;
      state.rightSpeed = 0;
      break;
    }
    case Opcode.SET_SPEED: {
      state.leftSpeed = frame.paramLeft;
      state.rightSpeed = frame.paramRight;
      break;
    }
    case Opcode.MOVE_STEPS: {
      const leftCm = kin.stepsToDistance(frame.paramLeft);
      applyDrive(state, leftCm, 0, wheelBase);
      state.motorRunning = true;
      break;
    }
    case Opcode.MOVE_STEPS_R: {
      const rightCm = kin.stepsToDistance(frame.paramLeft);
      applyDrive(state, 0, rightCm, wheelBase);
      state.motorRunning = true;
      break;
    }
    case Opcode.LED_SET: {
      state.ledState = frame.paramLeft;
      break;
    }
    case Opcode.RESET: {
      state.x = 0;
      state.y = 0;
      state.heading = 0;
      state.motorRunning = false;
      state.leftSpeed = 0;
      state.rightSpeed = 0;
      state.ledState = 0;
      break;
    }
    // GET_STATUS (0x08) is handled inline in the UDP server
  }
}

// =============================================================================
// Virtual ESP32-S3 — UDP Server
// =============================================================================

function startUdpServer(
  config: SimConfig,
  state: RobotState,
  kin: StepperKinematics,
): dgram.Socket {
  const socket = dgram.createSocket('udp4');

  socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const frame = decodeFrame(msg);
    if (!frame) {
      if (config.verbose) {
        console.log(`[UDP] Invalid frame from ${rinfo.address}:${rinfo.port}: ${formatHex(msg)}`);
      }
      return;
    }

    const opName = OPCODE_NAMES[frame.opcode] || `0x${frame.opcode.toString(16).toUpperCase()}`;

    // Record command
    state.commandCount++;
    state.commandHistory.push({
      time: Date.now(),
      opcode: frame.opcode,
      paramLeft: frame.paramLeft,
      paramRight: frame.paramRight,
      hex: formatHex(msg),
    });
    if (state.commandHistory.length > 50) state.commandHistory.shift();

    // Handle GET_STATUS — send JSON response back to sender
    if (frame.opcode === Opcode.GET_STATUS) {
      const status = JSON.stringify({
        pose: {
          x: Math.round(state.x * 100) / 100,
          y: Math.round(state.y * 100) / 100,
          h: state.heading * Math.PI / 180,
        },
        run: state.motorRunning,
        led: state.ledState,
        cmds: state.commandCount,
        uptime: Date.now() - state.startTime,
      });
      socket.send(Buffer.from(status), rinfo.port, rinfo.address);
      if (config.verbose) {
        console.log(`[UDP] ${opName} → status response sent`);
      }
      return;
    }

    // Apply command to robot state
    applyCommand(state, frame, kin);

    if (config.verbose) {
      console.log(
        `[UDP] ${formatHex(msg)} → ${opName}` +
        ` | pose=(${state.x.toFixed(1)}, ${state.y.toFixed(1)}, ${state.heading.toFixed(0)}°)` +
        ` | motor=${state.motorRunning ? 'ON' : 'OFF'}`
      );
    }
  });

  socket.on('error', (err) => {
    console.error(`[UDP] Socket error: ${err.message}`);
    socket.close();
  });

  socket.bind(config.udpPort, '0.0.0.0', () => {
    if (config.verbose) {
      console.log(`[UDP] Virtual ESP32-S3 listening on port ${config.udpPort}`);
    }
  });

  return socket;
}

// =============================================================================
// Virtual ESP32-CAM — MJPEG HTTP Server
// =============================================================================

function startCameraServer(config: SimConfig, jpegData: Buffer): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url !== '/stream') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found. Use /stream for MJPEG.');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace;boundary=frame',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const sendFrame = () => {
      const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegData.length}\r\n\r\n`;
      res.write(Buffer.concat([Buffer.from(header), jpegData, Buffer.from('\r\n')]));
    };

    // Send first frame immediately
    sendFrame();
    const interval = setInterval(sendFrame, 1000 / config.fps);

    req.on('close', () => clearInterval(interval));
    res.on('error', () => clearInterval(interval));
  });

  server.listen(config.camPort, '0.0.0.0', () => {
    if (config.verbose) {
      console.log(`[CAM] Virtual ESP32-CAM streaming on http://127.0.0.1:${config.camPort}/stream (${config.fps} FPS)`);
    }
  });

  return server;
}

// =============================================================================
// Mock Inference Server (OpenRouter-compatible)
// =============================================================================

const MOCK_COMMANDS: BytecodeFrame[] = [
  { opcode: Opcode.MOVE_FORWARD,  paramLeft: 0x80, paramRight: 0x80 },
  { opcode: Opcode.MOVE_FORWARD,  paramLeft: 0x80, paramRight: 0x80 },
  { opcode: Opcode.TURN_RIGHT,    paramLeft: 0x60, paramRight: 0x80 },
  { opcode: Opcode.MOVE_FORWARD,  paramLeft: 0x80, paramRight: 0x80 },
  { opcode: Opcode.TURN_LEFT,     paramLeft: 0x60, paramRight: 0x80 },
];

const MOCK_HEX_RESPONSES = MOCK_COMMANDS.map(cmd => formatHex(encodeFrame(cmd)));

function startMockInference(config: SimConfig): http.Server {
  let callIndex = 0;

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const hexResponse = MOCK_HEX_RESPONSES[callIndex % MOCK_HEX_RESPONSES.length];
      callIndex++;

      const response = {
        id: `mock-${callIndex}`,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: hexResponse },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 50, completion_tokens: 6, total_tokens: 56 },
      };

      if (config.verbose) {
        console.log(`[INF] Mock inference #${callIndex} → ${hexResponse}`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });

  server.listen(config.mockPort, '0.0.0.0', () => {
    if (config.verbose) {
      console.log(`[INF] Mock inference server on http://127.0.0.1:${config.mockPort}/v1/chat/completions`);
    }
  });

  return server;
}

// =============================================================================
// Terminal Dashboard
// =============================================================================

function getCompassArrow(heading: number): string {
  const idx = Math.round(normalizeDegrees(heading) / 45) % 8;
  return ['\u2191', '\u2197', '\u2192', '\u2198', '\u2193', '\u2199', '\u2190', '\u2196'][idx];
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function renderDashboard(state: RobotState, config: SimConfig): void {
  const uptime = Date.now() - state.startTime;
  const last = state.commandHistory[state.commandHistory.length - 1];
  const lastOpName = last ? (OPCODE_NAMES[last.opcode] || '???') : '---';
  const lastHex = last ? last.hex : '-- -- -- -- -- --';
  const arrow = getCompassArrow(state.heading);

  // ANSI clear screen + cursor home
  process.stdout.write('\x1B[2J\x1B[H');

  const lines = [
    '\x1B[1;36m===== RoClaw Virtual Simulator =====\x1B[0m',
    '',
    `  \x1B[1mPose:\x1B[0m  x=${state.x.toFixed(2)} cm   y=${state.y.toFixed(2)} cm   heading=${state.heading.toFixed(1)}° ${arrow}`,
    `  \x1B[1mMotor:\x1B[0m ${state.motorRunning ? '\x1B[32mRUNNING\x1B[0m' : '\x1B[33mIDLE\x1B[0m'}   L=${state.leftSpeed}  R=${state.rightSpeed}`,
    `  \x1B[1mLED:\x1B[0m   ${state.ledState > 0 ? '\x1B[33m' + state.ledState + '\x1B[0m' : 'OFF'}`,
    '',
    `  \x1B[1mCommands:\x1B[0m ${state.commandCount}   \x1B[1mUptime:\x1B[0m ${formatUptime(uptime)}`,
    `  \x1B[1mLast:\x1B[0m    ${lastHex}  \x1B[36m${lastOpName}\x1B[0m`,
    '',
    '\x1B[90m' + '-'.repeat(40) + '\x1B[0m',
    `  UDP  :4210${config.udpPort !== 4210 ? ' (' + config.udpPort + ')' : ''}   ` +
    `CAM  :${config.camPort}   ` +
    (config.mockInference ? `INF  :${config.mockPort}` : 'INF  off'),
    '\x1B[90m  Ctrl+C to stop\x1B[0m',
  ];

  console.log(lines.join('\n'));
}

// =============================================================================
// Boot
// =============================================================================

async function main(): Promise<void> {
  const config = parseArgs();
  const kin = new StepperKinematics();
  const jpegData = loadJpeg(config);

  const state: RobotState = {
    x: 0,
    y: 0,
    heading: 0,
    motorRunning: false,
    leftSpeed: 0,
    rightSpeed: 0,
    ledState: 0,
    commandHistory: [],
    commandCount: 0,
    startTime: Date.now(),
  };

  // Start servers
  const udpSocket = startUdpServer(config, state, kin);
  const camServer = startCameraServer(config, jpegData);
  let mockServer: http.Server | undefined;
  if (config.mockInference) {
    mockServer = startMockInference(config);
  }

  // Dashboard or verbose banner
  if (config.verbose) {
    console.log('');
    console.log('===== RoClaw Virtual Simulator =====');
    console.log(`  UDP server  : 0.0.0.0:${config.udpPort}`);
    console.log(`  MJPEG server: http://0.0.0.0:${config.camPort}/stream (${config.fps} FPS, ${jpegData.length} byte JPEG)`);
    if (config.mockInference) {
      console.log(`  Mock infer  : http://0.0.0.0:${config.mockPort}/v1/chat/completions`);
    }
    console.log('');
  }

  // Print .env connection instructions
  const envLines = [
    '--- Copy to .env for localhost operation ---',
    `ESP32_S3_HOST=127.0.0.1`,
    `ESP32_S3_PORT=${config.udpPort}`,
    `ESP32_CAM_HOST=127.0.0.1`,
    `ESP32_CAM_PORT=${config.camPort}`,
  ];
  if (config.mockInference) {
    envLines.push(`LOCAL_INFERENCE_URL=http://127.0.0.1:${config.mockPort}/v1`);
  }
  envLines.push('-------------------------------------------');

  if (config.verbose) {
    envLines.forEach(l => console.log(`  ${l}`));
    console.log('');
    console.log('Waiting for commands...');
  } else {
    // Show banner briefly before dashboard takes over
    console.log('');
    envLines.forEach(l => console.log(`  ${l}`));
    console.log('');
  }

  // Start dashboard refresh loop (non-verbose only)
  let dashboardInterval: ReturnType<typeof setInterval> | undefined;
  if (!config.verbose) {
    // Small delay to let banner display
    await new Promise(r => setTimeout(r, 1500));
    dashboardInterval = setInterval(() => renderDashboard(state, config), 500);
  }

  // Graceful shutdown
  const shutdown = () => {
    if (dashboardInterval) clearInterval(dashboardInterval);

    if (!config.verbose) {
      process.stdout.write('\x1B[2J\x1B[H');
    }
    console.log('\nShutting down RoClaw Virtual Simulator...');

    udpSocket.close();
    camServer.close();
    if (mockServer) mockServer.close();

    console.log(`Session: ${state.commandCount} commands received, uptime ${formatUptime(Date.now() - state.startTime)}`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
