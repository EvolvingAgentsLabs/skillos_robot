// src/orchestrator/backend.ts
// OpenRouter backend for the ISA orchestrator.
// TypeScript port of llm_os/v3/kernel/backend_openrouter.js.
// Talks to any model via OpenRouter's chat completions API.
// Default: Gemma 4 26B-A4B for conversational orchestration.

import { logger } from '../shared/logger';

// ── Types ───────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  /** Override max tokens for this call. */
  maxTokens?: number;
  /** Override temperature for this call. */
  temperature?: number;
  /** Stop sequences to halt generation. */
  stop?: string[];
  /** JSON schema for structured output. */
  responseFormat?: { type: string; schema?: unknown };
}

export interface GenerateResult {
  content: string;
  finishReason: string;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface OpenRouterBackendConfig {
  /** OpenRouter API key (or reads from OPENROUTER_API_KEY env). */
  apiKey?: string;
  /** Model ID. Default: 'google/gemma-4-26b-a4b-it'. */
  model?: string;
  /** API base URL. Default: 'https://openrouter.ai/api/v1'. */
  baseUrl?: string;
  /** Default max tokens per generation. Default: 512. */
  maxTokens?: number;
  /** Default sampling temperature. Default: 0.3. */
  temperature?: number;
  /** Max retry attempts on transient failures. Default: 3. */
  maxRetries?: number;
}

// ── Backend ─────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterBackend {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly maxRetries: number;

  constructor(config: OpenRouterBackendConfig = {}) {
    this.apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || '';
    this.model = config.model || 'google/gemma-4-26b-a4b-it';
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.maxTokens = config.maxTokens || 512;
    this.temperature = config.temperature ?? 0.3;
    this.maxRetries = config.maxRetries ?? 3;

    if (!this.apiKey) {
      throw new Error(
        'OpenRouter API key required. Set OPENROUTER_API_KEY or pass config.apiKey',
      );
    }
  }

  getModel(): string {
    return this.model;
  }

  /**
   * Generate a completion from messages.
   * Retries on 5xx, 429, and transient network errors with linear backoff.
   */
  async generate(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: opts.maxTokens || this.maxTokens,
      temperature: opts.temperature ?? this.temperature,
    };

    if (opts.stop) {
      body.stop = opts.stop;
    }

    if (opts.responseFormat) {
      body.response_format = opts.responseFormat;
    }

    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://github.com/EvolvingAgentsLabs/skillos_robot',
      'X-Title': 'skillos_robot ISA Orchestrator',
    };
    const payload = JSON.stringify(body);

    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body: payload });

        if (!res.ok) {
          const text = await res.text();
          if (res.status >= 500 || res.status === 429) {
            lastErr = new Error(`OpenRouter ${res.status}: ${text}`);
            logger.warn('Backend', `Retryable error (attempt ${attempt + 1}/${this.maxRetries})`, {
              status: res.status,
            });
            await sleep(1000 * (attempt + 1));
            continue;
          }
          throw new Error(`OpenRouter ${res.status}: ${text}`);
        }

        const json = await res.json() as {
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          model?: string;
          usage?: Record<string, number>;
        };
        const choice = json.choices?.[0];

        if (!choice) {
          throw new Error(`OpenRouter returned no choices: ${JSON.stringify(json)}`);
        }

        return {
          content: choice.message?.content || '',
          finishReason: choice.finish_reason || 'unknown',
          model: json.model || this.model,
          usage: json.usage || {},
        };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const code = (err as NodeJS.ErrnoException).code;
        if (
          attempt < this.maxRetries - 1 &&
          (code === 'ECONNRESET' ||
            code === 'UND_ERR_CONNECT_TIMEOUT' ||
            lastErr.message.includes('fetch failed'))
        ) {
          logger.warn('Backend', `Network error, retrying (attempt ${attempt + 1}/${this.maxRetries})`, {
            code,
          });
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr!;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
