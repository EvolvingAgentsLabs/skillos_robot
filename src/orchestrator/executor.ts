// src/orchestrator/executor.ts
// The ISA execution loop for the robot orchestrator.
// TypeScript port of llm_os/v3/kernel/executor.js.
//
// The LLM is the CPU. The executor is the OS. The cartridge is the hardware.
// The orchestrator sits ABOVE the existing dual-loop motor control and
// gives the robot a conversational, adaptive brain.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../shared/logger';
import { parseOpcode, formatResult, formatAck, STOP_SEQUENCES } from './dispatch';
import type { ParsedOpcode, CallOpcode } from './dispatch';
import type { OpenRouterBackend, ChatMessage, GenerateOptions } from './backend';
import type { IOAdapter } from './io';
import { METHODS, type MethodContext } from '../cartridge/methods';
import type { CartridgeResult } from '../cartridge/protocol';
import manifest from './manifest.json';

// ── Types ───────────────────────────────────────────────────────

export interface IOHandler {
  read?: (len: number) => Promise<unknown>;
  write?: (payload: Record<string, unknown>) => Promise<void>;
  wait?: () => Promise<unknown>;
}

export interface ExecutorConfig {
  /** The OpenRouter backend for LLM generation. */
  backend: OpenRouterBackend;
  /** The user's task / initial instruction. */
  task: string;
  /** Max total opcodes before forced halt. Default: 200. */
  maxSteps?: number;
  /** Max iterations per loop opcode. Default: 50. */
  maxLoopIterations?: number;
  /** Navigation wait timeout in ms. Default: 5000 (5s) in demo, 120000 (120s) with hardware. */
  navWaitTimeoutMs?: number;
  /** I/O adapter for speak/listen (fd=4, fd=5). */
  ioAdapter?: IOAdapter;
  /** Custom I/O handlers keyed by "fd:N" or "robot.method". */
  ioHandlers?: Record<string, IOHandler | ((method: string, args: Record<string, unknown>) => Promise<unknown>)>;
  /** Callback for each opcode parsed. */
  onOpcode?: (op: ParsedOpcode, step: number) => void;
  /** Callback for each result injected. */
  onResult?: (result: unknown, step: number) => void;
  /** Callback for think blocks. */
  onThink?: (text: string, step: number) => void;
}

export interface TraceEntry {
  step: number;
  type: string;
  raw?: string;
  parsed?: ParsedOpcode;
  detail?: string;
  goal?: string;
  note?: string;
}

export interface ExecutionResult {
  status: string | null;
  steps: number;
  trace: TraceEntry[];
  state: Record<string, unknown>;
}

// ── Executor ────────────────────────────────────────────────────

export class Executor {
  private backend: OpenRouterBackend;
  private task: string;
  private maxSteps: number;
  private maxLoopIterations: number;
  private navWaitTimeoutMs: number;
  private ioAdapter: IOAdapter | undefined;
  private ioHandlers: Record<string, IOHandler | ((method: string, args: Record<string, unknown>) => Promise<unknown>)>;
  private onOpcode: ExecutorConfig['onOpcode'];
  private onResult: ExecutorConfig['onResult'];
  private onThink: ExecutorConfig['onThink'];

  // Execution state
  private committedState = new Map<string, unknown>();
  private messages: ChatMessage[] = [];
  private stepCount = 0;
  private loopStack: Array<{ goal: string; startMsgIdx: number; iterations: number }> = [];
  private halted = false;
  private haltStatus: string | null = null;
  private trace: TraceEntry[] = [];

  // Navigation wait promise — resolved by VisionLoop arrival/stuck events
  private navWaitResolve: ((data: unknown) => void) | null = null;

  constructor(config: ExecutorConfig) {
    this.backend = config.backend;
    this.task = config.task;
    this.maxSteps = config.maxSteps ?? 200;
    this.maxLoopIterations = config.maxLoopIterations ?? 50;
    this.navWaitTimeoutMs = config.navWaitTimeoutMs ?? 5000;
    this.ioAdapter = config.ioAdapter;
    this.ioHandlers = config.ioHandlers ?? {};
    this.onOpcode = config.onOpcode;
    this.onResult = config.onResult;
    this.onThink = config.onThink;

    // Wire default fd handlers for speech I/O and navigation
    this.wireDefaultHandlers();
  }

