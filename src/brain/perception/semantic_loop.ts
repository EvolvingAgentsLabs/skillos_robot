/**
 * SemanticLoop — Async VLM perception loop (1-2 Hz)
 *
 * The "slow brain": captures frames, calls the VLM for spatial perception,
 * parses JSON responses, and projects detected objects into the SceneGraph.
 * Produces NO motor output — only updates the shared spatial model that the
 * ReactiveLoop reads at 10-20 Hz.
 *
 * Pipeline per cycle:
 *   1. Grab latest frame(s) from frame buffer
 *   2. Call VLM inference with OVERHEAD_SCENE_PROMPT
 *   3. Parse JSON → GeminiObject[]
 *   4. projectGeminiObjects(graph, objects, arena)
 *   5. Resolve goal text → ControllerGoal against updated graph
 *   6. Emit 'perception' event with objects + resolved goal
 *
 * Design invariants:
 *   - Never blocks on motor output
 *   - If a VLM call is in-flight, the next tick is skipped (back-pressure)
 *   - Frame feeding is passive (feedFrame() called externally by MJPEG parser)
 */

import { EventEmitter } from 'events';
import { logger } from '../../shared/logger';
import type { BytecodeCompiler } from '../../control/bytecode_compiler';
import type { InferenceFunction } from '../../llmunix-core/interfaces';
import type { SceneGraph } from '../memory/scene_graph';
import type { ArenaConfig } from './vision_projector';
import type { ControllerGoal } from '../../control/reactive_controller';
import type { EgocentricPerception, FrameTarget, FrameObstacle } from '../../control/egocentric_controller';
import { projectGeminiObjects } from './vision_projector';
import { parseGeminiSceneResponse } from './scene_response_parser';
import { resolveGoalFromText, type ResolvedGoal } from '../planning/goal_resolver';

// =============================================================================
// Types
// =============================================================================

export type ControlMode = 'overhead' | 'egocentric';

export interface SemanticLoopConfig {
  /** Target perception interval in ms. Default 500 (2 Hz). */
  intervalMs?: number;
  /** Number of frames to pass to the VLM for temporal context. Default 4. */
  frameHistorySize?: number;
  /** Constraints to append to the perception prompt. */
  constraints?: string[];
  /** Control mode: 'overhead' (default) or 'egocentric' (first-person camera). */
  controlMode?: ControlMode;
}

export interface PerceptionEvent {
  /** Detected objects from this perception cycle. */
  objects: { label: string; box_2d: [number, number, number, number] }[];
  /** Resolved goal (node, point, or explore). */
  resolvedGoal: ResolvedGoal;
  /** Time taken for the VLM inference call (ms). */
  inferenceMs: number;
  /** Timestamp when this perception completed. */
  timestamp: number;
}

export interface SemanticLoopStats {
  perceptionCycles: number;
  objectsDetected: number;
  inferenceErrors: number;
  avgInferenceMs: number;
  running: boolean;
}

// =============================================================================
// SemanticLoop
// =============================================================================

export class SemanticLoop extends EventEmitter {
  private readonly graph: SceneGraph;
  private readonly infer: InferenceFunction;
  private readonly compiler: BytecodeCompiler;
  private readonly arena: ArenaConfig;
  private readonly frameHistorySize: number;
  private readonly controlMode: ControlMode;

  private running = false;
  private processing = false;
  private goal = 'explore and avoid obstacles';
  private constraints: string[] = [];
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  // Frame buffer — fed externally via feedFrame()
  private frameBuffer: { base64: string; timestamp: number }[] = [];

  // Resolved goal — shared with ReactiveLoop via event or getter (overhead mode)
  private lastResolvedGoal: ResolvedGoal = { kind: 'explore' };

  // Last egocentric perception — shared with ReactiveLoop (egocentric mode)
  private lastEgoPerception: EgocentricPerception = { target: null, obstacles: [], timestamp: 0 };

  // Stats
  private stats = {
    perceptionCycles: 0,
    objectsDetected: 0,
    inferenceErrors: 0,
    totalInferenceMs: 0,
  };

