/**
 * Gemini Robotics-ER Inference Adapter
 *
 * Alternative inference backend using Google's Gemini API.
 * Supports:
 *   - Native structured tool calling (eliminates text-parsing fragility)
 *   - Thinking budget for deep analysis vs fast motor control
 *   - Same InferenceFunction signature as CerebellumInference (drop-in)
 *
 * Activates via GOOGLE_API_KEY env var + --gemini CLI flag.
 * No new npm dependencies — uses native fetch.
 */

import { logger } from '../shared/logger';
import type { InferenceFunction } from '../llmunix-core/interfaces';
import type { InferenceStats } from './inference';

// =============================================================================
// Types
// =============================================================================

export interface GeminiInferenceConfig {
  /** Google API key */
  apiKey: string;
  /** Model identifier (default: gemini-3-flash-preview) */
  model: string;
  /** Max output tokens (default: 64 — bytecode is tiny) */
  maxOutputTokens: number;
  /** Temperature (default: 0.1 — deterministic motor control) */
  temperature: number;
  /** Timeout in ms (default: 5000 — fast responses required) */
  timeoutMs: number;
  /** Max retries on failure (default: 1) */
  maxRetries: number;
  /** Thinking budget: 0 = fast motor loop, >0 = deep analysis */
  thinkingBudget: number;
  /** Enable structured tool calling */
  useToolCalling: boolean;
  /** Tool declarations for function calling */
  tools: GeminiToolDeclaration[];
  /** API base URL (default: Gemini REST endpoint) */
  apiBaseUrl: string;
}

export interface GeminiToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const DEFAULT_CONFIG: GeminiInferenceConfig = {
  apiKey: '',
  model: 'gemini-robotics-er-1.5-preview',
  maxOutputTokens: 1024,
  temperature: 0.1,
  timeoutMs: 10000,
  maxRetries: 1,
  thinkingBudget: 0,
  useToolCalling: false,
  tools: [],
  apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
};

// =============================================================================
// RoClaw Tool Declarations — Maps to ISA v1 opcodes
// =============================================================================

