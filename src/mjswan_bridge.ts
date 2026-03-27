/**
 * RoClaw mjswan Bridge — 3D Physics Simulator via WebSocket
 *
 * Drop-in replacement for virtual_roclaw.ts that bridges the RoClaw control
 * stack (UDP bytecodes + MJPEG frames) to a browser running mjswan (MuJoCo
 * WASM + Three.js rendering) via WebSocket.
 *
 * Architecture:
 *   Browser (mjswan + BridgeAdapter)  <--WS:9090-->  This bridge  <--UDP:4210-->  RoClaw stack
 *                                                     |
 *                                                     +--> MJPEG :8081 --> VisionLoop
 *
 * Usage:
 *   npm run sim:3d                        # Start bridge (default ports)
 *   npm run sim:3d -- --ws-port 9091      # Custom WebSocket port
 *   npm run sim:3d -- --verbose           # Log mode
 */

import * as dgram from 'dgram';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

import {
  Opcode, OPCODE_NAMES, decodeFrame, formatHex, FRAME_SIZE,
  decodeFrameAuto, encodeFrameV2, ACK_FLAG, ACK_OPCODE, FRAME_SIZE_V2,
  type BytecodeFrame, type BytecodeFrameV2,
} from './2_qwen_cerebellum/bytecode_compiler';
import { DEFAULT_28BYJ48_SPEC } from './shared/stepper-kinematics';

// =============================================================================
// Types
// =============================================================================

interface BridgeConfig {
  udpPort: number;
  camPort: number;
  wsPort: number;
  fps: number;
  verbose: boolean;
}

interface CommandRecord {
  time: number;
  opcode: number;
  paramLeft: number;
  paramRight: number;
  hex: string;
}

interface GoalTarget {
  name: string;
  x: number;
  y: number;
  radius: number;
}

interface BridgeState {
  commandHistory: CommandRecord[];
  commandCount: number;
  startTime: number;
  wsConnected: boolean;
  framesReceived: number;
  lastCtrl: [number, number];
  /** Latest pose reported by the browser (MuJoCo world coordinates) */
  pose: { x: number; y: number; h: number };
  /** Euclidean distance to current goal target */
  targetDistance: number;
  /** Whether the robot is within the target's arrival radius */
  goalReached: boolean;
  /** Last known UDP client address (for telemetry push) */
  lastClientRinfo: dgram.RemoteInfo | null;
  /** Stall detection: last pose snapshot and timestamp */
  stallPose: { x: number; y: number; ts: number };
  /** Whether robot is currently stalled */
  stall: boolean;
}

/** Telemetry message pushed from bridge to RoClaw stack */
export interface TelemetryMessage {
  telemetry: true;
  pose: { x: number; y: number; h: number };
  vel: { left: number; right: number };
  stall: boolean;
  ts: number;
}

/** WebSocket message: bridge -> browser */
interface CtrlMessage {
  type: 'ctrl';
  left: number;
  right: number;
}

/** WebSocket message: bridge -> browser */
interface PoseRequestMessage {
  type: 'pose_request';
}

/** WebSocket message: browser -> bridge */
interface FrameMessage {
  type: 'frame';
  jpeg: string; // base64
}

/** WebSocket message: browser -> bridge */
interface PoseMessage {
  type: 'pose';
  x: number;
  y: number;
  h: number;
}

type BrowserMessage = FrameMessage | PoseMessage;

// =============================================================================
// Constants — Motor Physics
// =============================================================================

/**
 * Maximum wheel angular velocity in rad/s.
 * Derived from 28BYJ-48 motor specs:
 *   (maxStepsPerSecond / stepsPerRevolution) * 2 * PI
 *   = (1024 / 4096) * 2 * PI
 *   = 0.25 * 6.2832
 *   = 1.5708 rad/s
 */
export const MAX_WHEEL_RAD_S =
  (DEFAULT_28BYJ48_SPEC.maxStepsPerSecond / DEFAULT_28BYJ48_SPEC.stepsPerRevolution) * 2 * Math.PI;

// =============================================================================
// Bytecode -> MuJoCo ctrl translation
// =============================================================================

/**
 * Convert a 0-255 speed parameter to wheel angular velocity in rad/s.
 */
export function speedParamToRadS(param: number): number {
  return (param / 255) * MAX_WHEEL_RAD_S;
}

/**
 * Translate a RoClaw bytecode frame into MuJoCo velocity actuator controls.
 *
 * Returns [left_wheel_rad_s, right_wheel_rad_s] suitable for setting
 * mjData.ctrl[0] and mjData.ctrl[1] on the roclaw_robot.xml model.
 */