  // ---------------------------------------------------------------------------
  // System prompt
  // ---------------------------------------------------------------------------

  private buildSystemPrompt(): string {
    const methodDescriptions = Object.entries(manifest.methods)
      .map(([name, meta]) => {
        const examples = (meta.opcodes || []).join('\n    ');
        return `  ${name}: ${meta.summary}\n    ${examples}`;
      })
      .join('\n\n');

    const ioPortDescriptions = Object.entries(manifest.io_ports || {})
      .map(([port, desc]) => `  ${port}: ${desc}`)
      .join('\n');

    const committedStr = this.committedState.size > 0
      ? JSON.stringify(Object.fromEntries(this.committedState))
      : '(empty)';

    return `You are the robot's high-level brain. You execute tasks by emitting ISA opcodes.

You emit ONE opcode per turn. After each opcode you receive a result or ack. Then emit the next opcode.

CRITICAL: All JSON arguments MUST use double-quoted keys. Write {"goal":"kitchen"} NOT {goal: "kitchen"}.

## ISA opcodes

  <|call|>robot.method {"key":"value"}<|/call|>   -- call a robot method (result follows)
  <|read|>fd=N len=N                               -- read from I/O port (result follows)
  <|write|>fd=N {"key":"value"}                    -- write to I/O port (ack follows)
  <|wait|>fd=N                                     -- block on fd until event (result follows)
  <|loop|>goal=label                               -- enter loop
  <|break|>                                        -- exit loop
  <|halt|>status=success|failure|partial            -- end program (depth 0 only)
  <|think|>reasoning<|/think|>                     -- inner monologue (no side effects)
  <|commit|>{"key":"value"}                        -- persist state
  <|fork|>goal=label                               -- spawn subtask (logged only)
  <|yield|>                                        -- yield CPU
  <|fault|>{"error":"msg"}                         -- raise exception (recovery follows)
  <|policy|>                                       -- query capabilities (result follows)

## Rules
1. Emit exactly ONE opcode per turn. No prose, no markdown, just the opcode.
2. <|halt|> only at loop depth 0.
3. Every <|loop|> needs a <|break|>.
4. JSON args must use double-quoted keys: {"goal":"kitchen"} not {goal: "kitchen"}.
5. After <|call|>robot.navigate, use <|wait|>fd=3 to block until arrival or stuck.
6. To speak: <|call|>robot.speak {"text":"..."}<|/call|> or <|write|>fd=5 {"text":"..."}
7. To listen: <|call|>robot.listen {}<|/call|> or <|read|>fd=4 len=1

## Available robot methods

${methodDescriptions}

## I/O ports

${ioPortDescriptions}

## Committed state
${committedStr}`;
  }

  // ---------------------------------------------------------------------------
  // Main execution loop
  // ---------------------------------------------------------------------------

