/**
 * TelemetryMonitor — Parses telemetry push messages from the bridge,
 * detects stall events, and provides accessors for latest status.
 *
 * Differentiates telemetry JSON from bytecode frames (0xAA prefix).
 */

import { EventEmitter } from 'events';
import type { TelemetryMessage } from '../mjswan_bridge';

// =============================================================================
// Types
// =============================================================================

export interface TelemetryData {
  pose: { x: number; y: number; h: number };
  vel: { left: number; right: number };
  stall: boolean;
  ts: number;
}

// =============================================================================
// TelemetryMonitor
// =============================================================================

export class TelemetryMonitor extends EventEmitter {
  private lastTelemetry: TelemetryData | null = null;
  private wasStalled = false;

  /**
   * Process an incoming UDP message.
   * Returns true if it was a telemetry message (not bytecode).
   */
  processMessage(msg: Buffer): boolean {
    // Bytecode frames start with 0xAA — not telemetry
    if (msg.length > 0 && msg[0] === 0xAA) {
      return false;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(msg.toString());
    } catch {
      return false;
    }

    // Must have telemetry: true marker
    if (!parsed || parsed.telemetry !== true) {
      return false;
    }

    // Validate required fields
    if (!parsed.pose || !parsed.vel || typeof parsed.stall !== 'boolean' || !parsed.ts) {
      return false;
    }

    const data: TelemetryData = {
      pose: parsed.pose,
      vel: parsed.vel,
      stall: parsed.stall,
      ts: parsed.ts,
    };

    this.lastTelemetry = data;
    this.emit('telemetry', data);

    // Stall rising edge detection: emit 'stall' only on transition false -> true
    if (data.stall && !this.wasStalled) {
      this.emit('stall', data);
    }
    this.wasStalled = data.stall;

    return true;
  }

  /**
   * Get the most recent telemetry data, or null if none received.
   */
  getLastTelemetry(): TelemetryData | null {
    return this.lastTelemetry;
  }

  /**
   * Check if the robot is currently stalled.
   */
  isStalled(): boolean {
    return this.lastTelemetry?.stall ?? false;
  }
}