export function bytecodeToCtrl(frame: BytecodeFrame): [number, number] {
  switch (frame.opcode) {
    case Opcode.MOVE_FORWARD: {
      const left = speedParamToRadS(frame.paramLeft);
      const right = speedParamToRadS(frame.paramRight);
      return [left, right];
    }
    case Opcode.MOVE_BACKWARD: {
      const left = speedParamToRadS(frame.paramLeft);
      const right = speedParamToRadS(frame.paramRight);
      return [-left, -right];
    }
    case Opcode.TURN_LEFT:
    case Opcode.TURN_RIGHT: {
      // VLM sets differential params directly (e.g. left=0x60, right=0x80)
      const left = speedParamToRadS(frame.paramLeft);
      const right = speedParamToRadS(frame.paramRight);
      return [left, right];
    }
    case Opcode.ROTATE_CW: {
      const vel = speedParamToRadS(frame.paramRight || frame.paramLeft);
      return [vel, -vel];
    }
    case Opcode.ROTATE_CCW: {
      const vel = speedParamToRadS(frame.paramRight || frame.paramLeft);
      return [-vel, vel];
    }
    case Opcode.STOP:
      return [0, 0];
    default:
      return [0, 0];
  }
}

// =============================================================================
// Minimal Valid JPEG (1x1 grayscale fallback)
// =============================================================================

function createMinimalJpeg(): Buffer {
  return Buffer.from([
    0xFF, 0xD8,
    0xFF, 0xDB, 0x00, 0x43, 0x00,
    ...Array(64).fill(0x01),
    0xFF, 0xC0, 0x00, 0x0B, 0x08,
    0x00, 0x01, 0x00, 0x01,
    0x01, 0x01, 0x11, 0x00,
    0xFF, 0xC4, 0x00, 0x14, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00,
    0xFF, 0xC4, 0x00, 0x14, 0x10,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00,
    0xFF, 0xDA, 0x00, 0x08,
    0x01, 0x01, 0x00, 0x00, 0x3F, 0x00,
    0x3F,
    0xFF, 0xD9,
  ]);
}

// =============================================================================
// CLI Parsing
// =============================================================================

const DEFAULT_TARGET: GoalTarget = { name: 'red_cube', x: -0.6, y: -0.5, radius: 0.25 };

function parseTarget(spec: string): GoalTarget {
  const parts = spec.split(':');
  if (parts.length !== 4) {
    console.error(`Invalid --target format: "${spec}". Expected name:x:y:radius`);
    process.exit(1);
  }
  return {
    name: parts[0],
    x: parseFloat(parts[1]),
    y: parseFloat(parts[2]),
    radius: parseFloat(parts[3]),
  };
}

function parseArgs(): { config: BridgeConfig; target: GoalTarget } {
  const args = process.argv.slice(2);
  const config: BridgeConfig = {
    udpPort: 4210,
    camPort: 8081,
    wsPort: 9090,
    fps: 2,
    verbose: false,
  };
  let target = DEFAULT_TARGET;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--udp-port':  config.udpPort = parseInt(args[++i], 10); break;
      case '--cam-port':  config.camPort = parseInt(args[++i], 10); break;
      case '--ws-port':   config.wsPort = parseInt(args[++i], 10); break;
      case '--fps':       config.fps = parseInt(args[++i], 10); break;
      case '--target':    target = parseTarget(args[++i]); break;
      case '--verbose':   config.verbose = true; break;
      case '--help': case '-h':
        console.log(`
RoClaw mjswan Bridge — 3D Physics Simulator

Usage: npm run sim:3d -- [options]

Options:
  --udp-port <N>   UDP port for bytecodes from RoClaw stack (default: 4210)
  --cam-port <N>   HTTP port for MJPEG stream to VisionLoop (default: 8081)
  --ws-port <N>    WebSocket port for browser connection (default: 9090)
  --fps <N>        MJPEG stream frame rate (default: 2)
  --target <spec>  Goal target as name:x:y:radius (default: red_cube:-0.6:-0.5:0.25)
  --verbose        Line-by-line logs instead of dashboard
  --help, -h       Show this help
`);
        process.exit(0);
    }
  }

  return { config, target };
}

// =============================================================================
// WebSocket Server — bridge <-> browser
// =============================================================================

