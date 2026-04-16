/**
 * SceneGraphPolicy — Scene-graph-driven PerceptionPolicy
 *
 * The VLM becomes a pure *perceiver*: it returns JSON bounding boxes via
 * the OVERHEAD_SCENE_PROMPT. Deterministic local code (ReactiveController)
 * handles the motor decision. Both paths produce 6-byte bytecodes —
 * everything downstream is unchanged.
 *
 * Pipeline per frame:
 *   1. perceptionInfer(overheadPrompt, userMsg, frames) → JSON
 *   2. parseGeminiSceneResponse() → GeminiObject[]
 *   3. projectGeminiObjects(graph, objects, arena)
 *   4. Update robot pose from telemetry
 *   5. controller.decide(graph, resolvedGoal) → ControllerDecision
 *   6. Return { bytecode: decision.frame, vlmOutput: JSON.stringify(objects) }
 *
 * Feature flag: RF_POLICY=scene_graph or --scene-graph CLI flag.
 */

import { logger } from '../shared/logger';
import type { BytecodeCompiler } from './bytecode_compiler';
import type { InferenceFunction } from '../llmunix-core/interfaces';
import type { PerceptionPolicy, PerceptionPolicyResult, TelemetrySnapshot } from './perception_policy';
import type { SceneGraph } from '../3_llmunix_memory/scene_graph';
import type { ReactiveController } from '../1_openclaw_cortex/reactive_controller';
import type { ArenaConfig } from './vision_projector';
import { projectGeminiObjects } from './vision_projector';
import { parseGeminiSceneResponse } from './scene_response_parser';
import { resolveGoalFromText, type ResolvedGoal } from '../1_openclaw_cortex/goal_resolver';

// =============================================================================
// SceneGraphPolicy
// =============================================================================

export class SceneGraphPolicy implements PerceptionPolicy {
  private readonly graph: SceneGraph;
  private readonly controller: ReactiveController;
  private readonly perceptionInfer: InferenceFunction;
  private readonly compiler: BytecodeCompiler;
  private readonly arena: ArenaConfig;

  constructor(
    graph: SceneGraph,
    controller: ReactiveController,
    perceptionInfer: InferenceFunction,
    compiler: BytecodeCompiler,
    arena: ArenaConfig,
  ) {
    this.graph = graph;
    this.controller = controller;
    this.perceptionInfer = perceptionInfer;
    this.compiler = compiler;
    this.arena = arena;
  }

  async processFrame(
    frameBase64s: string[],
    goal: string,
    telemetry: TelemetrySnapshot | null,
    constraints: string[],
  ): Promise<PerceptionPolicyResult> {
    // 1. Call perception inference (OVERHEAD_SCENE_PROMPT — returns JSON)
    let prompt = this.compiler.getOverheadScenePrompt(goal);
    if (constraints.length > 0) {
      prompt += '\n\nADDITIONAL CONTEXT:\n' +
        constraints.map(c => `- ${c}`).join('\n');
    }

    const response = await this.perceptionInfer(
      prompt,
      'Detect all objects in this overhead view.',
      frameBase64s,
    );

    // 2. Parse JSON → GeminiObject[]
    const objects = parseGeminiSceneResponse(response);
    if (objects.length === 0) {
      logger.warn('SceneGraphPolicy', 'No objects parsed — emitting STOP', {
        response: response.slice(0, 200),
      });
      // Can't navigate without perception — emit STOP as safety fallback
      const { encodeFrame, Opcode } = await import('./bytecode_compiler');
      return {
        bytecode: encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 }),
        vlmOutput: response,
        metadata: { objectCount: 0, action: 'parse_failure' },
      };
    }

    // 3. Project into SceneGraph
    projectGeminiObjects(this.graph, objects, this.arena);

    // 4. Update robot pose from telemetry (overrides vision-based projection)
    if (telemetry) {
      const headingDeg = telemetry.pose.h * (180 / Math.PI);
      this.graph.updateRobotPose(
        telemetry.pose.x,
        telemetry.pose.y,
        headingDeg,
      );
    }

    // 5. Resolve goal from text against current SceneGraph
    const resolved: ResolvedGoal = resolveGoalFromText(goal, this.graph);
    if (resolved.kind === 'explore') {
      logger.debug('SceneGraphPolicy', 'Goal unresolved — no matching node');
      const { encodeFrame, Opcode } = await import('./bytecode_compiler');
      return {
        bytecode: encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 }),
        vlmOutput: JSON.stringify(objects),
        metadata: { objectCount: objects.length, action: 'no_target' },
      };
    }

    // 6. Controller decision
    const decision = this.controller.decide(this.graph, resolved);

    logger.debug('SceneGraphPolicy', `${decision.action}: ${decision.reason}`, {
      objectCount: objects.length,
      distanceCm: decision.distanceCm,
      bearingDeg: decision.bearingDeg,
    });

    return {
      bytecode: decision.frame,
      vlmOutput: JSON.stringify(objects),
      metadata: {
        objectCount: objects.length,
        action: decision.action,
        distanceCm: decision.distanceCm,
        bearingDeg: decision.bearingDeg,
        reason: decision.reason,
      },
    };
  }
}
