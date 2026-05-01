/**
 * ReactiveLoop — High-frequency motor control loop (10-20 Hz)
 *
 * The "fast brain": reads the SceneGraph (populated by SemanticLoop at 1-2 Hz)
 * and makes pure-math motor decisions at 10-20 Hz using ReactiveController.
 * Every tick runs:
 *   1. Read resolved goal (from SemanticLoop or set explicitly)
 *   2. ReactiveController.decide(graph, goal) → motor frame
 *   3. ReflexGuard.decide(frame) → allow/veto
 *   4. UDPTransmitter.send(frame or STOP)
 *
 * Design invariants:
 *   - Zero VLM calls — pure math, deterministic, <1ms per tick
 *   - No frame capture — reads only from SceneGraph
 *   - Built-in ReflexGuard — no external attachReflexGuard() needed
 *   - Replaces the heartbeat timer (20Hz motor output > ESP32's 2s timeout)
 *   - Emits 'arrived' when ReactiveController says distance < threshold
 *   - Emits 'stuck' when no progress toward goal for N ticks
 */

import { EventEmitter } from 'events';
import { logger } from '../shared/logger';
import { SceneGraph } from '../brain/memory/scene_graph';
import {
  ReactiveController,
  type ControllerGoal,
  type ControllerDecision,
} from './reactive_controller';
import {
  ReflexGuard,
  type GuardDecision,
  type ReflexMode,
} from './reflex_guard';
import { EgocentricController, type EgocentricPerception, type EgoDecision } from './egocentric_controller';
import { EgocentricReflexGuard, type EgoGuardDecision } from './egocentric_reflex_guard';
import type { UDPTransmitter } from '../bridge/udp_transmitter';
import { encodeFrame, Opcode } from './bytecode_compiler';

// =============================================================================
// Types
// =============================================================================

export interface ReactiveLoopConfig {
  /** Tick interval in ms. Default 50 (20 Hz). */
  intervalMs?: number;
  /** Number of ticks with no distance decrease to trigger 'stuck'. Default 40 (2s at 20Hz). */
  stuckThresholdTicks?: number;
  /** Distance decrease required per window to not be "stuck" (cm). Default 1. */
  stuckProgressCm?: number;
  /** ReflexGuard mode override. Default reads from env. */
  reflexMode?: ReflexMode;
}

/** Config for egocentric mode ReactiveLoop. */
export interface EgocentricReactiveLoopConfig {
  /** Tick interval in ms. Default 50 (20 Hz). */
  intervalMs?: number;
  /** Number of ticks of 'search' to trigger 'stuck'. Default 40. */
  stuckThresholdTicks?: number;
}

export interface ReactiveCommandEvent {
  /** What the controller decided. */
  decision: ControllerDecision;
  /** What the guard decided. */
  guard: GuardDecision;
  /** Whether the command was actually sent (vs vetoed). */
  sent: boolean;
  /** Tick number since start. */
  tick: number;
}

export interface ReactiveLoopStats {
  ticks: number;
  commandsSent: number;
  vetoes: number;
  arrivals: number;
  stuckEvents: number;
  running: boolean;
}

// =============================================================================
// ReactiveLoop
// =============================================================================

export class ReactiveLoop extends EventEmitter {
  private readonly graph: SceneGraph;
  private readonly controller: ReactiveController;
  private readonly guard: ReflexGuard;
  private readonly transmitter: UDPTransmitter;
  private readonly intervalMs: number;
  private readonly stuckThresholdTicks: number;
  private readonly stuckProgressCm: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private goal: ControllerGoal | null = null;
  private tickCount = 0;

  // Stuck detection: track distance over a sliding window
  private distanceHistory: number[] = [];
  private stuckWindowStart = 0;

  // Stats
  private stats = {
    ticks: 0,
    commandsSent: 0,
    vetoes: 0,
    arrivals: 0,
    stuckEvents: 0,
  };