function startWebSocketServer(
  config: BridgeConfig,
  state: BridgeState,
  latestJpeg: { data: Buffer },
  target: GoalTarget,
): WebSocketServer {
  const wss = new WebSocketServer({ port: config.wsPort });
  let browserSocket: WebSocket | null = null;

  wss.on('connection', (ws) => {
    browserSocket = ws;
    state.wsConnected = true;

    if (config.verbose) {
      console.log('[WS] Browser connected');
    }

    ws.on('message', (raw) => {
      try {
        const msg: BrowserMessage = JSON.parse(raw.toString());

        if (msg.type === 'frame') {
          latestJpeg.data = Buffer.from(msg.jpeg, 'base64');
          state.framesReceived++;
        } else if (msg.type === 'pose') {
          state.pose = { x: msg.x, y: msg.y, h: msg.h };
          const dx = msg.x - target.x;
          const dy = msg.y - target.y;
          state.targetDistance = Math.sqrt(dx * dx + dy * dy);
          state.goalReached = state.targetDistance < target.radius;
        }
      } catch {
        if (config.verbose) {
          console.log('[WS] Invalid message from browser');
        }
      }
    });

    ws.on('close', () => {
      browserSocket = null;
      state.wsConnected = false;
      if (config.verbose) {
        console.log('[WS] Browser disconnected');
      }
    });

    ws.on('error', (err) => {
      if (config.verbose) {
        console.log(`[WS] Error: ${err.message}`);
      }
    });

    // Send current ctrl state immediately so browser syncs
    const ctrl: CtrlMessage = { type: 'ctrl', left: state.lastCtrl[0], right: state.lastCtrl[1] };
    ws.send(JSON.stringify(ctrl));
  });

  /** Send a ctrl message to the connected browser */
  (wss as any).sendCtrl = (left: number, right: number) => {
    state.lastCtrl = [left, right];
    if (browserSocket && browserSocket.readyState === WebSocket.OPEN) {
      const msg: CtrlMessage = { type: 'ctrl', left, right };
      browserSocket.send(JSON.stringify(msg));
    }
  };

  /** Request pose from the browser */
  (wss as any).requestPose = () => {
    if (browserSocket && browserSocket.readyState === WebSocket.OPEN) {
      const msg: PoseRequestMessage = { type: 'pose_request' };
      browserSocket.send(JSON.stringify(msg));
    }
  };

  if (config.verbose) {
    console.log(`[WS] WebSocket server listening on port ${config.wsPort}`);
  }

  return wss;
}

// =============================================================================
// UDP Server — receives bytecodes from RoClaw stack
// =============================================================================

function startUdpServer(
  config: BridgeConfig,
  state: BridgeState,
  wss: WebSocketServer,
  target: GoalTarget,
): dgram.Socket {
  const socket = dgram.createSocket('udp4');

  socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const frameV2 = decodeFrameAuto(msg);
    if (!frameV2) {
      if (config.verbose) {
        console.log(`[UDP] Invalid frame from ${rinfo.address}:${rinfo.port}: ${formatHex(msg)}`);
      }
      return;
    }

    // Track last client for telemetry broadcast
    state.lastClientRinfo = rinfo;

    // Send ACK if requested (V2 protocol)
    if (frameV2.flags & ACK_FLAG) {
      const ackFrame = encodeFrameV2({
        opcode: ACK_OPCODE,
        paramLeft: 0,
        paramRight: 0,
        sequenceNumber: frameV2.sequenceNumber,
        flags: 0,
      });
      socket.send(ackFrame, rinfo.port, rinfo.address);
      if (config.verbose) {
        console.log(`[UDP] ACK sent for seq ${frameV2.sequenceNumber}`);
      }
    }

    // Extract V1 BytecodeFrame for bytecodeToCtrl (unchanged)
    const frame: BytecodeFrame = {
      opcode: frameV2.opcode,
      paramLeft: frameV2.paramLeft,
      paramRight: frameV2.paramRight,
    };
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

    // Handle GET_STATUS — request pose from browser, send JSON back
    if (frame.opcode === Opcode.GET_STATUS) {
      (wss as any).requestPose();
      // Small delay to let the browser respond, then send current pose
      setTimeout(() => {
        const status = JSON.stringify({
          pose: {
            x: Math.round(state.pose.x * 100) / 100,
            y: Math.round(state.pose.y * 100) / 100,
            h: Math.round(state.pose.h * 1000) / 1000,
          },
          run: state.lastCtrl[0] !== 0 || state.lastCtrl[1] !== 0,
          led: 0,
          cmds: state.commandCount,
          uptime: Date.now() - state.startTime,
          targetName: target.name,
          targetDistance: Math.round(state.targetDistance * 100) / 100,
          goalReached: state.goalReached,
        });
        socket.send(Buffer.from(status), rinfo.port, rinfo.address);
      }, 50);

      if (config.verbose) {
        console.log(`[UDP] ${opName} -> status response queued`);
      }
      return;
    }

    // Translate bytecode to MuJoCo ctrl values and send to browser
    const [left, right] = bytecodeToCtrl(frame);
    (wss as any).sendCtrl(left, right);

    if (config.verbose) {
      console.log(
        `[UDP] ${formatHex(msg)} -> ${opName}` +
        ` | ctrl=[${left.toFixed(3)}, ${right.toFixed(3)}]` +
        ` | ws=${state.wsConnected ? 'OK' : 'DISCONNECTED'}`
      );
    }
  });

  socket.on('error', (err) => {
    console.error(`[UDP] Socket error: ${err.message}`);
    socket.close();
  });

  socket.bind(config.udpPort, '0.0.0.0', () => {
    if (config.verbose) {
      console.log(`[UDP] Listening on port ${config.udpPort}`);
    }
  });

  return socket;
}

