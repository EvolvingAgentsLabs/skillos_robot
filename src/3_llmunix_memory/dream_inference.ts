/**
 * Dream Inference Adapter — Gemini Robotics backend for dream consolidation
 *
 * The dream engine uses longer timeouts, higher token limits, and
 * thinking budget for deep trace analysis. 100% Gemini-based.
 */

import { GeminiRoboticsInference } from '../2_qwen_cerebellum/gemini_robotics';
import type { InferenceFunction } from '../llmunix-core/interfaces';

export interface DreamInferenceConfig {
  /** Google API key (required) */
  apiKey: string;
  /** Gemini model override */
  model?: string;
  /** Max tokens for dream analysis (default: 2048) */
  maxTokens?: number;
  /** Temperature (default: 0.3) */
  temperature?: number;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
}

/**
 * Create an InferenceFunction configured for dream engine use:
 * - maxOutputTokens: 2048 (vs 64 for motor control)
 * - temperature: 0.3 (vs 0.1 for deterministic bytecodes)
 * - timeoutMs: 30000 (offline, no rush)
 * - thinkingBudget: 1024 (deep analysis for strategy abstraction)
 * - useToolCalling: false (text-only trace analysis)
 *
 * Uses Gemini Robotics exclusively. Configure via environment:
 * - GOOGLE_API_KEY: API key (required if not passed in config)
 * - GEMINI_MODEL: model override (default: gemini-3-flash-preview)
 * - DREAM_MAX_TOKENS: token limit override (default: 2048)
 * - DREAM_TEMPERATURE: temperature override (default: 0.3)
 * - GEMINI_THINKING_BUDGET: thinking budget override (default: 1024)
 */
export function createDreamInference(config: DreamInferenceConfig): InferenceFunction {
  const apiKey = config.apiKey || process.env.GOOGLE_API_KEY || '';

  if (!apiKey) {
    throw new Error('Dream inference requires GOOGLE_API_KEY (Gemini Robotics backend)');
  }

  const gemini = new GeminiRoboticsInference({
    apiKey,
    model: config.model ?? process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview',
    maxOutputTokens: config.maxTokens
      ?? (process.env.DREAM_MAX_TOKENS ? parseInt(process.env.DREAM_MAX_TOKENS, 10) : 2048),
    temperature: config.temperature
      ?? (process.env.DREAM_TEMPERATURE ? parseFloat(process.env.DREAM_TEMPERATURE) : 0.3),
    timeoutMs: config.timeoutMs ?? 30000,
    thinkingBudget: parseInt(process.env.GEMINI_THINKING_BUDGET || '1024', 10),
    useToolCalling: false,
  });

  return gemini.createInferenceFunction();
}
