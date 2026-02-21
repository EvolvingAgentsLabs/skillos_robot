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
import { BytecodeCompiler, formatHex } from './bytecode_compiler';
import { UDPTransmitter } from './udp_transmitter';
import { appendTrace } from '../3_llmunix_memory/trace_logger';
import type { InferenceFunction } from './inference';

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

const DEFAULT_CONFIG: VisionLoopConfig = {
  cameraUrl: '',
  targetFPS: 2,
  connectTimeoutMs: 5000,
  autoReconnect: true,
  reconnectDelayMs: 2000,
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
  }

  /**
   * Start the vision loop.
   */
  async start(goal?: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.statsData.startTime = Date.now();

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

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.request) {
      this.request.destroy();
      this.request = null;
    }

    this.buffer = Buffer.alloc(0);
    logger.info('VisionLoop', 'Stopped');
  }

  /**
   * Update the current goal.
   */
  setGoal(goal: string): void {
    this.currentGoal = goal;
    logger.info('VisionLoop', `Goal updated: "${goal}"`);
  }

  /**
   * Process a single frame manually (for testing or single-shot mode).
   */
  async processSingleFrame(frameBase64: string): Promise<Buffer | null> {
    const systemPrompt = this.compiler.getSystemPrompt(this.currentGoal);
    const userMessage = 'What do you see? Output the next motor command.';

    try {
      const vlmOutput = await this.infer(systemPrompt, userMessage, [frameBase64]);
      this.statsData.inferenceCount++;

      const bytecode = this.compiler.compile(vlmOutput);
      if (!bytecode) return null;

      await this.transmitter.send(bytecode);
      this.statsData.bytecodesSent++;

      return bytecode;
    } catch (error) {
      this.statsData.errors++;
      logger.error('VisionLoop', 'Single frame processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
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

    try {
      const frameBase64 = jpegData.toString('base64');
      const systemPrompt = this.compiler.getSystemPrompt(this.currentGoal);
      const userMessage = 'What do you see? Output the next motor command.';

      const vlmOutput = await this.infer(systemPrompt, userMessage, [frameBase64]);
      this.statsData.inferenceCount++;

      const bytecode = this.compiler.compile(vlmOutput);
      if (bytecode) {
        await this.transmitter.send(bytecode);
        this.statsData.bytecodesSent++;
        this.statsData.framesProcessed++;

        this.emit('bytecode', bytecode, vlmOutput);
        logger.debug('VisionLoop', `Frame → ${formatHex(bytecode)}`);
        appendTrace(this.currentGoal, vlmOutput, bytecode);
      }
    } finally {
      this.processingFrame = false;
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
