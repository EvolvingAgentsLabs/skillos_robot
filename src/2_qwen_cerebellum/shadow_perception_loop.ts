/**
 * ShadowPerceptionLoop — Read-only sidecar for the scene-graph pipeline
 *
 * Runs alongside the existing VisionLoop. On each VLM frame, it:
 *   1. Calls the perception inference (OVERHEAD_SCENE_PROMPT mode)
 *   2. Projects the JSON bounding boxes into the SceneGraph
 *   3. Runs the ReactiveController to get a deterministic motor decision
 *   4. Compares with the VLM's actual bytecode and logs divergence
 *
 * **Never transmits.** The VisionLoop remains the source of truth for all
 * motor commands. This loop exists to validate the scene-graph pipeline
 * against real VLM decisions before making it a production path (PR-3).
 *
 * Feature flag: RF_PERCEPTION_SHADOW=1
 */

import { EventEmitter } from 'events';
import { logger } from '../shared/logger';
import { formatHex } from './bytecode_compiler';
import type { BytecodeCompiler } from './bytecode_compiler';
import type { InferenceFunction } from '../llmunix-core/interfaces';
import type { SceneGraph } from '../3_llmunix_memory/scene_graph';
import type { ReactiveController, ControllerGoal } from '../1_openclaw_cortex/reactive_controller';
import type { ArenaConfig } from './vision_projector';
import { projectGeminiObjects } from './vision_projector';
import { parseGeminiSceneResponse } from './scene_response_parser';
import { resolveGoalFromText, type ResolvedGoal } from '../1_openclaw_cortex/goal_resolver';

// =============================================================================
// Types
// =============================================================================

export interface ShadowPerceptionConfig {
  /** Process every Nth frame (default: 2 — halves API cost). */
  frameSkip?: number;
}

export interface DivergenceInfo {
  /** What the controller would have done. */
  action: string;
  /** Human-readable explanation from the controller. */
  reason: string;
  /** Hex of the VLM's actual bytecode. */
  vlmHex: string;
  /** Hex of what the controller would have sent. */
  controllerHex: string;
  /** Distance to target in cm. */
  distanceCm: number;
  /** Bearing to target in degrees. */
  bearingDeg: number;
  /** Number of objects detected in this frame. */
  objectCount: number;
}

/** Minimal telemetry contract — structurally compatible with TelemetryMonitor. */
export interface TelemetryProvider {
  getLastTelemetry(): { pose: { x: number; y: number; h: number } } | null;
}

// =============================================================================
// ShadowPerceptionLoop
// =============================================================================

export class ShadowPerceptionLoop extends EventEmitter {
  private readonly graph: SceneGraph;
  private readonly controller: ReactiveController;
  private readonly compiler: BytecodeCompiler;
  private readonly infer: InferenceFunction;
  private readonly arena: ArenaConfig;
  private readonly frameSkip: number;

  private goalText: string = '';
  private controllerGoal: ControllerGoal | null = null;
  private telemetryProvider: TelemetryProvider | null = null;
  private frameCount = 0;
  private processing = false;

  // Stats
  private stats = {
    framesReceived: 0,
    framesProcessed: 0,
    divergences: 0,
    agreements: 0,
    parseFailures: 0,
    inferenceErrors: 0,
  };

