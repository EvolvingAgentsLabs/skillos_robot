/**
 * Ollama Inference Adapter — Local model inference via Ollama
 *
 * Drop-in replacement for GeminiRoboticsInference that calls a locally-hosted
 * model via Ollama's REST API. Used for deploying fine-tuned models (e.g.,
 * roclaw-nav:q8_0) without API costs.
 *
 * The BytecodeCompiler handles TOOLCALL parsing — this adapter just returns
 * raw text from the model.
 */

import { logger } from '../shared/logger';
import type { InferenceFunction } from '../llmunix-core/interfaces';
import type { InferenceStats } from './inference';

// =============================================================================
// Types
// =============================================================================

export interface OllamaInferenceConfig {
  /** Ollama API base URL (default: http://localhost:11434) */
  baseUrl?: string;
  /** Model name (default: roclaw-nav:q8_0) */
  model?: string;
  /** Temperature (default: 0.1) */
  temperature?: number;
  /** Max tokens to generate (default: 128) */
  maxTokens?: number;
  /** Timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Max retries on failure (default: 1) */
  maxRetries?: number;
}

// =============================================================================
// OllamaInference
// =============================================================================

export class OllamaInference {
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private timeoutMs: number;
  private maxRetries: number;
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

  constructor(config: OllamaInferenceConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.model = config.model ?? 'roclaw-nav:q8_0';
    this.temperature = config.temperature ?? 0.1;
    this.maxTokens = config.maxTokens ?? 128;
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.maxRetries = config.maxRetries ?? 1;
  }

  /**
   * Create an InferenceFunction compatible with VisionLoop and DreamInferenceRouter.
   * Same signature as GeminiRoboticsInference — drop-in replacement.
   */
  createInferenceFunction(): InferenceFunction {
    return async (
      systemPrompt: string,
      userMessage: string,
      _images?: string[],
    ): Promise<string> => {
      return this.infer(systemPrompt, userMessage);
    };
  }

  /**
   * Call the Ollama inference API.
   */
  async infer(systemPrompt: string, userMessage: string): Promise<string> {
    this.stats.totalCalls++;
    const start = performance.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.callAPI(systemPrompt, userMessage);
        const latency = performance.now() - start;

        this.stats.successfulCalls++;
        this.stats.totalLatencyMs += latency;
        this.stats.averageLatencyMs = this.stats.totalLatencyMs / this.stats.successfulCalls;

        if (result.promptTokens) this.stats.promptTokens += result.promptTokens;
        if (result.completionTokens) this.stats.completionTokens += result.completionTokens;
        this.stats.totalTokens += (result.promptTokens ?? 0) + (result.completionTokens ?? 0);

        logger.debug('OllamaInference', `${Math.round(latency)}ms`, { model: this.model });
        return result.content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }

    this.stats.failedCalls++;
    throw lastError ?? new Error('Ollama inference failed');
  }

  getStats(): InferenceStats {
    return { ...this.stats };
  }

  getModel(): string {
    return this.model;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async callAPI(
    systemPrompt: string,
    userMessage: string,
  ): Promise<{ content: string; promptTokens?: number; completionTokens?: number }> {
    const url = `${this.baseUrl}/api/generate`;

    // Ollama /api/generate format
    const body = {
      model: this.model,
      system: systemPrompt,
      prompt: userMessage,
      stream: false,
      options: {
        temperature: this.temperature,
        num_predict: this.maxTokens,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        throw new Error(`Ollama API error ${response.status}: ${errorBody}`);
      }

      const data = await response.json() as {
        response: string;
        done: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
      };

      if (!data.response) {
        throw new Error('Empty response from Ollama');
      }

      return {
        content: data.response.trim(),
        promptTokens: data.prompt_eval_count,
        completionTokens: data.eval_count,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createOllamaInference(config?: OllamaInferenceConfig): InferenceFunction {
  const adapter = new OllamaInference(config);
  return adapter.createInferenceFunction();
}