// =============================================================================
// MJPEG HTTP Server — serves camera frames to VisionLoop
// =============================================================================

function startCameraServer(
  config: BridgeConfig,
  latestJpeg: { data: Buffer },
): http.Server {
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
      const jpeg = latestJpeg.data;
      const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`;
      res.write(Buffer.concat([Buffer.from(header), jpeg, Buffer.from('\r\n')]));
    };

    sendFrame();
    const interval = setInterval(sendFrame, 1000 / config.fps);

    req.on('close', () => clearInterval(interval));
    res.on('error', () => clearInterval(interval));
  });

  server.listen(config.camPort, '0.0.0.0', () => {
    if (config.verbose) {
      console.log(`[CAM] MJPEG streaming on http://127.0.0.1:${config.camPort}/stream (${config.fps} FPS)`);
    }
  });

  return server;
}

// =============================================================================
// Telemetry Broadcast — push status + stall detection
// =============================================================================

const STALL_THRESHOLD_MS = 1000;
const STALL_POSITION_EPSILON = 0.005;

/**
 * Start periodic telemetry broadcast to the last known UDP client.
 * Includes stall detection: if velocity != 0 but pose unchanged for > 1s.
 */
export function startTelemetryBroadcast(
  socket: dgram.Socket,
  state: BridgeState,
  config: BridgeConfig,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (!state.lastClientRinfo) return;

    // Stall detection
    const moving = state.lastCtrl[0] !== 0 || state.lastCtrl[1] !== 0;
    const dx = Math.abs(state.pose.x - state.stallPose.x);
    const dy = Math.abs(state.pose.y - state.stallPose.y);
    const positionChanged = dx > STALL_POSITION_EPSILON || dy > STALL_POSITION_EPSILON;

    if (positionChanged) {
      state.stallPose = { x: state.pose.x, y: state.pose.y, ts: Date.now() };
      state.stall = false;
    } else if (moving && (Date.now() - state.stallPose.ts) > STALL_THRESHOLD_MS) {
      state.stall = true;
    } else if (!moving) {
      state.stall = false;
      state.stallPose.ts = Date.now();
    }

    const telemetry: TelemetryMessage = {
      telemetry: true,
      pose: {
        x: Math.round(state.pose.x * 1000) / 1000,
        y: Math.round(state.pose.y * 1000) / 1000,
        h: Math.round(state.pose.h * 1000) / 1000,
      },
      vel: {
        left: Math.round(state.lastCtrl[0] * 1000) / 1000,
        right: Math.round(state.lastCtrl[1] * 1000) / 1000,
      },
      stall: state.stall,
      ts: Date.now(),
    };

    const buf = Buffer.from(JSON.stringify(telemetry));
    socket.send(buf, state.lastClientRinfo.port, state.lastClientRinfo.address);
  }, 500);
}