  constructor(
    graph: SceneGraph,
    infer: InferenceFunction,
    compiler: BytecodeCompiler,
    arena: ArenaConfig,
    config: SemanticLoopConfig = {},
  ) {
    super();
    this.graph = graph;
    this.infer = infer;
    this.compiler = compiler;
    this.arena = arena;
    this.intervalMs = config.intervalMs ?? 500;
    this.frameHistorySize = config.frameHistorySize ?? 4;
    this.constraints = config.constraints ?? [];
    this.controlMode = config.controlMode ?? 'overhead';
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('SemanticLoop', `Started — interval ${this.intervalMs}ms, goal: "${this.goal}"`);

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
    logger.info('SemanticLoop', 'Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  setGoal(goal: string): void {
    this.goal = goal;
    logger.info('SemanticLoop', `Goal updated: "${goal}"`);
  }

  getGoal(): string {
    return this.goal;
  }

  setConstraints(constraints: string[]): void {
    this.constraints = constraints;
  }

  getConstraints(): string[] {
    return [...this.constraints];
  }

  /** Get the last resolved goal (for ReactiveLoop to read in overhead mode). */
  getResolvedGoal(): ResolvedGoal {
    return this.lastResolvedGoal;
  }

  /** Get the last egocentric perception (for ReactiveLoop in egocentric mode). */
  getLastEgoPerception(): EgocentricPerception {
    return this.lastEgoPerception;
  }

  /** Get the active control mode. */
  getControlMode(): ControlMode {
    return this.controlMode;
  }

  // ---------------------------------------------------------------------------
  // Frame feeding — called externally when new MJPEG frames arrive
  // ---------------------------------------------------------------------------

  /**
   * Feed a new frame into the perception buffer.
   * Called by the MJPEG parser (or any frame source) whenever a new frame arrives.
   */
  feedFrame(base64: string): void {
    this.frameBuffer.push({ base64, timestamp: Date.now() });
    if (this.frameBuffer.length > this.frameHistorySize) {
      this.frameBuffer.shift();
    }
  }

  /** Get the latest frame (for external consumers like self-perception). */
  getLatestFrame(): string {
    return this.frameBuffer.length > 0
      ? this.frameBuffer[this.frameBuffer.length - 1].base64
      : '';
  }

  /** Get all buffered frames as base64 strings. */
  getFrameHistory(): string[] {
    return this.frameBuffer.map(f => f.base64);
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  getStats(): SemanticLoopStats {
    return {
      perceptionCycles: this.stats.perceptionCycles,
      objectsDetected: this.stats.objectsDetected,
      inferenceErrors: this.stats.inferenceErrors,
      avgInferenceMs: this.stats.perceptionCycles > 0
        ? this.stats.totalInferenceMs / this.stats.perceptionCycles
        : 0,
      running: this.running,
    };
  }

  // ---------------------------------------------------------------------------
  // Core perception cycle
  // ---------------------------------------------------------------------------

  private tick(): void {
    // Back-pressure: if a VLM call is still in-flight, skip this tick
    if (this.processing) return;
    // No frames available yet — skip
    if (this.frameBuffer.length === 0) return;

    this.processing = true;
    this.processPerception().catch((err) => {
      this.stats.inferenceErrors++;
      logger.error('SemanticLoop', 'Perception cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.emit('error', err);
    }).finally(() => {
      this.processing = false;
    });
  }

  private async processPerception(): Promise<void> {
    const frames = this.frameBuffer.map(f => f.base64);

    // Build perception prompt based on control mode
    const isEgocentric = this.controlMode === 'egocentric';
    let prompt = isEgocentric
      ? this.compiler.getFirstPersonPrompt(this.goal)
      : this.compiler.getOverheadScenePrompt(this.goal);

    if (this.constraints.length > 0) {
      prompt += '\n\nADDITIONAL CONTEXT:\n' +
        this.constraints.map(c => `- ${c}`).join('\n');
    }

    // Call VLM inference
    const startMs = Date.now();
    const userMsg = isEgocentric
      ? 'Identify the target and obstacles in this first-person camera view.'
      : 'Detect all objects in this overhead view.';
    const response = await this.infer(prompt, userMsg, frames);
    const inferenceMs = Date.now() - startMs;
    this.stats.totalInferenceMs += inferenceMs;

    // Parse response → GeminiObject[]
    const objects = parseGeminiSceneResponse(response);
    this.stats.perceptionCycles++;
    this.stats.objectsDetected += objects.length;

    if (objects.length === 0) {
      logger.debug('SemanticLoop', 'No objects parsed', {
        response: response.slice(0, 200),
        inferenceMs,
      });
    }

    if (isEgocentric) {
      // Egocentric mode: convert to FrameTarget/FrameObstacle (normalized 0-1)
      const egoPerception = this.convertToEgoPerception(objects);
      this.lastEgoPerception = egoPerception;
      this.emit('egoPerception', egoPerception);

      // Emit standard perception event too (for trace logging)
      const event: PerceptionEvent = {
        objects: objects.map(o => ({ label: o.label, box_2d: o.box_2d })),
        resolvedGoal: this.lastResolvedGoal,
        inferenceMs,
        timestamp: Date.now(),
      };
      this.emit('perception', event);
    } else {
      // Overhead mode: project into SceneGraph and resolve goal
      if (objects.length > 0) {
        projectGeminiObjects(this.graph, objects, this.arena);
      }
      this.lastResolvedGoal = resolveGoalFromText(this.goal, this.graph);

      const event: PerceptionEvent = {
        objects: objects.map(o => ({ label: o.label, box_2d: o.box_2d })),
        resolvedGoal: this.lastResolvedGoal,
        inferenceMs,
        timestamp: Date.now(),
      };
      this.emit('perception', event);
    }

    logger.debug('SemanticLoop', `Perception [${this.controlMode}]: ${objects.length} objects, ${inferenceMs}ms`);
  }

  /**
   * Convert GeminiObject[] to EgocentricPerception.
   * Normalizes box_2d from 0-1000 to 0-1 and identifies the target via is_target flag.
   */
  private convertToEgoPerception(
    objects: ReturnType<typeof parseGeminiSceneResponse>,
  ): EgocentricPerception {
    let target: FrameTarget | null = null;
    const obstacles: FrameObstacle[] = [];

    for (const obj of objects) {
      const [ymin, xmin, ymax, xmax] = obj.box_2d;
      const cx = ((xmin + xmax) / 2) / 1000;
      const cy = ((ymin + ymax) / 2) / 1000;
      const width = (xmax - xmin) / 1000;
      const height = (ymax - ymin) / 1000;
      const size = width * height;

      if (obj.is_target && !target) {
        target = { cx, cy, size, label: obj.label };
      } else {
        obstacles.push({ cx, cy, size, label: obj.label });
      }
    }

    return { target, obstacles, timestamp: Date.now() };
  }
}