  constructor(
    graph: SceneGraph,
    controller: ReactiveController,
    compiler: BytecodeCompiler,
    infer: InferenceFunction,
    arena: ArenaConfig,
    config: ShadowPerceptionConfig = {},
  ) {
    super();
    this.graph = graph;
    this.controller = controller;
    this.compiler = compiler;
    this.infer = infer;
    this.arena = arena;
    this.frameSkip = config.frameSkip ?? 2;
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /** Set a resolved ControllerGoal (overrides text-based resolution). */
  setGoal(goal: ControllerGoal): void {
    this.controllerGoal = goal;
  }

  /** Set a text goal for both the perception prompt and fuzzy resolution. */
  setGoalText(text: string): void {
    this.goalText = text;
  }

  /** Provide a telemetry source for robot pose updates. */
  setTelemetryProvider(provider: TelemetryProvider): void {
    this.telemetryProvider = provider;
  }

  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  // ---------------------------------------------------------------------------
  // Core
  // ---------------------------------------------------------------------------

  /**
   * Process one frame from the VisionLoop. Called on every 'bytecode' event.
   * Skips frames based on frameSkip to reduce API cost.
   * Never transmits — read-only comparison only.
   */
  async onFrame(frameBase64: string, vlmBytecode: Buffer): Promise<void> {
    this.stats.framesReceived++;
    this.frameCount++;

    // Skip frames (every Nth)
    if (this.frameCount % this.frameSkip !== 0) return;

    // Don't queue — drop frames if previous is still processing
    if (this.processing) return;
    this.processing = true;

    try {
      await this.processFrame(frameBase64, vlmBytecode);
    } catch (err) {
      this.stats.inferenceErrors++;
      logger.warn('ShadowPerception', 'Frame processing error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.processing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async processFrame(frameBase64: string, vlmBytecode: Buffer): Promise<void> {
    // 1. Perception inference (OVERHEAD_SCENE_PROMPT mode — returns JSON)
    const prompt = this.compiler.getOverheadScenePrompt(this.goalText);
    const response = await this.infer(
      prompt,
      'Detect all objects in this overhead view.',
      [frameBase64],
    );

    // 2. Parse JSON → GeminiObject[]
    const objects = parseGeminiSceneResponse(response);
    if (objects.length === 0) {
      this.stats.parseFailures++;
      logger.debug('ShadowPerception', 'No objects parsed from response', {
        response: response.slice(0, 200),
      });
      return;
    }

    // 3. Project into SceneGraph
    projectGeminiObjects(this.graph, objects, this.arena);

    // 4. Update robot pose from telemetry (overrides projection if available)
    if (this.telemetryProvider) {
      const telem = this.telemetryProvider.getLastTelemetry();
      if (telem) {
        // TelemetryData.pose.h is in radians → convert to degrees
        const headingDeg = telem.pose.h * (180 / Math.PI);
        this.graph.updateRobotPose(telem.pose.x, telem.pose.y, headingDeg);
      }
    }

    // 5. Resolve goal
    const goal = this.resolveGoal();
    if (!goal) {
      logger.debug('ShadowPerception', 'No target resolved — skipping comparison');
      return;
    }

    // 6. Controller decision
    const decision = this.controller.decide(this.graph, goal);

    // 7. Compare with VLM bytecode
    this.stats.framesProcessed++;
    const diverges = !decision.frame.equals(vlmBytecode);

    if (diverges) {
      this.stats.divergences++;
      const info: DivergenceInfo = {
        action: decision.action,
        reason: decision.reason,
        vlmHex: formatHex(vlmBytecode),
        controllerHex: formatHex(decision.frame),
        distanceCm: decision.distanceCm,
        bearingDeg: decision.bearingDeg,
        objectCount: objects.length,
      };
      logger.info('ShadowPerception', 'DIVERGENCE', info);
      this.emit('divergence', info);
    } else {
      this.stats.agreements++;
      this.emit('agreement', { action: decision.action, objectCount: objects.length });
    }
  }

  /**
   * Resolve the current goal to a ControllerGoal.
   * Priority: explicit ControllerGoal > text-based fuzzy resolution > null.
   */
  private resolveGoal(): ControllerGoal | null {
    // Explicit goal set via setGoal()
    if (this.controllerGoal) return this.controllerGoal;

    // Text-based resolution against current SceneGraph
    if (this.goalText) {
      const resolved: ResolvedGoal = resolveGoalFromText(this.goalText, this.graph);
      if (resolved.kind !== 'explore') {
        return resolved as ControllerGoal;
      }
    }

    return null;
  }
}
