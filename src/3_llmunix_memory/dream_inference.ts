/**
 * Dream Inference Adapter — Wraps CerebellumInference with dream-specific config
 *
 * The dream engine uses longer timeouts, higher token limits, and optionally
 * a different (cheaper) model since it runs offline.
 */

import { CerebellumInference, type InferenceFunction } from '../2_qwen_cerebellum/inference';
import { GeminiRoboticsInference } from '../2_qwen_cerebellum/gemini_robotics';

export interface DreamInferenceConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  apiBaseUrl?: string;
}

/**
 * Create an InferenceFunction configured for dream engine use:
 * - maxTokens: 2048 (vs 64 for motor control)
 * - temperature: 0.3 (vs 0.1 for deterministic bytecodes)
 * - timeoutMs: 30000 (offline, no rush)
 * - supportsVision: false (text-only trace analysis)
 *
 * Automatically selects Gemini when:
 * - DREAM_PROVIDER=gemini, or
 * - GOOGLE_API_KEY is set and no OpenRouter key is available
 *
 * Model and API settings are configurable via environment variables:
 * - DREAM_MODEL: model override (default: same as QWEN_MODEL)
 * - DREAM_MAX_TOKENS: token limit override (default: 2048)
 * - DREAM_TEMPERATURE: temperature override (default: 0.3)
 * - DREAM_PROVIDER: "gemini" to force Gemini backend
 */
export function createDreamInference(config: DreamInferenceConfig): InferenceFunction {
  const dreamProvider = process.env.DREAM_PROVIDER;
  const googleApiKey = process.env.GOOGLE_API_KEY;

  // Use Gemini if explicitly requested or if Google key is available but OpenRouter isn't
  if (dreamProvider === 'gemini' || (googleApiKey && !config.apiKey)) {
    const gemini = new GeminiRoboticsInference({
      apiKey: googleApiKey || config.apiKey,
      model: config.model ?? process.env.GEMINI_MODEL ?? 'gemini-robotics-er-1.5-preview',
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

  const model = config.model
    ?? process.env.DREAM_MODEL
    ?? process.env.QWEN_MODEL
    ?? 'qwen/qwen-2.5-vl-72b-instruct';

  const maxTokens = config.maxTokens
    ?? (process.env.DREAM_MAX_TOKENS ? parseInt(process.env.DREAM_MAX_TOKENS, 10) : 2048);

  const temperature = config.temperature
    ?? (process.env.DREAM_TEMPERATURE ? parseFloat(process.env.DREAM_TEMPERATURE) : 0.3);

  const apiBaseUrl = config.apiBaseUrl
    ?? process.env.LOCAL_INFERENCE_URL
    ?? 'https://openrouter.ai/api/v1';

  const adapter = new CerebellumInference({
    apiKey: config.apiKey,
    model,
    maxTokens,
    temperature,
    timeoutMs: config.timeoutMs ?? 30000,
    supportsVision: false, // Dream engine is text-only
    apiBaseUrl,
  });

  return adapter.createInferenceFunction();
}
