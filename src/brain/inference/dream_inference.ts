/**
 * Dream Inference Adapter — Multi-backend inference for dream consolidation
 *
 * The dream engine uses longer timeouts, higher token limits, and
 * thinking budget for deep trace analysis.
 *
 * Supports OpenRouter (Qwen3-VL) and Gemini Robotics backends.
 * Uses OpenRouter by default; falls back to Gemini if GOOGLE_API_KEY is set
 * and DREAM_PROVIDER=gemini.
 */

import { GeminiRoboticsInference } from './gemini_robotics';
import { CerebellumInference } from './inference';
import type { InferenceFunction } from '../../llmunix-core/interfaces';

export interface DreamInferenceConfig {
  /** API key — Google API key for Gemini, or OpenRouter key. Resolved from env if empty. */
  apiKey: string;
  /** Model override (Gemini model or OpenRouter model ID) */
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
 * - maxTokens: 2048 (vs 512 for motor control)
 * - temperature: 0.3 (vs 0.1 for deterministic bytecodes)
 * - timeoutMs: 30000 (offline, no rush)
 * - useToolCalling: false (text-only trace analysis)
 *
 * Backend selection:
 * 1. If DREAM_PROVIDER=gemini and GOOGLE_API_KEY is set → Gemini Robotics
 * 2. If OPENROUTER_API_KEY is set → OpenRouter (Qwen3-VL-8B)
 * 3. If GOOGLE_API_KEY is set → Gemini Robotics (legacy fallback)
 *
 * Configure via environment:
 * - OPENROUTER_API_KEY: OpenRouter key (preferred)
 * - QWEN_MODEL: OpenRouter model override (default: qwen/qwen3-vl-8b-instruct)
 * - GOOGLE_API_KEY: Google API key (for Gemini mode)
 * - GEMINI_MODEL: Gemini model override (default: gemini-3-flash-preview)
 * - DREAM_MAX_TOKENS: token limit override (default: 2048)
 * - DREAM_TEMPERATURE: temperature override (default: 0.3)
 * - DREAM_PROVIDER: force backend ("gemini" or "openrouter")
 */
export function createDreamInference(config: DreamInferenceConfig): InferenceFunction {
  const maxTokens = config.maxTokens
    ?? (process.env.DREAM_MAX_TOKENS ? parseInt(process.env.DREAM_MAX_TOKENS, 10) : 2048);
  const temperature = config.temperature
    ?? (process.env.DREAM_TEMPERATURE ? parseFloat(process.env.DREAM_TEMPERATURE) : 0.3);
  const timeoutMs = config.timeoutMs ?? 30000;

  const dreamProvider = process.env.DREAM_PROVIDER || '';
  const googleApiKey = config.apiKey || process.env.GOOGLE_API_KEY || '';
  const openRouterKey = process.env.OPENROUTER_API_KEY || '';

  // Force Gemini if explicitly requested
  const useGemini = dreamProvider === 'gemini' && googleApiKey;

  if (useGemini) {
    const gemini = new GeminiRoboticsInference({
      apiKey: googleApiKey,
      model: config.model ?? process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview',
      maxOutputTokens: maxTokens,
      temperature,
      timeoutMs,
      thinkingBudget: parseInt(process.env.GEMINI_THINKING_BUDGET || '1024', 10),
      useToolCalling: false,
    });
    return gemini.createInferenceFunction();
  }

  // OpenRouter (preferred default)
  if (openRouterKey) {
    const adapter = new CerebellumInference({
      apiKey: openRouterKey,
      model: config.model ?? process.env.QWEN_MODEL ?? 'qwen/qwen3-vl-8b-instruct',
      maxTokens,
      temperature,
      timeoutMs,
    });
    return adapter.createInferenceFunction();
  }

  // Legacy Gemini fallback
  if (googleApiKey) {
    const gemini = new GeminiRoboticsInference({
      apiKey: googleApiKey,
      model: config.model ?? process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview',
      maxOutputTokens: maxTokens,
      temperature,
      timeoutMs,
      thinkingBudget: parseInt(process.env.GEMINI_THINKING_BUDGET || '1024', 10),
      useToolCalling: false,
    });
    return gemini.createInferenceFunction();
  }

  throw new Error(
    'Dream inference requires OPENROUTER_API_KEY or GOOGLE_API_KEY. ' +
    'Set one in your .env file.'
  );
}
