/**
 * RoClaw UDP Transmitter — Raw bytecode sender to ESP32-S3
 *
 * Sends 6-byte binary frames via UDP. No JSON. No serialization.
 * Just raw bytes to the spinal cord.
 */

import * as dgram from 'dgram';
import { logger } from '../shared/logger';
import {
  formatHex, FRAME_SIZE, FRAME_SIZE_V2, ACK_FLAG, ACK_OPCODE,
  encodeFrameV2, decodeFrameV2,
  type BytecodeFrameV2,
} from './bytecode_compiler';

// =============================================================================
// Types
// =============================================================================

export interface TransmitterConfig {
  /** ESP32-S3 IP address */
  host: string;
  /** UDP port (default: 4210) */
  port: number;
  /** Send timeout in ms (default: 500) */
  timeoutMs: number;
  /** Max retries on failure (default: 1) */
  maxRetries: number;
  /** Enable V2 protocol (8-byte frames with sequence numbers) */
  useV2Protocol?: boolean;
  /** Timeout in ms waiting for ACK response (default: 200) */
  ackTimeoutMs?: number;
}

export interface TransmitterStats {
  framesSent: number;
  bytesTransmitted: number;
  errors: number;
  retries: number;
  droppedFrames: number;
  currentSequence: number;
  connected: boolean;
  averageLatencyMs: number;
}

const DEFAULT_CONFIG: TransmitterConfig = {
  host: '192.168.1.100',
  port: 4210,
  timeoutMs: 500,
  maxRetries: 1,
};

// =============================================================================
// UDPTransmitter
// =============================================================================

export class UDPTransmitter {
  private config: TransmitterConfig;
  private socket: dgram.Socket | null = null;
  private connected = false;
  private latencies: number[] = [];
  private sequenceNumber = 0;
  private droppedFrames = 0;
  private stats = {
    framesSent: 0,
    bytesTransmitted: 0,
    errors: 0,
    retries: 0,
  };

  constructor(config: Partial<TransmitterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Open the UDP socket.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err: Error) => {
        logger.error('UDP', 'Socket error', { error: err.message });
        if (!this.connected) {
          reject(err);
        }
      });

      this.socket.bind(() => {
        this.connected = true;
        logger.info('UDP', `Connected → ${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Close the UDP socket.
   */
  async disconnect(): Promise<void> {
    if (!this.connected || !this.socket) return;

    return new Promise((resolve) => {
      this.socket!.close(() => {
        this.socket = null;
        this.connected = false;
        logger.info('UDP', 'Disconnected');
        resolve();
      });
    });
  }

  /**
   * Send a raw bytecode frame (6 bytes) to the ESP32-S3.
   */
  async send(frame: Buffer): Promise<void> {
    if (!this.connected || !this.socket) {
      throw new Error('UDP transmitter not connected');
    }

    if (frame.length !== FRAME_SIZE && frame.length !== FRAME_SIZE_V2) {
      throw new Error(`Invalid frame size: ${frame.length}, expected ${FRAME_SIZE} or ${FRAME_SIZE_V2}`);
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const start = performance.now();
        await this.sendRaw(frame);
        const latency = performance.now() - start;

        this.sequenceNumber++;
        this.stats.framesSent++;
        this.stats.bytesTransmitted += frame.length;
        this.latencies.push(latency);
        if (this.latencies.length > 100) this.latencies.shift();

        logger.debug('UDP', `Sent ${formatHex(frame)} (${latency.toFixed(1)}ms)`);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.config.maxRetries) {
          this.stats.retries++;
        }
      }
    }

    this.stats.errors++;
    throw lastError ?? new Error('UDP send failed');
  }

  /**
   * Send a frame and wait for a response (for status queries).
   */
  async sendAndReceive(frame: Buffer, timeoutMs?: number): Promise<Buffer> {
    if (!this.connected || !this.socket) {
      throw new Error('UDP transmitter not connected');
    }

    const timeout = timeoutMs ?? this.config.timeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket?.removeListener('message', onMessage);
        this.droppedFrames++;
        reject(new Error('Response timeout'));
      }, timeout);

      const onMessage = (msg: Buffer) => {
        clearTimeout(timer);
        this.socket?.removeListener('message', onMessage);
        resolve(msg);
      };

      this.socket!.on('message', onMessage);

      this.sendRaw(frame).catch((err) => {
        clearTimeout(timer);
        this.socket?.removeListener('message', onMessage);
        reject(err);
      });
    });
  }

  /**
   * Send a V2 frame with ACK_FLAG set and wait for an ACK response
   * matching the sequence number.
   */
  async sendWithAck(frame: BytecodeFrameV2): Promise<void> {
    if (!this.connected || !this.socket) {
      throw new Error('UDP transmitter not connected');
    }

    const ackFrame: BytecodeFrameV2 = {
      ...frame,
      flags: frame.flags | ACK_FLAG,
    };
    const encoded = encodeFrameV2(ackFrame);
    const timeout = this.config.ackTimeoutMs ?? 200;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket?.removeListener('message', onMessage);
        this.droppedFrames++;
        reject(new Error('ACK timeout'));
      }, timeout);

      const onMessage = (msg: Buffer) => {
        const decoded = decodeFrameV2(msg);
        if (decoded && decoded.opcode === ACK_OPCODE && decoded.sequenceNumber === ackFrame.sequenceNumber) {
          clearTimeout(timer);
          this.socket?.removeListener('message', onMessage);
          this.stats.framesSent++;
          this.stats.bytesTransmitted += encoded.length;
          this.sequenceNumber++;
          resolve();
        }
      };

      this.socket!.on('message', onMessage);

      this.sendRaw(encoded).catch((err) => {
        clearTimeout(timer);
        this.socket?.removeListener('message', onMessage);
        this.stats.errors++;
        reject(err);
      });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStats(): TransmitterStats {
    const avgLatency = this.latencies.length > 0
      ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
      : 0;

    return {
      ...this.stats,
      droppedFrames: this.droppedFrames,
      currentSequence: this.sequenceNumber,
      connected: this.connected,
      averageLatencyMs: Math.round(avgLatency * 100) / 100,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private sendRaw(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket!.send(data, this.config.port, this.config.host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
