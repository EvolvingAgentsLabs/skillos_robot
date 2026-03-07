/**
 * Dream Inference Router — Dual-mode inference for dream simulation
 *
 * During dreaming, the robot needs an inference backend to decide motor commands
 * based on text scene descriptions. This router supports two modes:
 *
 * 1. **Claude Simulator** — Uses Claude (via CerebellumInference / OpenRouter)
 *    to simulate what Gemini Robotics would output. This avoids needing real
 *    Gemini API credits during dream consolidation. Claude receives the same
 *    system prompt and text scene, and outputs bytecode or tool calls.
 *
 * 2. **Real Gemini** — Uses the actual GeminiRoboticsInference backend.
 *    More accurate but costs API credits.
 *
 * 3. **Dual Mode** — Runs both in parallel, logs agreement/disagreement.
 *    Useful for validating that Claude simulation matches Gemini behavior.
 *
 * All modes use text-only scenes (no images) since dream simulation doesn't
 * have a camera feed — scenes are described as text by TextSceneSimulator.
 */

import type { InferenceFunction } from '../../llmunix-core/interfaces';
import { CerebellumInference } from '../../2_qwen_cerebellum/inference';
import { GeminiRoboticsInference } from '../../2_qwen_cerebellum/gemini_robotics';

// =============================================================================
// Types
// =============================================================================

export type DreamInferenceMode = 'claude' | 'gemini' | 'dual';

export interface DreamInferenceRouterConfig {
  mode: DreamInferenceMode;
  /** OpenRouter API key for Claude simulator mode */
  openRouterApiKey?: string;
  /** Google API key for real Gemini mode */
  googleApiKey?: string;
  /** Claude model to use for simulation (default: claude-sonnet-4-20250514) */
  claudeModel?: string;
  /** Gemini model override */
  geminiModel?: string;
  /** Max tokens for motor control inference (default: 128) */
  maxTokens?: number;
  /** Temperature (default: 0.1) */
  temperature?: number;
  /** Timeout in ms (default: 15000) */
  timeoutMs?: number;
}

export interface DualInferenceResult {
  /** The primary response used for decision-making */
  primary: string;
  /** The secondary response (if dual mode) */
  secondary?: string;
  /** Which backend provided the primary response */
  primarySource: 'claude' | 'gemini';
  /** Whether both backends agreed (same opcode) */
  agreement?: boolean;
}

export interface InferenceStats {
  totalCalls: number;
  claudeCalls: number;
  geminiCalls: number;
  dualCalls: number;
  agreements: number;
  disagreements: number;
  errors: number;
  avgLatencyMs: number;
}

// =============================================================================
// System Prompt for Claude Simulating Gemini Robotics
// =============================================================================

const CLAUDE_GEMINI_SIMULATOR_PROMPT = `You are simulating a Gemini Robotics-ER vision-language model that controls a small differential-drive robot (RoClaw).

In this dream simulation, you receive TEXT descriptions of what the robot's camera sees (not actual images). You must output motor commands as if you were the Gemini Robotics-ER model.

OUTPUT FORMAT: Output EXACTLY one tool call in this format:
TOOLCALL:{"name":"<function_name>","args":{"speed_l":<0-255>,"speed_r":<0-255>}}

AVAILABLE FUNCTIONS:
- move_forward(speed_l, speed_r) — Move forward. Equal speeds = straight. Speed range 0-255.
- move_backward(speed_l, speed_r) — Move backward.
- turn_left(speed_l, speed_r) — Turn left (speed_l < speed_r).
- turn_right(speed_l, speed_r) — Turn right (speed_l > speed_r).
- rotate_cw(degrees, speed) — Rotate clockwise in place.
- rotate_ccw(degrees, speed) — Rotate counter-clockwise in place.
- stop() — Stop all motors. ONLY when arrived at the goal.

NAVIGATION STRATEGY:
- If the target is visible and ahead, move forward toward it.
- If the target is to the left, turn left. If to the right, turn right.
- If the path is blocked, rotate to find a clear path.
- If near a wall, turn away from it.
- If the target is very close and centered, call stop().
- Use moderate speeds (80-180) for normal movement, slower (40-80) near obstacles.

CRITICAL: Output ONLY the TOOLCALL line. No explanation, no reasoning, no extra text.`;

// =============================================================================
// Dream Inference Router
// =============================================================================

export class DreamInferenceRouter {
  private mode: DreamInferenceMode;
  private claudeInfer: InferenceFunction | null = null;
  private geminiInfer: InferenceFunction | null = null;
  private stats: InferenceStats = {
    totalCalls: 0,
    claudeCalls: 0,
    geminiCalls: 0,
    dualCalls: 0,
    agreements: 0,
    disagreements: 0,
    errors: 0,
    avgLatencyMs: 0,
  };
  private totalLatencyMs: number = 0;

