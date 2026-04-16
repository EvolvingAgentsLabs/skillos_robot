/**
 * RoClaw Vision Loop — The Cerebellum's main reactive cycle
 *
 * Pulls MJPEG frames from ESP32-CAM, feeds them to Qwen-VL,
 * compiles the output to bytecode, and transmits to ESP32-S3.
 *
 * Cycle: capture → infer → compile → transmit → repeat
 */

import { EventEmitter } from 'events';
import * as http from 'http';
import { logger } from '../shared/logger';
import { BytecodeCompiler, Opcode, encodeFrame, decodeFrame, formatHex } from './bytecode_compiler';
import { UDPTransmitter } from './udp_transmitter';
import { appendTrace, traceLogger } from '../3_llmunix_memory/trace_logger';
import { HierarchyLevel, TraceOutcome, TraceSource } from '../3_llmunix_memory/trace_types';
import type { InferenceFunction } from '../llmunix-core/interfaces';
import type { PerceptionPolicy, TelemetrySnapshot } from './perception_policy';
import { VLMMotorPolicy } from './vlm_motor_policy';

// =============================================================================
// Types
// =============================================================================

export interface VisionLoopConfig {
  /** ESP32-CAM stream URL (e.g., http://192.168.1.101/stream) */
  cameraUrl: string;
  /** Target inference FPS (default: 2 — VLM inference is slow) */
  targetFPS: number;
  /** Connection timeout in ms (default: 5000) */
  connectTimeoutMs: number;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect: boolean;
  /** Reconnect delay in ms (default: 2000) */
  reconnectDelayMs: number;
  /** Number of recent frames to send for temporal context (default: 4) */
  frameHistorySize: number;
  /** Use tool-calling system prompt instead of hex bytecode prompt (for Gemini with function calling) */
  useToolCallingPrompt?: boolean;
  /** ms to wait after STOP before inference (default: 100). Set to 0 to skip settle delay. */
  stopSettleMs?: number;
  /** Skip STOP-before-inference entirely — let the previous command keep running while VLM thinks.
   *  Useful when inference is slow (2s+) and stopping between every frame prevents movement.
   *  The heartbeat keeps ESP32 alive, and frame history captures motion for temporal context. */
  coastDuringInference?: boolean;
}

export interface VisionLoopStats {
  framesReceived: number;
  framesProcessed: number;
  inferenceCount: number;
  bytecodesSent: number;
  errors: number;
  fps: number;
  connected: boolean;
}

export interface TimestampedFrame {
  base64Data: string;
  timestamp: number;
}

const DEFAULT_CONFIG: VisionLoopConfig = {
  cameraUrl: '',
  targetFPS: 2,
  connectTimeoutMs: 5000,
  autoReconnect: true,
  reconnectDelayMs: 2000,
  frameHistorySize: 4,
};

// =============================================================================
// VisionLoop
// =============================================================================

export class VisionLoop extends EventEmitter {
  private config: VisionLoopConfig;
  private compiler: BytecodeCompiler;
  private transmitter: UDPTransmitter;
  private infer: InferenceFunction;
  private currentGoal: string = 'explore and avoid obstacles';

  private running = false;
  private request: http.ClientRequest | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private processingFrame = false;
  private latestFrameBase64: string = '';
  private frameHistory: TimestampedFrame[] = [];

  // Hierarchical architecture extensions
  private activeTraceId: string | null = null;
  private activeConstraints: string[] = [];

  // Telemetry injection: provides real-time pose/heading/target data for VLM prompt
  private telemetryProvider: (() => { pose: { x: number; y: number; h: number }; targetDist?: number; targetBearing?: number } | null) | null = null;

  // PerceptionPolicy: strategy pattern for frame processing (PR-3)
  private policy: PerceptionPolicy;