// =============================================================================
// Terminal Dashboard
// =============================================================================

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function renderDashboard(state: BridgeState, config: BridgeConfig, target: GoalTarget): void {
  const uptime = Date.now() - state.startTime;
  const last = state.commandHistory[state.commandHistory.length - 1];
  const lastOpName = last ? (OPCODE_NAMES[last.opcode] || '???') : '---';
  const lastHex = last ? last.hex : '-- -- -- -- -- --';

  process.stdout.write('\x1B[2J\x1B[H');

  const wsStatus = state.wsConnected
    ? '\x1B[32mCONNECTED\x1B[0m'
    : '\x1B[31mWAITING\x1B[0m';

  const targetStatus = state.goalReached
    ? '\x1B[1;32mREACHED\x1B[0m'
    : `${state.targetDistance.toFixed(2)}m`;

  const lines = [
    '\x1B[1;35m===== RoClaw mjswan Bridge (3D Physics) =====\x1B[0m',
    '',
    `  \x1B[1mBrowser:\x1B[0m  ${wsStatus}   Frames: ${state.framesReceived}`,
    `  \x1B[1mCtrl:\x1B[0m     L=${state.lastCtrl[0].toFixed(3)} rad/s   R=${state.lastCtrl[1].toFixed(3)} rad/s`,
    `  \x1B[1mPose:\x1B[0m     x=${state.pose.x.toFixed(3)}  y=${state.pose.y.toFixed(3)}  h=${state.pose.h.toFixed(3)} rad`,
    `  \x1B[1mTarget:\x1B[0m   ${target.name}  Dist: ${targetStatus}`,
    '',
    `  \x1B[1mCommands:\x1B[0m ${state.commandCount}   \x1B[1mUptime:\x1B[0m ${formatUptime(uptime)}`,
    `  \x1B[1mLast:\x1B[0m    ${lastHex}  \x1B[36m${lastOpName}\x1B[0m`,
    '',
    '\x1B[90m' + '-'.repeat(48) + '\x1B[0m',
    `  UDP  :${config.udpPort}   CAM  :${config.camPort}   WS  :${config.wsPort}`,
    '\x1B[90m  Ctrl+C to stop\x1B[0m',
  ];

  console.log(lines.join('\n'));
}

// =============================================================================
// Boot
// =============================================================================

async function main(): Promise<void> {
  const { config, target } = parseArgs();

  const latestJpeg = { data: createMinimalJpeg() };

  const state: BridgeState = {
    commandHistory: [],
    commandCount: 0,
    startTime: Date.now(),
    wsConnected: false,
    framesReceived: 0,
    lastCtrl: [0, 0],
    pose: { x: 0, y: 0, h: 0 },
    targetDistance: Math.sqrt(target.x * target.x + target.y * target.y),
    goalReached: false,
    lastClientRinfo: null,
    stallPose: { x: 0, y: 0, ts: Date.now() },
    stall: false,
  };

  // Start servers
  const wss = startWebSocketServer(config, state, latestJpeg, target);
  const udpSocket = startUdpServer(config, state, wss, target);
  const camServer = startCameraServer(config, latestJpeg);

  // Telemetry broadcast: push pose + stall status to last known UDP client every 500ms
  const telemetryInterval = startTelemetryBroadcast(udpSocket, state, config);

  // Banner
  if (config.verbose) {
    console.log('');
    console.log('===== RoClaw mjswan Bridge (3D Physics) =====');
    console.log(`  UDP server    : 0.0.0.0:${config.udpPort}`);
    console.log(`  WebSocket     : ws://0.0.0.0:${config.wsPort}`);
    console.log(`  MJPEG server  : http://0.0.0.0:${config.camPort}/stream (${config.fps} FPS)`);
    console.log('');
    console.log('--- Copy to .env for localhost operation ---');
    console.log(`ESP32_S3_HOST=127.0.0.1`);
    console.log(`ESP32_S3_PORT=${config.udpPort}`);
    console.log(`ESP32_CAM_HOST=127.0.0.1`);
    console.log(`ESP32_CAM_PORT=${config.camPort}`);
    console.log('-------------------------------------------');
    console.log('');
    console.log('Open browser: http://localhost:8000?bridge=ws://localhost:' + config.wsPort);
    console.log('Waiting for connections...');
  } else {
    console.log('');
    console.log('--- Copy to .env for localhost operation ---');
    console.log(`ESP32_S3_HOST=127.0.0.1`);
    console.log(`ESP32_S3_PORT=${config.udpPort}`);
    console.log(`ESP32_CAM_HOST=127.0.0.1`);
    console.log(`ESP32_CAM_PORT=${config.camPort}`);
    console.log('-------------------------------------------');
    console.log('');
  }

  // Dashboard loop
  let dashboardInterval: ReturnType<typeof setInterval> | undefined;
  if (!config.verbose) {
    await new Promise(r => setTimeout(r, 1500));
    dashboardInterval = setInterval(() => renderDashboard(state, config, target), 500);
  }

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(telemetryInterval);
    if (dashboardInterval) clearInterval(dashboardInterval);

    if (!config.verbose) {
      process.stdout.write('\x1B[2J\x1B[H');
    }
    console.log('\nShutting down mjswan bridge...');

    udpSocket.close();
    camServer.close();
    wss.close();

    console.log(`Session: ${state.commandCount} commands, ${state.framesReceived} frames, uptime ${formatUptime(Date.now() - state.startTime)}`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only start servers when run directly (not when imported for testing)
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