  constructor(config: DreamInferenceRouterConfig) {
    this.mode = config.mode;

    const maxTokens = config.maxTokens ?? 128;
    const temperature = config.temperature ?? 0.1;
    const timeoutMs = config.timeoutMs ?? 15000;

    // Set up Claude simulator
    if (config.mode === 'claude' || config.mode === 'dual') {
      const apiKey = config.openRouterApiKey || process.env.OPENROUTER_API_KEY || '';
      if (!apiKey && !process.env.LOCAL_INFERENCE_URL) {
        throw new Error('Claude simulator mode requires OPENROUTER_API_KEY or LOCAL_INFERENCE_URL');
      }

      const claude = new CerebellumInference({
        apiKey,
        model: config.claudeModel ?? process.env.DREAM_CLAUDE_MODEL ?? 'anthropic/claude-sonnet-4',
        maxTokens,
        temperature,
        timeoutMs,
        supportsVision: false, // Text-only scenes
        apiBaseUrl: process.env.LOCAL_INFERENCE_URL ?? 'https://openrouter.ai/api/v1',
      });
      this.claudeInfer = claude.createInferenceFunction();
    }

    // Set up real Gemini
    if (config.mode === 'gemini' || config.mode === 'dual') {
      const googleKey = config.googleApiKey || process.env.GOOGLE_API_KEY || '';
      if (!googleKey) {
        throw new Error('Gemini mode requires GOOGLE_API_KEY');
      }

      const gemini = new GeminiRoboticsInference({
        apiKey: googleKey,
        model: config.geminiModel ?? process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
        maxOutputTokens: maxTokens,
        temperature,
        timeoutMs,
        thinkingBudget: 0, // Fast motor control, no deep thinking
        useToolCalling: true,
      });
      this.geminiInfer = gemini.createInferenceFunction();
    }
  }

  /** Get the active inference mode */
  getMode(): DreamInferenceMode {
    return this.mode;
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
      let result: string;

      switch (this.mode) {
        case 'claude': {
          result = await this.inferClaude(systemPrompt, sceneDescription);
          this.stats.claudeCalls++;
          break;
        }
        case 'gemini': {
          result = await this.inferGemini(systemPrompt, sceneDescription);
          this.stats.geminiCalls++;
          break;
        }
        case 'dual': {
          const dualResult = await this.inferDual(systemPrompt, sceneDescription);
          result = dualResult.primary;
          this.stats.dualCalls++;
          if (dualResult.agreement !== undefined) {
            if (dualResult.agreement) this.stats.agreements++;
            else this.stats.disagreements++;
          }
          break;
        }
      }

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
   * This wraps the router's dual-mode logic into the standard signature.
   */
  createInferenceFunction(): InferenceFunction {
    return async (systemPrompt: string, userMessage: string, _images?: string[]): Promise<string> => {
      return this.infer(systemPrompt, userMessage);
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async inferClaude(systemPrompt: string, scene: string): Promise<string> {
    if (!this.claudeInfer) throw new Error('Claude inference not configured');

    // Wrap the scene description in the Claude-as-Gemini simulator prompt
    const fullSystem = `${CLAUDE_GEMINI_SIMULATOR_PROMPT}\n\n${systemPrompt}`;
    return this.claudeInfer(fullSystem, scene);
  }

  private async inferGemini(systemPrompt: string, scene: string): Promise<string> {
    if (!this.geminiInfer) throw new Error('Gemini inference not configured');
    return this.geminiInfer(systemPrompt, scene);
  }

  private async inferDual(systemPrompt: string, scene: string): Promise<DualInferenceResult> {
    // Run both in parallel
    const [claudeResult, geminiResult] = await Promise.allSettled([
      this.claudeInfer ? this.inferClaude(systemPrompt, scene) : Promise.reject('not configured'),
      this.geminiInfer ? this.inferGemini(systemPrompt, scene) : Promise.reject('not configured'),
    ]);

    const claudeOk = claudeResult.status === 'fulfilled' ? claudeResult.value : null;
    const geminiOk = geminiResult.status === 'fulfilled' ? geminiResult.value : null;

    // Primary = Gemini if available, else Claude
    const primary = geminiOk ?? claudeOk;
    if (!primary) {
      throw new Error('Both Claude and Gemini inference failed in dual mode');
    }

    // Check agreement (compare extracted opcode/function name)
    let agreement: boolean | undefined;
    if (claudeOk && geminiOk) {
      const claudeOp = this.extractOpName(claudeOk);
      const geminiOp = this.extractOpName(geminiOk);
      agreement = claudeOp === geminiOp;
    }

    return {
      primary,
      secondary: geminiOk ? claudeOk ?? undefined : geminiOk ?? undefined,
      primarySource: geminiOk ? 'gemini' : 'claude',
      agreement,
    };
  }

  /** Extract function name or opcode from VLM output for agreement checking */
  private extractOpName(output: string): string {
    // TOOLCALL format
    const toolMatch = output.match(/TOOLCALL:\{.*?"name"\s*:\s*"([^"]+)"/);
    if (toolMatch) return toolMatch[1];

    // Hex format — extract opcode byte (byte index 1)
    const hexMatch = output.match(/[0-9A-Fa-f]{2}\s+([0-9A-Fa-f]{2})/);
    if (hexMatch) return hexMatch[1].toUpperCase();

    return output.trim().slice(0, 20);
  }
}