  // Stuck detection + step timeout
  private recentOpcodes: number[] = [];
  private static readonly STUCK_WINDOW = 12;
  private static readonly STUCK_ENTROPY_THRESHOLD = 0.5; // Below this = stuck (max entropy for 2 opcodes ≈ 1.0)
  private static readonly STEP_TIMEOUT_MS = 45000;
  private stepStartTime = 0;

  // REACTIVE trace generation
  private reactiveTraceId: string | null = null;
  private reactiveBytecodesCount = 0;
  private static readonly REACTIVE_TRACE_WINDOW = 10;

  // Heartbeat: keeps ESP32 alive during slow VLM inference (5-30s)
  // Must be well under the 2000ms firmware timeout to account for network jitter
  private static readonly HEARTBEAT_INTERVAL_MS = 1000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // MJPEG parsing state
  private buffer = Buffer.alloc(0);
  private boundary = '';
  private minFrameIntervalMs: number;
  private lastFrameTime = 0;

  // Stats
  private statsData = {
    framesReceived: 0,
    framesProcessed: 0,
    inferenceCount: 0,
    bytecodesSent: 0,
    errors: 0,
    startTime: 0,
  };

  constructor(
    config: Partial<VisionLoopConfig> & { cameraUrl: string },
    compiler: BytecodeCompiler,
    transmitter: UDPTransmitter,
    infer: InferenceFunction,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.compiler = compiler;
    this.transmitter = transmitter;
    this.infer = infer;
    this.minFrameIntervalMs = 1000 / (this.config.targetFPS || 2);

    // Default policy: VLMMotorPolicy (preserves original behavior)
    this.policy = new VLMMotorPolicy(compiler, infer, {
      useToolCallingPrompt: !!this.config.useToolCallingPrompt,
    });

    // Prompt-mode alignment validation (Constraint 10):
    // When useToolCallingPrompt is set, the inference backend MUST support tool calling.
    // We can't inspect the opaque InferenceFunction, but we log a clear reminder.
    if (this.config.useToolCallingPrompt) {
      logger.info('VisionLoop', 'Tool-calling prompt mode enabled — ensure inference backend has useToolCalling: true');
    }
  }

  /**
   * Start the vision loop.
   */
  async start(goal?: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.statsData.startTime = Date.now();
    this.stepStartTime = Date.now();
    this.recentOpcodes = [];

    if (goal) {
      this.currentGoal = goal;
    }

    logger.info('VisionLoop', `Starting — goal: "${this.currentGoal}"`);
    return this.connectToStream();
  }

  /**
   * Stop the vision loop.
   */
  stop(): void {
    this.running = false;
    this.stopInferenceHeartbeat();
    this.closeReactiveTrace(TraceOutcome.UNKNOWN, 'VisionLoop stopped');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.request) {
      this.request.destroy();
      this.request = null;
    }