  async run(): Promise<ExecutionResult> {
    this.messages = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: this.task },
    ];

    logger.info('Executor', `Starting ISA loop — task: "${this.task}"`);

    while (!this.halted && this.stepCount < this.maxSteps) {
      await this.step();
    }

    if (!this.halted) {
      this.haltStatus = 'max_steps_reached';
      logger.warn('Executor', `Max steps (${this.maxSteps}) reached, forcing halt`);
    }

    logger.info('Executor', `ISA loop ended — status: ${this.haltStatus}, steps: ${this.stepCount}`);

    return {
      status: this.haltStatus,
      steps: this.stepCount,
      trace: this.trace,
      state: Object.fromEntries(this.committedState),
    };
  }

  /**
   * Execute one ISA step: generate opcode → parse → dispatch → inject result.
   */
  async step(): Promise<void> {
    const genOpts: GenerateOptions = {
      maxTokens: 300,
      stop: STOP_SEQUENCES,
      temperature: 0.3,
    };

    const response = await this.backend.generate(this.messages, genOpts);
    let rawText = response.content.trim();

    // Retry on empty response
    if (!rawText) {
      for (let retry = 0; retry < 2; retry++) {
        this.messages.push({ role: 'user', content: 'Emit one ISA opcode now. No prose.' });
        const retryResp = await this.backend.generate(this.messages, genOpts);
        rawText = retryResp.content.trim();
        if (rawText) break;
      }
      if (!rawText) {
        this.trace.push({ step: this.stepCount, type: 'error', detail: 'empty response after retries' });
        this.halted = true;
        this.haltStatus = 'empty_response';
        return;
      }
    }

    const op = parseOpcode(rawText);
    this.stepCount++;
    this.trace.push({ step: this.stepCount, type: op.type, raw: rawText, parsed: op });

    if (op.think && this.onThink) this.onThink(op.think, this.stepCount);
    if (this.onOpcode) this.onOpcode(op, this.stepCount);

    // Compact conversation if it grows too long
    if (this.messages.length > 60) {
      this.compact(30);
    }

    switch (op.type) {
      case 'call':     await this.handleCall(op); break;
      case 'halt':     this.handleHalt(op); break;
      case 'read':     await this.handleRead(op); break;
      case 'write':    await this.handleWrite(op); break;
      case 'loop':     this.handleLoop(op); break;
      case 'break':    this.handleBreak(op); break;
      case 'commit':   this.handleCommit(op); break;
      case 'wait':     await this.handleWait(op); break;
      case 'fork':     this.handleFork(op); break;
      case 'fault':    this.handleFault(op); break;
      case 'policy':   this.handlePolicy(op); break;
      case 'yield':
        this.messages.push({ role: 'assistant', content: rawText });
        break;
      case 'think':
        this.messages.push({ role: 'assistant', content: rawText });
        this.messages.push({
          role: 'user',
          content: 'Good reasoning. Now emit exactly one ISA opcode.',
        });
        break;
      default:
        this.messages.push({ role: 'assistant', content: rawText });
        this.messages.push({
          role: 'user',
          content: 'Invalid output. Emit exactly ONE ISA opcode. Example: <|call|>robot.observe {}<|/call|>',
        });
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Opcode handlers
  // ---------------------------------------------------------------------------

  private async handleCall(op: CallOpcode): Promise<void> {
    if (op.cartridge !== 'robot') {
      const err = { error: `unknown cartridge: ${op.cartridge}` };
      this.injectResult(op.raw, err);
      return;
    }

    const methodImpl = METHODS[op.method];
    if (!methodImpl) {
      const err = { error: `unknown method: robot.${op.method}` };
      this.injectResult(op.raw, err);
      return;
    }

    // Build a MethodContext for the cartridge method
    const ctx: MethodContext = {
      emit: (data) => {
        logger.debug('Executor', `progress: ${JSON.stringify(data)}`);
        // If navigation arrived/stuck, resolve the fd=3 waiter
        if (data.phase === 'arrived' || data.phase === 'stuck') {
          if (this.navWaitResolve) {
            this.navWaitResolve({ event: data.phase, reason: data.reason });
            this.navWaitResolve = null;
          }
        }
      },
      cancelled: () => false,
    };

    try {
      const reqId = `isa-${this.stepCount}`;
      const result: CartridgeResult = await methodImpl(op.args, ctx, reqId);

      // Extract the payload from CartridgeResult
      const payload = result.ok ? result.result : result.error;
      this.injectResult(op.raw, payload);
    } catch (err) {
      this.injectResult(op.raw, { error: (err as Error).message });
    }
  }

  private handleHalt(op: ParsedOpcode): void {
    if (this.loopStack.length > 0) {
      this.messages.push({ role: 'assistant', content: op.raw });
      this.messages.push({
        role: 'user',
        content: formatResult({ error: 'halt inside loop is illegal, use <|break|> first' }),
      });
      return;
    }
    this.halted = true;
    this.haltStatus = (op as { status: string }).status;
    this.messages.push({ role: 'assistant', content: op.raw });
    logger.info('Executor', `Halted with status: ${this.haltStatus}`);
  }

  private async handleRead(op: ParsedOpcode): Promise<void> {
    const { fd, len } = op as { fd: number; len: number };
    const handler = this.ioHandlers[`fd:${fd}`] as IOHandler | undefined;
    let data: unknown;

    if (handler && typeof handler.read === 'function') {
      data = await handler.read(len);
    } else {
      data = { error: `no reader on fd=${fd}` };
    }

    this.injectResult(op.raw, data);
  }

  private async handleWrite(op: ParsedOpcode): Promise<void> {
    const { fd, payload } = op as { fd: number; payload: Record<string, unknown> };
    const handler = this.ioHandlers[`fd:${fd}`] as IOHandler | undefined;

    if (handler && typeof handler.write === 'function') {
      await handler.write(payload);
    }

    this.messages.push({ role: 'assistant', content: op.raw });
    this.messages.push({ role: 'user', content: formatAck() });
  }

  private handleLoop(op: ParsedOpcode): void {
    const { goal } = op as { goal: string };
    this.loopStack.push({
      goal,
      startMsgIdx: this.messages.length,
      iterations: 0,
    });
    this.messages.push({ role: 'assistant', content: op.raw });
  }

  private handleBreak(op: ParsedOpcode): void {
    if (this.loopStack.length === 0) {
      this.messages.push({ role: 'assistant', content: op.raw });
      this.messages.push({
        role: 'user',
        content: formatResult({ error: 'break outside loop is illegal' }),
      });
      return;
    }
    this.loopStack.pop();
    this.messages.push({ role: 'assistant', content: op.raw });
  }

  private handleCommit(op: ParsedOpcode): void {
    const { data } = op as { data: Record<string, unknown> };
    if (data && typeof data === 'object' && !('__parse_error' in data)) {
      for (const [k, v] of Object.entries(data)) {
        this.committedState.set(k, v);
      }
    }
    this.messages.push({ role: 'assistant', content: op.raw });
    // Rebuild system prompt with updated state
    this.messages[0] = { role: 'system', content: this.buildSystemPrompt() };
  }

  private async handleWait(op: ParsedOpcode): Promise<void> {
    const { fd } = op as { fd: number };
    const handler = this.ioHandlers[`fd:${fd}`] as IOHandler | undefined;
    let data: unknown;

    if (handler && typeof handler.wait === 'function') {
      data = await handler.wait();
    } else {
      data = { error: `no waiter on fd=${fd}` };
    }

    this.injectResult(op.raw, data);
  }

  private handleFork(op: ParsedOpcode): void {
    const { goal } = op as { goal: string };
    this.trace.push({
      step: this.stepCount,
      type: 'fork',
      goal,
      note: 'single-process mode: fork logged but not spawned',
    });
    this.messages.push({ role: 'assistant', content: op.raw });
  }

  private handleFault(op: ParsedOpcode): void {
    const { data } = op as { data: Record<string, unknown> };
    const result = { recovery: 'continue', fault: data };
    this.injectResult(op.raw, result);
  }

  private handlePolicy(op: ParsedOpcode): void {
    const capabilities: string[] = [];
    for (const method of Object.keys(METHODS)) {
      capabilities.push(`call.robot.${method}`);
    }
    capabilities.push('read', 'write', 'loop', 'break', 'halt', 'commit', 'think', 'fork', 'yield', 'fault', 'policy');

    const result = { allowed: capabilities };
    this.injectResult(op.raw, result);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private injectResult(assistantRaw: string, payload: unknown): void {
    const resultBlock = formatResult(payload);
    this.messages.push({ role: 'assistant', content: assistantRaw });
    this.messages.push({ role: 'user', content: resultBlock });
    if (this.onResult) this.onResult(payload, this.stepCount);
  }

  /**
   * Compact conversation history to stay within context limits.
   */
  private compact(keepLast = 30): void {
    if (this.messages.length <= keepLast + 2) return;

    const system = this.messages[0];
    const task = this.messages[1];
    const recent = this.messages.slice(-keepLast);

    system.content = this.buildSystemPrompt();
    this.messages = [system, task, ...recent];

    logger.debug('Executor', `Compacted conversation to ${this.messages.length} messages`);
  }

  /**
   * Wire default I/O handlers for fd=3 (nav), fd=4 (mic), fd=5 (speaker).
   */
  private wireDefaultHandlers(): void {
    // fd=3: Navigation events — wait blocks until arrival/stuck
    if (!this.ioHandlers['fd:3']) {
      this.ioHandlers['fd:3'] = {
        wait: () => new Promise<unknown>((resolve) => {
          // If VisionLoop emits arrival/stuck, the handleCall's ctx.emit
          // will call navWaitResolve. If no VisionLoop is registered,
          // resolve immediately with a simulated arrival.
          this.navWaitResolve = resolve;

          // Safety timeout: don't block forever if navigation never completes
          const timeoutMs = this.navWaitTimeoutMs;
          setTimeout(() => {
            if (this.navWaitResolve === resolve) {
              this.navWaitResolve = null;
              resolve({ event: 'timeout', reason: `navigation wait timed out after ${timeoutMs / 1000}s` });
            }
          }, timeoutMs);
        }),
        read: async () => ({ status: 'no navigation events pending' }),
      };
    }

    // fd=4: Microphone — reads user speech via IOAdapter
    if (!this.ioHandlers['fd:4'] && this.ioAdapter) {
      const adapter = this.ioAdapter;
      this.ioHandlers['fd:4'] = {
        read: async () => {
          const text = await adapter.listen();
          return { text, silence: text === '[silence]' };
        },
      };
    }

    // fd=5: Speaker — writes text via IOAdapter
    if (!this.ioHandlers['fd:5'] && this.ioAdapter) {
      const adapter = this.ioAdapter;
      this.ioHandlers['fd:5'] = {
        write: async (payload) => {
          const text = String(payload.text ?? '');
          if (text) await adapter.speak(text);
        },
      };
    }
  }

  /**
   * Resolve the navigation wait (called externally when VisionLoop
   * emits arrival or stuck, and there's no ctx.emit path).
   */
  resolveNavWait(data: unknown): void {
    if (this.navWaitResolve) {
      this.navWaitResolve(data);
      this.navWaitResolve = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Dataset export
  // ---------------------------------------------------------------------------

  /**
   * Export individual opcode→result pairs as separate training examples.
   * Each example is: system prompt + task + context window + one assistant turn.
   */
  exportStepDataset(contextWindow = 4): Array<{ messages: ChatMessage[]; metadata: Record<string, unknown> }> {
    const examples: Array<{ messages: ChatMessage[]; metadata: Record<string, unknown> }> = [];
    const systemMsg: ChatMessage = { role: 'system', content: this.buildSystemPrompt() };
    const userMsg: ChatMessage = { role: 'user', content: this.task };

    for (let i = 2; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.role !== 'assistant') continue;
      if (msg.content.includes('__parse_error')) continue;
      if (msg.content.includes('unknown')) continue;

      const contextStart = Math.max(2, i - contextWindow);
      const context = this.messages.slice(contextStart, i).map(m => ({
        role: m.role as ChatMessage['role'],
        content: m.content,
      }));

      examples.push({
        messages: [systemMsg, userMsg, ...context, { role: 'assistant', content: msg.content }],
        metadata: {
          step: Math.floor((i - 2) / 2) + 1,
          opcodeType: msg.content.match(/<\|(\w+)\|>/)?.[1] || 'unknown',
        },
      });
    }

    return examples;
  }

  /**
   * Export the full execution as a single training conversation.
   */
  exportDataset(): Array<{ messages: ChatMessage[]; metadata: Record<string, unknown> }> {
    const validOps = this.trace.filter(t => t.type !== 'unknown' && t.type !== 'error');
    if (validOps.length === 0) return [];

    const systemMsg: ChatMessage = { role: 'system', content: this.buildSystemPrompt() };
    const userMsg: ChatMessage = { role: 'user', content: this.task };

    const turns: ChatMessage[] = [];
    for (let i = 2; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.content?.includes('__parse_error')) continue;
      turns.push({ role: msg.role as ChatMessage['role'], content: msg.content });
    }

    if (turns.length === 0) return [];

    return [{
      messages: [systemMsg, userMsg, ...turns],
      metadata: {
        status: this.haltStatus,
        steps: this.stepCount,
        validOpcodes: validOps.length,
        totalOpcodes: this.trace.length,
      },
    }];
  }

  /**
   * Save step-level dataset to a JSONL file.
   */
  saveDataset(outputPath: string, contextWindow = 4): number {
    const examples = this.exportStepDataset(contextWindow);
    if (examples.length === 0) {
      logger.warn('Executor', 'No valid examples to export');
      return 0;
    }

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const lines = examples.map(e => JSON.stringify(e)).join('\n');
    fs.appendFileSync(outputPath, lines + '\n');

    logger.info('Executor', `Exported ${examples.length} step examples to ${outputPath}`);
    return examples.length;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getStepCount(): number { return this.stepCount; }
  getTrace(): TraceEntry[] { return [...this.trace]; }
  isHalted(): boolean { return this.halted; }
  getHaltStatus(): string | null { return this.haltStatus; }
}
