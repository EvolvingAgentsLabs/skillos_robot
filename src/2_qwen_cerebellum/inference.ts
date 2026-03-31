/**
 * RoClaw Inference Adapter — OpenRouter / Local VLM inference
 *
 * Supports both cloud (OpenRouter) and local (llama.cpp / vLLM) inference.
 * Provides vision-capable inference for the Cerebellum's motor control loop.
 */

import { logger } from '../shared/logger';
import { backoffMs, isRetryableError } from '../shared/retry';

// =============================================================================
// Types
// =============================================================================

/** Re-exported from llmunix-core for backward compatibility */
import type { InferenceFunction as _InferenceFunction } from '../llmunix-core/interfaces';
export type InferenceFunction = _InferenceFunction;

export interface InferenceConfig {
  /** OpenRouter API key (for cloud mode) */
  apiKey: string;
  /** Model identifier (e.g., 'qwen/qwen-2.5-vl-72b-instruct') */
  model: string;
  /** Max tokens for response (default: 64 — bytecode is tiny) */
  maxTokens: number;
  /** Temperature (default: 0.1 — deterministic motor control) */
  temperature: number;
  /** Timeout in ms (default: 5000 — fast responses required) */
  timeoutMs: number;
  /** Max retries on failure (default: 1) */
  maxRetries: number;
  /** Whether the model supports vision/images (default: true) */
  supportsVision: boolean;
  /** API base URL (default: OpenRouter; override for local inference) */
  apiBaseUrl: string;
}

const DEFAULT_CONFIG: InferenceConfig = {
  apiKey: '',
  model: 'qwen/qwen-2.5-vl-72b-instruct',
  maxTokens: 64,
  temperature: 0.1,
  timeoutMs: 5000,
  maxRetries: 1,
  supportsVision: true,
  apiBaseUrl: 'https://openrouter.ai/api/v1',
};

export interface InferenceStats {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  averageLatencyMs: number;
  totalLatencyMs: number;
}

// =============================================================================
// CerebellumInference
// =============================================================================

export class CerebellumInference {
  private config: InferenceConfig;
  private stats: InferenceStats = {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    averageLatencyMs: 0,
    totalLatencyMs: 0,
  };

  constructor(config: Partial<InferenceConfig> & { apiKey: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Create an InferenceFunction for use in the vision loop.
   */
  createInferenceFunction(): InferenceFunction {
    return async (
      systemPrompt: string,
      userMessage: string,
      images?: string[]
    ): Promise<string> => {
      return this.infer(systemPrompt, userMessage, images);
    };
  }

  /**
   * Call the inference API.
   */
  async infer(
    systemPrompt: string,
    userMessage: string,
    images?: string[]
  ): Promise<string> {
    this.stats.totalCalls++;
    const start = performance.now();

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const result = await this.callAPI(systemPrompt, userMessage, images);
        const latency = performance.now() - start;

        this.stats.successfulCalls++;
        this.stats.totalLatencyMs += latency;
        this.stats.averageLatencyMs = this.stats.totalLatencyMs / this.stats.successfulCalls;

        if (result.usage) {
          this.stats.promptTokens += result.usage.prompt_tokens || 0;
          this.stats.completionTokens += result.usage.completion_tokens || 0;
          this.stats.totalTokens += result.usage.total_tokens || 0;
        }

        logger.debug('Inference', `${Math.round(latency)}ms`, { model: this.config.model });
        return result.content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries && isRetryableError(error)) {
          const delay = backoffMs(attempt + 1);
          logger.debug('Inference', `Attempt ${attempt + 1} failed, retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        } else if (!isRetryableError(error)) {
          // Non-retryable (e.g. 400, 401, 403) — fail fast
          break;
        }
      }
    }

    this.stats.failedCalls++;
    throw lastError ?? new Error('Inference failed');
  }

  getStats(): InferenceStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      averageLatencyMs: 0,
      totalLatencyMs: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async callAPI(
    systemPrompt: string,
    userMessage: string,
    images?: string[]
  ): Promise<{ content: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: systemPrompt },
    ];

    // Build user message with optional images
    if (images && images.length > 0 && this.config.supportsVision) {
      const content: Array<Record<string, unknown>> = [
        { type: 'text', text: userMessage },
      ];

      for (const image of images) {
        const imageUrl = image.startsWith('data:')
          ? image
          : `data:image/jpeg;base64,${image}`;

        content.push({
          type: 'image_url',
          image_url: { url: imageUrl },
        });
      }

      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: userMessage });
    }

    // Build request
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    // OpenRouter-specific headers
    if (this.config.apiBaseUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://github.com/EvolvingAgentsLabs/RoClaw';
      headers['X-Title'] = 'RoClaw Cerebellum';
    }

    const body = JSON.stringify({
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.apiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        throw new Error(`API error ${response.status}: ${errorBody}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from inference API');
      }

      return { content, usage: data.usage };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createCerebellumInference(
  config: Partial<InferenceConfig> & { apiKey: string }
): InferenceFunction {
  const adapter = new CerebellumInference(config);
  return adapter.createInferenceFunction();
}

export function createCerebellumAdapter(
  config: Partial<InferenceConfig> & { apiKey: string }
): CerebellumInference {
  return new CerebellumInference(config);
}
