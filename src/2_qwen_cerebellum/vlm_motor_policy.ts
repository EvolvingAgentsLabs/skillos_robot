/**
 * VLMMotorPolicy — Default PerceptionPolicy (original VisionLoop behavior)
 *
 * The VLM (Gemini, Qwen, Ollama) sees camera frames and outputs a motor
 * command directly — either as hex bytecode, text commands, or tool calls.
 * The BytecodeCompiler parses the VLM output into a 6-byte frame.
 *
 * This is a zero-behavior-change extraction of VisionLoop.processFrame()
 * lines 556–635 into the PerceptionPolicy interface.
 */

import { logger } from '../shared/logger';
import type { BytecodeCompiler } from './bytecode_compiler';
import type { InferenceFunction } from '../llmunix-core/interfaces';
import type { PerceptionPolicy, PerceptionPolicyResult, TelemetrySnapshot } from './perception_policy';

// =============================================================================
// Types
// =============================================================================

export interface VLMMotorPolicyConfig {
  /** Use tool-calling prompt (for Gemini with function calling). */
  useToolCallingPrompt: boolean;
}

// =============================================================================
// VLMMotorPolicy
// =============================================================================

export class VLMMotorPolicy implements PerceptionPolicy {
  private readonly compiler: BytecodeCompiler;
  private readonly infer: InferenceFunction;
  private readonly useToolCallingPrompt: boolean;

  constructor(
    compiler: BytecodeCompiler,
    infer: InferenceFunction,
    config: VLMMotorPolicyConfig = { useToolCallingPrompt: false },
  ) {
    this.compiler = compiler;
    this.infer = infer;
    this.useToolCallingPrompt = config.useToolCallingPrompt;
  }

  async processFrame(
    frameBase64s: string[],
    goal: string,
    telemetry: TelemetrySnapshot | null,
    constraints: string[],
  ): Promise<PerceptionPolicyResult> {
    // 1. Build system prompt
    let systemPrompt = this.useToolCallingPrompt
      ? this.compiler.getToolCallingSystemPrompt(goal)
      : this.compiler.getSystemPrompt(goal);
    if (constraints.length > 0) {
      systemPrompt += '\n\nACTIVE CONSTRAINTS (from learned strategies):\n' +
        constraints.map(c => `- ${c}`).join('\n');
    }

    // 2. Build telemetry section
    const telemetrySection = telemetry
      ? buildTelemetrySection(telemetry)
      : '';

    // 3. Build user message
    const frameCount = frameBase64s.length;
    const userMessage = frameCount > 1
      ? this.useToolCallingPrompt
        ? `This is a video of the last ${frameCount} frames of movement (oldest→newest). The goal is: ${goal}. Analyze what you see and call the appropriate motor control function.${telemetrySection}`
        : `This is a video of the last ${frameCount} frames of movement (oldest→newest). The goal is: ${goal}. Use the visual differences between frames to gauge your velocity and 3D surroundings. Output the next 6-byte motor command.${telemetrySection}`
      : this.useToolCallingPrompt
        ? `What do you see? Call the appropriate motor control function for the goal: ${goal}${telemetrySection}`
        : 'What do you see? Output the next motor command.';

    // 4. Inference
    const vlmOutput = await this.infer(systemPrompt, userMessage, frameBase64s);

    // 5. Compile
    const bytecode = this.compiler.compile(vlmOutput);

    return { bytecode, vlmOutput };
  }
}

// =============================================================================
// Telemetry section builder — extracted from VisionLoop for reuse
// =============================================================================

/**
 * Build the telemetry text section injected into the VLM user message.
 * Mirrors the original VisionLoop.processFrame() logic exactly.
 */
export function buildTelemetrySection(telem: TelemetrySnapshot): string {
  const headingDeg = Math.round(telem.pose.h * 180 / Math.PI);
  const distCm = telem.targetDist != null ? (telem.targetDist * 100).toFixed(0) : null;

  logger.info('VLMMotorPolicy', `Telemetry: pos=(${telem.pose.x.toFixed(3)},${telem.pose.y.toFixed(3)}) h=${headingDeg}° dist=${distCm ?? '?'}cm bearing=${telem.targetBearing?.toFixed(1) ?? '?'}°`);

  let section = `\n\nSENSOR DATA (from odometry — trust these numbers):\n` +
    `- Robot position: x=${telem.pose.x.toFixed(3)}, y=${telem.pose.y.toFixed(3)}\n` +
    `- Robot heading: ${headingDeg}deg`;

  if (distCm != null) {
    section += `\n- Target distance: ${distCm}cm`;
  }

  if (telem.targetBearing != null) {
    const b = telem.targetBearing;
    const absB = Math.abs(b);
    const dir = absB < 10 ? 'AHEAD'
      : b > 0 ? `${absB.toFixed(0)}deg LEFT`
      : `${absB.toFixed(0)}deg RIGHT`;
    section += `\n- Target bearing: ${dir}`;

    if (distCm != null && parseInt(distCm) < 15) {
      section += `\n>>> CALL: stop()`;
    } else if (absB <= 25) {
      const speed = distCm != null && parseInt(distCm) < 40 ? 100 : 180;
      section += `\n>>> CALL: move_forward(${speed}, ${speed})`;
    } else if (absB <= 70) {
      if (b > 0) {
        section += `\n>>> CALL: rotate_ccw(${Math.round(absB)}, 50)`;
      } else {
        section += `\n>>> CALL: rotate_cw(${Math.round(absB)}, 50)`;
      }
    } else {
      if (b > 0) {
        section += `\n>>> CALL: rotate_ccw(${Math.round(absB)}, 70)`;
      } else {
        section += `\n>>> CALL: rotate_cw(${Math.round(absB)}, 70)`;
      }
    }
  }

  return section;
}