    this.buffer = Buffer.alloc(0);
    this.flushFrameHistory();
    logger.info('VisionLoop', 'Stopped');
  }

  /**
   * Externally confirm arrival (e.g. from physics-based proximity detection).
   * Closes any open reactive trace as SUCCESS, emits 'arrival', and stops the loop.
   */
  confirmArrival(reason: string): void {
    logger.info('VisionLoop', `Arrival confirmed: ${reason}`);
    this.closeReactiveTrace(TraceOutcome.SUCCESS, reason);
    this.emit('arrival', reason);
    this.stop();
  }

  /**
   * Update the current goal.
   */
  setGoal(goal: string): void {
    this.currentGoal = goal;
    logger.info('VisionLoop', `Goal updated: "${goal}"`);
  }

  /**
   * Set the active trace ID for hierarchical logging.
   * When set, bytecodes are logged via traceLogger.appendBytecode() instead of appendTrace().
   */
  setActiveTraceId(traceId: string | null): void {
    this.activeTraceId = traceId;
  }

  getActiveTraceId(): string | null {
    return this.activeTraceId;
  }

  /**
   * Set active constraints that are appended to the system prompt.
   */
  setConstraints(constraints: string[]): void {
    this.activeConstraints = constraints;
  }

  getConstraints(): string[] {
    return [...this.activeConstraints];
  }

  /**
   * Set a telemetry provider that returns current pose + target info.
   * Called every frame to inject sensor data into VLM prompt.
   */
  setTelemetryProvider(provider: (() => { pose: { x: number; y: number; h: number }; targetDist?: number; targetBearing?: number } | null) | null): void {
    this.telemetryProvider = provider;
  }

  /**
   * Replace the active perception policy. Swaps between VLMMotorPolicy (default)
   * and SceneGraphPolicy (opt-in via RF_POLICY=scene_graph).
   */
  setPolicy(policy: PerceptionPolicy): void {
    this.policy = policy;
  }

  /** Reset step timer — called when NavigationSession advances to a new step. */
  resetStepTimer(): void {
    this.stepStartTime = Date.now();
    this.recentOpcodes = [];
  }

  /**
   * Process a single frame manually (for testing or single-shot mode).
   */
  async processSingleFrame(frameBase64: string, history?: string[]): Promise<Buffer | null> {
    const systemPrompt = this.config.useToolCallingPrompt
      ? this.compiler.getToolCallingSystemPrompt(this.currentGoal)
      : this.compiler.getSystemPrompt(this.currentGoal);
    const frames = history ?? [frameBase64];
    const userMessage = frames.length > 1
      ? this.config.useToolCallingPrompt
        ? `This is a video of the last ${frames.length} frames of movement (oldest→newest). The goal is: ${this.currentGoal}. Analyze what you see and call the appropriate motor control function.`
        : `This is a video of the last ${frames.length} frames of movement (oldest→newest). The goal is: ${this.currentGoal}. Use the visual differences between frames to gauge your velocity and 3D surroundings. Output the next 6-byte motor command.`
      : this.config.useToolCallingPrompt
        ? `What do you see? Call the appropriate motor control function for the goal: ${this.currentGoal}`
        : 'What do you see? Output the next motor command.';

    await this.stopAndSettle();
    this.startInferenceHeartbeat();
    try {
      const vlmOutput = await this.infer(systemPrompt, userMessage, frames);
      this.statsData.inferenceCount++;

      const bytecode = this.compiler.compile(vlmOutput);
      if (!bytecode) return null;

      await this.transmitter.send(bytecode);
      this.statsData.bytecodesSent++;

      const decoded = decodeFrame(bytecode);
      if (decoded && decoded.opcode === Opcode.STOP) {
        this.emit('arrival', vlmOutput);
      }

      // Stuck detection: low entropy over recent opcode window (catches identical + oscillation)
      if (decoded) {
        this.recentOpcodes.push(decoded.opcode);
        if (this.recentOpcodes.length > VisionLoop.STUCK_WINDOW) {
          this.recentOpcodes.shift();
        }
        if (decoded.opcode !== Opcode.STOP && this.computeOpcodeEntropy() < VisionLoop.STUCK_ENTROPY_THRESHOLD) {
          this.emit('stuck', vlmOutput);
          this.recentOpcodes = [];
        }
      }

      // Step timeout: no arrival for too long
      if (this.stepStartTime > 0 && decoded?.opcode !== Opcode.STOP) {
        const elapsed = Date.now() - this.stepStartTime;
        if (elapsed > VisionLoop.STEP_TIMEOUT_MS) {
          this.emit('stepTimeout', elapsed);
          this.stepStartTime = Date.now();
        }
      }

      return bytecode;
    } catch (error) {
      this.statsData.errors++;
      logger.error('VisionLoop', 'Single frame processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      this.stopInferenceHeartbeat();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getGoal(): string {
    return this.currentGoal;
  }

  /**
   * Get the latest captured frame as a base64 string.
   * Returns empty string if no frame has been captured yet.
   */
  getLatestFrameBase64(): string {
    return this.latestFrameBase64;
  }

  /**
   * Get the current frame history buffer (oldest first).
   * Returns base64 strings for backward compatibility.
   */
  getFrameHistory(): string[] {
    return this.frameHistory.map(f => f.base64Data);
  }

  /**
   * Flush the frame history buffer. Call after emergency stop
   * to discard stale frames.
   */
  flushFrameHistory(): void {
    this.frameHistory = [];
    logger.info('VisionLoop', 'Frame history flushed');
  }

  /**
   * Start sending GET_STATUS heartbeat frames during VLM inference
   * to prevent the ESP32 firmware timeout (2s) from triggering emergency stop.
   */
  private startInferenceHeartbeat(): void {
    this.stopInferenceHeartbeat();
    const statusFrame = encodeFrame({ opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 });
    this.heartbeatTimer = setInterval(() => {
      this.transmitter.send(statusFrame).catch((err) => {
        logger.warn('VisionLoop', 'Heartbeat send failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, VisionLoop.HEARTBEAT_INTERVAL_MS);
  }

  private stopInferenceHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send a STOP frame and wait for the robot to settle before VLM inference.
   * This prevents "coasting blind" — motors running while VLM thinks (5-30s).
   */
  private async stopAndSettle(): Promise<void> {
    try {
      const stopFrame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
      await this.transmitter.send(stopFrame);
    } catch (err) {
      logger.warn('VisionLoop', 'STOP-before-inference failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const settleMs = this.config.stopSettleMs ?? 100;
    if (settleMs > 0) {
      await new Promise(resolve => setTimeout(resolve, settleMs));
    }
  }

  getStats(): VisionLoopStats {
    const elapsed = (Date.now() - this.statsData.startTime) / 1000;

    return {
      framesReceived: this.statsData.framesReceived,
      framesProcessed: this.statsData.framesProcessed,
      inferenceCount: this.statsData.inferenceCount,
      bytecodesSent: this.statsData.bytecodesSent,
      errors: this.statsData.errors,
      fps: elapsed > 0 ? this.statsData.framesProcessed / elapsed : 0,
      connected: this.request !== null && this.running,
    };
  }

  // ===========================================================================
  // Private — MJPEG streaming
  // ===========================================================================

  private connectToStream(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = new URL(this.config.cameraUrl);

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'GET',
        timeout: this.config.connectTimeoutMs,
      };

      this.request = http.request(options, (res) => {
        if (res.statusCode !== 200) {
          const err = new Error(`HTTP ${res.statusCode}`);
          this.statsData.errors++;
          if (!this.running) reject(err);
          return;
        }

        // Extract boundary
        const contentType = res.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)/i);
        this.boundary = boundaryMatch ? boundaryMatch[1].trim() : 'frame';

        logger.info('VisionLoop', 'Connected to camera stream');
        this.emit('connected');
        resolve();

        res.on('data', (chunk: Buffer) => {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          this.parseFrames();
        });

        res.on('end', () => this.handleDisconnect());
        res.on('error', (err: Error) => {
          this.statsData.errors++;
          this.handleDisconnect();
        });
      });

      this.request.on('error', (err: Error) => {
        this.statsData.errors++;
        if (this.running) {
          this.handleDisconnect();
        } else {
          reject(err);
        }
      });

      this.request.on('timeout', () => {
        this.request?.destroy();
        this.statsData.errors++;
        if (!this.running) reject(new Error('Connection timeout'));
        else this.handleDisconnect();
      });

      this.request.end();
    });
  }

  private parseFrames(): void {
    const boundaryMarker = `--${this.boundary}`;
    const boundaryBuf = Buffer.from(boundaryMarker);
    const headerEnd = Buffer.from('\r\n\r\n');

    while (true) {
      const boundaryIdx = this.buffer.indexOf(boundaryBuf);
      if (boundaryIdx === -1) break;

      const headerStart = boundaryIdx + boundaryBuf.length;
      const headerEndIdx = this.buffer.indexOf(headerEnd, headerStart);
      if (headerEndIdx === -1) break;

      const headerStr = this.buffer.slice(headerStart, headerEndIdx).toString();
      let contentLength = -1;
      const clMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (clMatch) {
        contentLength = parseInt(clMatch[1], 10);
      }

      const dataStart = headerEndIdx + headerEnd.length;

      if (contentLength > 0) {
        if (this.buffer.length < dataStart + contentLength) break;

        const frameData = this.buffer.slice(dataStart, dataStart + contentLength);
        this.handleFrame(frameData);
        this.buffer = this.buffer.slice(dataStart + contentLength);
      } else {
        const nextBoundary = this.buffer.indexOf(boundaryBuf, dataStart);
        if (nextBoundary === -1) break;

        let frameEnd = nextBoundary;
        if (frameEnd >= 2 && this.buffer[frameEnd - 2] === 0x0d && this.buffer[frameEnd - 1] === 0x0a) {
          frameEnd -= 2;
        }

        const frameData = this.buffer.slice(dataStart, frameEnd);
        this.handleFrame(frameData);
        this.buffer = this.buffer.slice(nextBoundary);
      }
    }

    // Prevent unbounded buffer growth
    if (this.buffer.length > 500 * 1024) {
      this.buffer = this.buffer.slice(this.buffer.length - 100 * 1024);
    }
  }

  private handleFrame(data: Buffer): void {
    // Validate JPEG: starts with FFD8
    if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) {
      return;
    }

    // Rate limiting
    const now = Date.now();
    if (now - this.lastFrameTime < this.minFrameIntervalMs) {
      return;
    }
    this.lastFrameTime = now;

    this.statsData.framesReceived++;
    this.latestFrameBase64 = data.toString('base64');

    // Maintain frame history ring buffer with timestamps
    this.frameHistory.push({ base64Data: this.latestFrameBase64, timestamp: Date.now() });
    if (this.frameHistory.length > this.config.frameHistorySize) {
      this.frameHistory.shift();
    }

    // Don't queue frames if we're still processing the previous one
    if (this.processingFrame) return;

    this.processFrame(data).catch((err) => {
      this.statsData.errors++;
      logger.error('VisionLoop', 'Frame processing error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async processFrame(jpegData: Buffer): Promise<void> {
    this.processingFrame = true;
    if (!this.config.coastDuringInference) {
      await this.stopAndSettle();
    }
    this.startInferenceHeartbeat();

    try {
      const frameCount = this.frameHistory.length;
      const frameBase64s = this.frameHistory.map(f => f.base64Data);

      // Log frame age for diagnostics
      if (frameCount > 0) {
        const oldestAge = Date.now() - this.frameHistory[0].timestamp;
        const newestAge = Date.now() - this.frameHistory[frameCount - 1].timestamp;
        logger.debug('VisionLoop', `Frame buffer: ${frameCount} frames, age ${oldestAge}ms→${newestAge}ms`);
      }

      // Build telemetry snapshot from provider
      const telemetry: TelemetrySnapshot | null = this.telemetryProvider
        ? this.telemetryProvider() ?? null
        : null;

      // Delegate to the active perception policy
      const result = await this.policy.processFrame(
        frameBase64s,
        this.currentGoal,
        telemetry,
        this.activeConstraints,
      );
      this.statsData.inferenceCount++;

      const { bytecode, vlmOutput } = result;
      if (bytecode) {
        await this.transmitter.send(bytecode);
        this.statsData.bytecodesSent++;
        this.statsData.framesProcessed++;

        this.emit('bytecode', bytecode, vlmOutput);

        const decoded = decodeFrame(bytecode);
        if (decoded && decoded.opcode === Opcode.STOP) {
          // Close any open reactive trace as SUCCESS on arrival
          this.closeReactiveTrace(TraceOutcome.SUCCESS, 'Arrival detected');
          this.emit('arrival', vlmOutput);
        }

        logger.debug('VisionLoop', `Frame → ${formatHex(bytecode)}`);

        // Hierarchical logging: use traceLogger if activeTraceId is set
        if (this.activeTraceId) {
          traceLogger.appendBytecode(this.activeTraceId, vlmOutput, bytecode);

          // REACTIVE trace generation: wrap every N bytecodes in a Level 4 trace
          if (!this.reactiveTraceId) {
            this.reactiveTraceId = traceLogger.startTrace(
              HierarchyLevel.REACTIVE,
              `Motor sequence: ${this.currentGoal}`,
              { parentTraceId: this.activeTraceId, source: TraceSource.REAL_WORLD },
            );
            this.reactiveBytecodesCount = 0;
          }
          traceLogger.appendBytecode(this.reactiveTraceId, vlmOutput, bytecode);
          this.reactiveBytecodesCount++;

          if (this.reactiveBytecodesCount >= VisionLoop.REACTIVE_TRACE_WINDOW) {
            traceLogger.endTrace(this.reactiveTraceId, TraceOutcome.UNKNOWN, 'Window complete');
            this.reactiveTraceId = null;
          }
        } else {
          appendTrace(this.currentGoal, vlmOutput, bytecode);
        }

        // Stuck detection: low entropy over recent opcode window (catches identical + oscillation)
        if (decoded) {
          this.recentOpcodes.push(decoded.opcode);
          if (this.recentOpcodes.length > VisionLoop.STUCK_WINDOW) {
            this.recentOpcodes.shift();
          }
          if (decoded.opcode !== Opcode.STOP && this.computeOpcodeEntropy() < VisionLoop.STUCK_ENTROPY_THRESHOLD) {
            this.closeReactiveTrace(TraceOutcome.FAILURE, 'Stuck: low entropy motor pattern');
            this.emit('stuck', vlmOutput);
            this.recentOpcodes = [];
          }
        }

        // Step timeout: no arrival for too long
        if (this.stepStartTime > 0 && decoded?.opcode !== Opcode.STOP) {
          const elapsed = Date.now() - this.stepStartTime;
          if (elapsed > VisionLoop.STEP_TIMEOUT_MS) {
            this.closeReactiveTrace(TraceOutcome.FAILURE, 'Step timeout');
            this.emit('stepTimeout', elapsed);
            this.stepStartTime = Date.now(); // reset to avoid spam
          }
        }
      }
    } finally {
      this.stopInferenceHeartbeat();
      this.processingFrame = false;
    }
  }

  /**
   * Compute Shannon entropy of the recent opcode window.
   * Returns 0 for all-identical, higher values for more varied sequences.
   * Catches both stuck (all same) and oscillation (e.g. LEFT/RIGHT repeating).
   */
  private computeOpcodeEntropy(): number {
    if (this.recentOpcodes.length < VisionLoop.STUCK_WINDOW) return Infinity;
    const counts = new Map<number, number>();
    for (const op of this.recentOpcodes) {
      counts.set(op, (counts.get(op) ?? 0) + 1);
    }
    let entropy = 0;
    const n = this.recentOpcodes.length;
    for (const count of counts.values()) {
      const p = count / n;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  private closeReactiveTrace(outcome: TraceOutcome, reason: string): void {
    if (this.reactiveTraceId) {
      traceLogger.endTrace(this.reactiveTraceId, outcome, reason);
      this.reactiveTraceId = null;
      this.reactiveBytecodesCount = 0;
    }
  }

  private handleDisconnect(): void {
    this.request = null;

    if (this.running && this.config.autoReconnect) {
      logger.warn('VisionLoop', 'Disconnected, reconnecting...');
      this.emit('reconnecting');

      this.reconnectTimer = setTimeout(() => {
        if (this.running) {
          this.connectToStream().catch((err) => {
            this.handleDisconnect();
          });
        }
      }, this.config.reconnectDelayMs);
    }
  }
}