export const ROCLAW_TOOL_DECLARATIONS: GeminiToolDeclaration[] = [
  {
    name: 'move_forward',
    description: 'Move the robot forward with differential speed control',
    parameters: {
      type: 'object',
      properties: {
        speed_l: { type: 'number', description: 'Left motor speed (0-255)' },
        speed_r: { type: 'number', description: 'Right motor speed (0-255)' },
      },
      required: ['speed_l', 'speed_r'],
    },
  },
  {
    name: 'move_backward',
    description: 'Move the robot backward with differential speed control',
    parameters: {
      type: 'object',
      properties: {
        speed_l: { type: 'number', description: 'Left motor speed (0-255)' },
        speed_r: { type: 'number', description: 'Right motor speed (0-255)' },
      },
      required: ['speed_l', 'speed_r'],
    },
  },
  {
    name: 'turn_left',
    description: 'Turn the robot left using differential speed',
    parameters: {
      type: 'object',
      properties: {
        speed_l: { type: 'number', description: 'Left motor speed (0-255)' },
        speed_r: { type: 'number', description: 'Right motor speed (0-255)' },
      },
      required: ['speed_l', 'speed_r'],
    },
  },
  {
    name: 'turn_right',
    description: 'Turn the robot right using differential speed',
    parameters: {
      type: 'object',
      properties: {
        speed_l: { type: 'number', description: 'Left motor speed (0-255)' },
        speed_r: { type: 'number', description: 'Right motor speed (0-255)' },
      },
      required: ['speed_l', 'speed_r'],
    },
  },
  {
    name: 'rotate_cw',
    description: 'Rotate the robot clockwise by a number of degrees',
    parameters: {
      type: 'object',
      properties: {
        degrees: { type: 'number', description: 'Degrees to rotate (0-255)' },
        speed: { type: 'number', description: 'Rotation speed (0-255)' },
      },
      required: ['degrees', 'speed'],
    },
  },
  {
    name: 'rotate_ccw',
    description: 'Rotate the robot counter-clockwise by a number of degrees',
    parameters: {
      type: 'object',
      properties: {
        degrees: { type: 'number', description: 'Degrees to rotate (0-255)' },
        speed: { type: 'number', description: 'Rotation speed (0-255)' },
      },
      required: ['degrees', 'speed'],
    },
  },
  {
    name: 'stop',
    description: 'Stop all motors immediately',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// =============================================================================
// GeminiRoboticsInference
// =============================================================================

export class GeminiRoboticsInference {
  private config: GeminiInferenceConfig;
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

  constructor(config: Partial<GeminiInferenceConfig> & { apiKey: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Create an InferenceFunction for use in the vision loop.
   * Same signature as CerebellumInference — drop-in replacement.
   */
  createInferenceFunction(): InferenceFunction {
    return async (
      systemPrompt: string,
      userMessage: string,
      images?: string[],
    ): Promise<string> => {
      return this.infer(systemPrompt, userMessage, images);
    };
  }

  /**
   * Call the Gemini inference API.
   */
  async infer(
    systemPrompt: string,
    userMessage: string,
    images?: string[],
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
          this.stats.promptTokens += result.usage.promptTokens || 0;
          this.stats.completionTokens += result.usage.completionTokens || 0;
          this.stats.totalTokens += (result.usage.promptTokens || 0) + (result.usage.completionTokens || 0);
        }

        logger.debug('GeminiInference', `${Math.round(latency)}ms`, { model: this.config.model });
        return result.content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    this.stats.failedCalls++;
    throw lastError ?? new Error('Gemini inference failed');
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
    images?: string[],
  ): Promise<{ content: string; usage?: { promptTokens?: number; completionTokens?: number } }> {
    // Build content parts for the user message
    const parts: Array<Record<string, unknown>> = [];

    // Add images as inline data
    if (images && images.length > 0) {
      for (const image of images) {
        // Strip data URI prefix if present
        const base64Data = image.startsWith('data:')
          ? image.replace(/^data:image\/[^;]+;base64,/, '')
          : image;

        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: base64Data,
          },
        });
      }
    }

    // Add text part
    parts.push({ text: userMessage });

    // Build request body
    const body: Record<string, unknown> = {
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      generationConfig: {
        maxOutputTokens: this.config.maxOutputTokens,
        temperature: this.config.temperature,
      },
    };

    // Send thinkingConfig to control thinking behavior.
    // Models like gemini-2.5-flash think by default and can exhaust maxOutputTokens
    // on internal reasoning. Explicitly set budget=0 to disable thinking for motor control.
    // Skip only for flash-lite models that don't support the thinking API.
    const isLiteModel = this.config.model.includes('lite');
    if (this.config.thinkingBudget > 0 || !isLiteModel) {
      (body.generationConfig as Record<string, unknown>).thinkingConfig = {
        thinkingBudget: this.config.thinkingBudget,
      };
    }

    // Add tool declarations if enabled
    if (this.config.useToolCalling && this.config.tools.length > 0) {
      body.tools = [{
        functionDeclarations: this.config.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];
    }

    const url = `${this.config.apiBaseUrl}/models/${this.config.model}:generateContent?key=${this.config.apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        throw new Error(`Gemini API error ${response.status}: ${errorBody}`);
      }

      const data = await response.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              functionCall?: { name: string; args: Record<string, unknown> };
            }>;
          };
          finishReason?: string;
        }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
        };
      };

      const candidate = data.candidates?.[0];
      if (!candidate?.content?.parts?.length) {
        // Gemini Robotics-ER may exhaust maxOutputTokens on internal thinking
        // even with thinkingBudget=0, returning finishReason=MAX_TOKENS with no output
        const thoughtTokens = data.usageMetadata?.thoughtsTokenCount;
        if (candidate?.finishReason === 'MAX_TOKENS' && thoughtTokens) {
          throw new Error(`Gemini used ${thoughtTokens} thinking tokens, exhausting maxOutputTokens — increase maxOutputTokens`);
        }
        throw new Error('Empty response from Gemini API');
      }

      // Check for function call response
      const functionCallPart = candidate.content.parts.find(p => p.functionCall);
      if (functionCallPart?.functionCall) {
        const fc = functionCallPart.functionCall;
        return {
          content: `TOOLCALL:${JSON.stringify({ name: fc.name, args: fc.args })}`,
          usage: {
            promptTokens: data.usageMetadata?.promptTokenCount,
            completionTokens: data.usageMetadata?.candidatesTokenCount,
          },
        };
      }

      // Text response
      const textPart = candidate.content.parts.find(p => p.text);
      if (!textPart?.text) {
        throw new Error('No text or function call in Gemini response');
      }

      let content = textPart.text;

      // Gemini 2.x models may return tool calls as Python code:
      //   "tool_code\nprint(default_api.move_forward(speed_l=200, speed_r=200))"
      // Parse and convert to TOOLCALL format for the bytecode compiler.
      const pyCallMatch = content.match(/default_api\.(\w+)\(([^)]*)\)/);
      if (pyCallMatch) {
        const fnName = pyCallMatch[1];
        const argsStr = pyCallMatch[2];
        const args: Record<string, unknown> = {};
        for (const pair of argsStr.split(',')) {
          const [key, val] = pair.split('=').map(s => s.trim());
          if (key && val !== undefined) {
            args[key] = isNaN(Number(val)) ? val : Number(val);
          }
        }
        content = `TOOLCALL:${JSON.stringify({ name: fnName, args })}`;
      }

      return {
        content,
        usage: {
          promptTokens: data.usageMetadata?.promptTokenCount,
          completionTokens: data.usageMetadata?.candidatesTokenCount,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createGeminiInference(
  config: Partial<GeminiInferenceConfig> & { apiKey: string },
): InferenceFunction {
  const adapter = new GeminiRoboticsInference(config);
  return adapter.createInferenceFunction();
}