  constructor(
    graph: SceneGraph,
    controller: ReactiveController,
    guard: ReflexGuard,
    transmitter: UDPTransmitter,
    config: ReactiveLoopConfig = {},
  ) {
    super();
    this.graph = graph;
    this.controller = controller;
    this.guard = guard;
    this.transmitter = transmitter;
    this.intervalMs = config.intervalMs ?? 50;
    this.stuckThresholdTicks = config.stuckThresholdTicks ?? 40;
    this.stuckProgressCm = config.stuckProgressCm ?? 1;

    if (config.reflexMode) {
      this.guard.setMode(config.reflexMode);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(goal?: ControllerGoal): void {
    if (this.running) return;
    this.running = true;
    this.tickCount = 0;
    this.distanceHistory = [];
    this.stuckWindowStart = 0;

    if (goal) {
      this.goal = goal;
    }

    logger.info('ReactiveLoop', `Started — ${this.intervalMs}ms interval (${Math.round(1000 / this.intervalMs)} Hz)`);

    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Send a final STOP frame for safety
    const stopFrame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
    this.transmitter.send(stopFrame).catch(() => {});
    logger.info('ReactiveLoop', 'Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Goal management
  // ---------------------------------------------------------------------------

  setGoal(goal: ControllerGoal): void {
    this.goal = goal;
    this.distanceHistory = [];
    this.stuckWindowStart = this.tickCount;
  }

  getGoal(): ControllerGoal | null {
    return this.goal;
  }

  /** Clear goal — robot will idle (STOP each tick). */
  clearGoal(): void {
    this.goal = null;
    this.distanceHistory = [];
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  getStats(): ReactiveLoopStats {
    return {
      ...this.stats,
      running: this.running,
    };
  }

  getTickCount(): number {
    return this.tickCount;
  }

  // ---------------------------------------------------------------------------
  // Core tick — runs at 10-20 Hz
  // ---------------------------------------------------------------------------

  private tick(): void {
    this.tickCount++;
    this.stats.ticks++;

    // No goal set — send STOP to keep ESP32 alive without moving
    if (!this.goal) {
      const stopFrame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
      this.transmitter.send(stopFrame).catch((err) => {
        logger.warn('ReactiveLoop', 'STOP send failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }

    // 1. ReactiveController decision
    const decision = this.controller.decide(this.graph, this.goal);

    // 2. ReflexGuard check
    const guardResult = this.guard.decide(decision.frame);
    const frameToSend = guardResult.allow
      ? decision.frame
      : (guardResult.replacement ?? decision.frame);

    // 3. Transmit
    const sent = guardResult.allow;
    this.transmitter.send(frameToSend).catch((err) => {
      logger.warn('ReactiveLoop', 'Send failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    if (sent) {
      this.stats.commandsSent++;
    } else {
      this.stats.vetoes++;
    }

    // 4. Emit command event
    const event: ReactiveCommandEvent = {
      decision,
      guard: guardResult,
      sent,
      tick: this.tickCount,
    };
    this.emit('command', event);

    // 5. Check arrival
    if (decision.action === 'arrived') {
      this.stats.arrivals++;
      this.emit('arrived', decision);
      this.stop();
      return;
    }

    // 6. Stuck detection — track distance progress over window
    this.distanceHistory.push(decision.distanceCm);
    if (this.distanceHistory.length > this.stuckThresholdTicks) {
      this.distanceHistory.shift();
    }

    if (this.distanceHistory.length >= this.stuckThresholdTicks) {
      const windowStart = this.distanceHistory[0];
      const windowEnd = this.distanceHistory[this.distanceHistory.length - 1];
      const progress = windowStart - windowEnd;

      if (progress < this.stuckProgressCm && decision.action !== 'no_target') {
        this.stats.stuckEvents++;
        this.emit('stuck', {
          distanceCm: decision.distanceCm,
          progressCm: progress,
          ticks: this.tickCount,
        });
        // Reset window to avoid repeated stuck emissions
        this.distanceHistory = [];
      }
    }
  }
}

// =============================================================================
// EgocentricReactiveLoop — First-person camera control at 20 Hz
// =============================================================================

/**
 * High-frequency motor loop for egocentric visual servoing.
 * Re-uses the last EgocentricPerception from SemanticLoop to drive
 * the EgocentricController at 20 Hz.
 */
export class EgocentricReactiveLoop extends EventEmitter {
  private readonly controller: EgocentricController;
  private readonly guard: EgocentricReflexGuard;
  private readonly transmitter: UDPTransmitter;
  private readonly getPerception: () => EgocentricPerception;
  private readonly intervalMs: number;
  private readonly stuckThresholdTicks: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickCount = 0;
  private searchTicks = 0;

  private stats = {
    ticks: 0,
    commandsSent: 0,
    vetoes: 0,
    arrivals: 0,
    stuckEvents: 0,
  };

  constructor(
    controller: EgocentricController,
    guard: EgocentricReflexGuard,
    transmitter: UDPTransmitter,
    getPerception: () => EgocentricPerception,
    config: EgocentricReactiveLoopConfig = {},
  ) {
    super();
    this.controller = controller;
    this.guard = guard;
    this.transmitter = transmitter;
    this.getPerception = getPerception;
    this.intervalMs = config.intervalMs ?? 50;
    this.stuckThresholdTicks = config.stuckThresholdTicks ?? 40;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tickCount = 0;
    this.searchTicks = 0;

    logger.info('EgoReactiveLoop', `Started — ${this.intervalMs}ms interval (${Math.round(1000 / this.intervalMs)} Hz)`);

    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const stopFrame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
    this.transmitter.send(stopFrame).catch(() => {});
    logger.info('EgoReactiveLoop', 'Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getStats(): ReactiveLoopStats {
    return { ...this.stats, running: this.running };
  }

  getTickCount(): number {
    return this.tickCount;
  }

  private tick(): void {
    this.tickCount++;
    this.stats.ticks++;

    const perception = this.getPerception();

    // Update guard with latest obstacles
    this.guard.updateObstacles(perception.obstacles);

    // Controller decision
    const decision = this.controller.decide(perception);

    // Guard check
    const guardResult = this.guard.decide(decision.frame);
    const frameToSend = guardResult.allow
      ? decision.frame
      : (guardResult.replacement ?? decision.frame);
    const sent = guardResult.allow;

    // Transmit
    this.transmitter.send(frameToSend).catch((err) => {
      logger.warn('EgoReactiveLoop', 'Send failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    if (sent) {
      this.stats.commandsSent++;
    } else {
      this.stats.vetoes++;
    }

    // Emit command event
    this.emit('command', { decision, guard: guardResult, sent, tick: this.tickCount });

    // Check arrival
    if (decision.action === 'arrived') {
      this.stats.arrivals++;
      this.emit('arrived', decision);
      this.stop();
      return;
    }

    // Stuck detection: prolonged search means target is lost
    if (decision.action === 'search') {
      this.searchTicks++;
      if (this.searchTicks >= this.stuckThresholdTicks) {
        this.stats.stuckEvents++;
        this.emit('stuck', { action: 'search', ticks: this.tickCount });
        this.searchTicks = 0;
      }
    } else {
      this.searchTicks = 0;
    }
  }
}
