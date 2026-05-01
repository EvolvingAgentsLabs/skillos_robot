/**
 * RoClaw Cortex — OpenClaw Gateway Node
 *
 * Connects to the OpenClaw Gateway as a hardware node.
 * Receives high-level tool invocations and translates them
 * into Cerebellum goals for real-time motor control.
 */

import WebSocket from 'ws';
import { logger } from '../../shared/logger';
import { handleTool, TOOL_DEFINITIONS, type ToolContext } from './roclaw_tools';

// =============================================================================
// Types
// =============================================================================

export interface CortexConfig {
  /** OpenClaw Gateway WebSocket URL */
  gatewayUrl: string;
  /** Node identifier */
  nodeId: string;
  /** Reconnect delay in ms (default: 3000) */
  reconnectDelayMs: number;
}

interface GatewayMessage {
  type: string;
  id?: string;
  tool?: string;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

const DEFAULT_CONFIG: CortexConfig = {
  gatewayUrl: 'ws://localhost:8080',
  nodeId: 'roclaw-v1',
  reconnectDelayMs: 3000,
};

// =============================================================================
// CortexNode
// =============================================================================

export class CortexNode {
  private config: CortexConfig;
  private toolContext: ToolContext;
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    config: Partial<CortexConfig>,
    toolContext: ToolContext,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.toolContext = toolContext;
  }

  /**
   * Connect to the OpenClaw Gateway.
   */
  async connect(): Promise<void> {
    this.running = true;
    return this.establishConnection();
  }

  /**
   * Disconnect from the gateway.
   */
  disconnect(): void {
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private establishConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.info('Cortex', `Connecting to ${this.config.gatewayUrl}`);

      this.ws = new WebSocket(this.config.gatewayUrl);

      this.ws.on('open', () => {
        logger.info('Cortex', 'Connected to OpenClaw Gateway');

        // Register as a hardware node
        this.send({
          type: 'register',
          nodeId: this.config.nodeId,
          capabilities: TOOL_DEFINITIONS.map(t => t.name),
          metadata: {
            type: 'robot',
            hardware: 'RoClaw V1',
            description: '20cm cube robot with camera and differential drive',
          },
        });

        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', () => {
        logger.warn('Cortex', 'Gateway connection closed');
        this.ws = null;
        this.scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        logger.error('Cortex', 'WebSocket error', { error: err.message });
        if (!this.isConnected()) {
          reject(err);
        }
      });
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: GatewayMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      logger.warn('Cortex', 'Invalid JSON from gateway');
      return;
    }

    if (msg.type === 'invoke' && msg.tool) {
      logger.info('Cortex', `Tool invocation: ${msg.tool}`, msg.args);

      const result = await handleTool(
        msg.tool,
        msg.args ?? {},
        this.toolContext,
      );

      // Send result back to gateway
      this.send({
        type: 'result',
        id: msg.id,
        ...result,
      });
    } else if (msg.type === 'ping') {
      this.send({ type: 'pong' });
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    this.reconnectTimer = setTimeout(() => {
      if (this.running) {
        this.establishConnection().catch((err) => {
          logger.error('Cortex', 'Reconnection failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          this.scheduleReconnect();
        });
      }
    }, this.config.reconnectDelayMs);
  }
}
