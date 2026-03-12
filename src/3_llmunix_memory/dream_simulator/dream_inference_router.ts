/**
 * Dream Inference Router — Gemini Robotics inference for dream simulation
 *
 * During dreaming, the robot needs an inference backend to decide motor commands
 * based on text scene descriptions. Uses Gemini Robotics exclusively.
 *
 * All modes use text-only scenes (no images) since dream simulation doesn't
 * have a camera feed — scenes are described as text by TextSceneSimulator.
 */

import type { InferenceFunction } from '../../llmunix-core/interfaces';
import { GeminiRoboticsInference, ROCLAW_TOOL_DECLARATIONS } from '../../2_qwen_cerebellum/gemini_robotics';

// =============================================================================
// Types
// =============================================================================

/** Kept for backward compatibility — only 'gemini' is active */
export type DreamInferenceMode = 'gemini';

export interface DreamInferenceRouterConfig {
  mode?: DreamInferenceMode;
  /** Google API key for Gemini (required) */
  googleApiKey?: string;
  /** Gemini model for image-based inference (robotics-er) */
  geminiModel?: string;
  /** Gemini model for text-only inference (flash-lite). Defaults to geminiModel for backward compat. */
  textModel?: string;
  /** Max tokens for motor control inference (default: 128) */
  maxTokens?: number;
  /** Temperature (default: 0.1) */
  temperature?: number;
  /** Timeout in ms (default: 15000) */
  timeoutMs?: number;
}

export interface InferenceStats {
  totalCalls: number;
  geminiCalls: number;
  errors: number;
  avgLatencyMs: number;
}

// =============================================================================
// Dream Inference Router — Gemini Only
// =============================================================================

export class DreamInferenceRouter {
  private textInfer: InferenceFunction;
  private imageInfer: InferenceFunction;
  private stats: InferenceStats = {
    totalCalls: 0,
    geminiCalls: 0,
    errors: 0,
    avgLatencyMs: 0,
  };
  private totalLatencyMs: number = 0;

  constructor(config: DreamInferenceRouterConfig) {
    const googleKey = config.googleApiKey || process.env.GOOGLE_API_KEY || '';
    if (!googleKey) {
      throw new Error('Dream inference requires GOOGLE_API_KEY (Gemini Robotics backend)');
    }

    const imageModel = config.geminiModel ?? process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview';
    const textModel = config.textModel ?? imageModel;

    const sharedConfig = {
      apiKey: googleKey,
      maxOutputTokens: config.maxTokens ?? 512,
      temperature: config.temperature ?? 0.1,
      timeoutMs: config.timeoutMs ?? 15000,
      thinkingBudget: 0, // Fast motor control, no deep thinking
      useToolCalling: true,
      tools: ROCLAW_TOOL_DECLARATIONS,
    };

    const textBackend = new GeminiRoboticsInference({ ...sharedConfig, model: textModel });
    const imageBackend = new GeminiRoboticsInference({ ...sharedConfig, model: imageModel });

    this.textInfer = textBackend.createInferenceFunction();
    this.imageInfer = imageBackend.createInferenceFunction();
  }

  /** Get the active inference mode */
  getMode(): DreamInferenceMode {
    return 'gemini';
  }

  /** Get inference statistics */
  getStats(): InferenceStats {
    return { ...this.stats };
  }

  /**
   * Run inference on a text scene description.
   * Returns the VLM output (TOOLCALL:... or hex) that can be compiled to bytecode.
   */
  async infer(systemPrompt: string, sceneDescription: string): Promise<string> {
    this.stats.totalCalls++;
    const start = Date.now();

    try {
      // Dream sim scenes are always text-only — route to text model
      const result = await this.textInfer(systemPrompt, sceneDescription);
      this.stats.geminiCalls++;

      const elapsed = Date.now() - start;
      this.totalLatencyMs += elapsed;
      this.stats.avgLatencyMs = Math.round(this.totalLatencyMs / this.stats.totalCalls);

      return result;
    } catch (err) {
      this.stats.errors++;
      throw err;
    }
  }

  /**
   * Create an InferenceFunction compatible with the existing RoClaw stack.
   */
  createInferenceFunction(): InferenceFunction {
    return async (systemPrompt: string, userMessage: string, images?: string[]): Promise<string> => {
      if (images && images.length > 0) {
        // Real camera images → route to image model (robotics-er)
        return this.imageInfer(systemPrompt, userMessage, images);
      }
      // Text-only → route to text model (flash-lite)
      return this.infer(systemPrompt, userMessage);
    };
  }
}
