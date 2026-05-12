// src/orchestrator/dispatch.ts
// Parse ISA opcodes from generated text into structured records.
// TypeScript port of llm_os/v3/kernel/dispatch.js — handles all 14 opcodes.

// ── Opcode regexes ──────────────────────────────────────────────
// Each opcode is a line-oriented pattern. The model emits one opcode
// per generation step; the kernel parses it and dispatches.

const CALL_RE    = /<\|call\|>([a-zA-Z_][\w-]*)\.([a-zA-Z_][\w-]*)\s*([\s\S]*?)\s*<\|\/call\|>/;
const HALT_RE    = /<\|halt\|>status=(\w+)/;
const THINK_RE   = /<\|think\|>([\s\S]*?)<\|\/think\|>/;
const READ_RE    = /<\|read\|>fd=(\d+)\s+len=(\d+)/;
const WRITE_RE   = /<\|write\|>fd=(\d+)\s+([\s\S]*)/;
const LOOP_RE    = /<\|loop\|>goal=(\S+)/;
const BREAK_RE   = /<\|break\|>/;
const FORK_RE    = /<\|fork\|>goal=(\S+)/;
const YIELD_RE   = /<\|yield\|>/;
const WAIT_RE    = /<\|wait\|>fd=(\d+)/;
const COMMIT_RE  = /<\|commit\|>([\s\S]*)/;
const FAULT_RE   = /<\|fault\|>([\s\S]*)/;
const POLICY_RE  = /<\|policy\|>/;

// ── Types ───────────────────────────────────────────────────────

export type OpcodeType =
  | 'call' | 'halt' | 'think' | 'read' | 'write'
  | 'loop' | 'break' | 'fork' | 'yield' | 'wait'
  | 'commit' | 'fault' | 'policy' | 'unknown';

export interface BaseOpcode {
  type: OpcodeType;
  think: string | null;
  raw: string;
}

export interface CallOpcode extends BaseOpcode {
  type: 'call';
  cartridge: string;
  method: string;
  args: Record<string, unknown>;
}

export interface HaltOpcode extends BaseOpcode {
  type: 'halt';
  status: string;
}

export interface ReadOpcode extends BaseOpcode {
  type: 'read';
  fd: number;
  len: number;
}

export interface WriteOpcode extends BaseOpcode {
  type: 'write';
  fd: number;
  payload: Record<string, unknown>;
}

export interface LoopOpcode extends BaseOpcode {
  type: 'loop';
  goal: string;
}

export interface BreakOpcode extends BaseOpcode {
  type: 'break';
}

export interface ForkOpcode extends BaseOpcode {
  type: 'fork';
  goal: string;
}

export interface YieldOpcode extends BaseOpcode {
  type: 'yield';
}

export interface WaitOpcode extends BaseOpcode {
  type: 'wait';
  fd: number;
}

export interface CommitOpcode extends BaseOpcode {
  type: 'commit';
  data: Record<string, unknown>;
}

export interface FaultOpcode extends BaseOpcode {
  type: 'fault';
  data: Record<string, unknown>;
}

export interface PolicyOpcode extends BaseOpcode {
  type: 'policy';
}

export interface ThinkOpcode extends BaseOpcode {
  type: 'think';
}

export interface UnknownOpcode extends BaseOpcode {
  type: 'unknown';
}

export type ParsedOpcode =
  | CallOpcode | HaltOpcode | ThinkOpcode | ReadOpcode | WriteOpcode
  | LoopOpcode | BreakOpcode | ForkOpcode | YieldOpcode | WaitOpcode
  | CommitOpcode | FaultOpcode | PolicyOpcode | UnknownOpcode;

// ── Tolerant JSON parser ────────────────────────────────────────

/**
 * Parse JSON tolerantly — handles unquoted keys from models like Gemma 4
 * that emit {action: "drop"} instead of {"action": "drop"}.
 */
export function parseJSON(str: string): Record<string, unknown> {
  str = str.trim();
  if (!str) return {};
  // First try strict JSON
  try { return JSON.parse(str); } catch { /* continue */ }
  // Fix unquoted keys: word before colon -> quoted
  const fixed = str.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
  try { return JSON.parse(fixed); } catch { /* continue */ }
  // Fix single quotes -> double quotes
  const singleFixed = fixed.replace(/'/g, '"');
  try { return JSON.parse(singleFixed); } catch { /* continue */ }
  return { __parse_error: str };
}

// ── Opcode parser ───────────────────────────────────────────────

/**
 * Parse a single opcode from generated text.
 * Returns a structured record with type and parsed fields.
 */
export function parseOpcode(text: string): ParsedOpcode {
  const think = text.match(THINK_RE);
  const thinkContent = think ? think[1].trim() : null;

  // Try each opcode pattern in priority order

  const halt = text.match(HALT_RE);
  if (halt) {
    return { type: 'halt', status: halt[1], think: thinkContent, raw: text };
  }

  const call = text.match(CALL_RE);
  if (call) {
    const argsStr = call[3].trim();
    const args = argsStr.length ? parseJSON(argsStr) : {};
    return { type: 'call', cartridge: call[1], method: call[2], args, think: thinkContent, raw: text };
  }

  const read = text.match(READ_RE);
  if (read) {
    return { type: 'read', fd: parseInt(read[1], 10), len: parseInt(read[2], 10), think: thinkContent, raw: text };
  }

  const write = text.match(WRITE_RE);
  if (write) {
    const payloadStr = write[2].trim();
    const payload = payloadStr.length ? parseJSON(payloadStr) : {};
    return { type: 'write', fd: parseInt(write[1], 10), payload, think: thinkContent, raw: text };
  }

  const loop = text.match(LOOP_RE);
  if (loop) {
    return { type: 'loop', goal: loop[1], think: thinkContent, raw: text };
  }

  const brk = text.match(BREAK_RE);
  if (brk) {
    return { type: 'break', think: thinkContent, raw: text };
  }

  const fork = text.match(FORK_RE);
  if (fork) {
    return { type: 'fork', goal: fork[1], think: thinkContent, raw: text };
  }

  const yld = text.match(YIELD_RE);
  if (yld) {
    return { type: 'yield', think: thinkContent, raw: text };
  }

  const wait = text.match(WAIT_RE);
  if (wait) {
    return { type: 'wait', fd: parseInt(wait[1], 10), think: thinkContent, raw: text };
  }

  const commit = text.match(COMMIT_RE);
  if (commit) {
    const dataStr = commit[1].trim();
    const data = dataStr.length ? parseJSON(dataStr) : {};
    return { type: 'commit', data, think: thinkContent, raw: text };
  }

  const fault = text.match(FAULT_RE);
  if (fault) {
    const dataStr = fault[1].trim();
    const data = dataStr.length ? parseJSON(dataStr) : {};
    return { type: 'fault', data, think: thinkContent, raw: text };
  }

  const policy = text.match(POLICY_RE);
  if (policy) {
    return { type: 'policy', think: thinkContent, raw: text };
  }

  // If only a think block with no opcode, return it
  if (thinkContent) {
    return { type: 'think', think: thinkContent, raw: text };
  }

  return { type: 'unknown', think: null, raw: text };
}

// ── Result formatting ───────────────────────────────────────────

/** Format a result block for injection into the conversation. */
export function formatResult(payload: unknown): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `<|result|>${text}<|/result|>`;
}

/** Format an ack for write operations. */
export function formatAck(): string {
  return '<|ack|>';
}

/** Stop sequences for the backend — prevents model from generating past one opcode. */
export const STOP_SEQUENCES = [
  '<|result|>', '<|/result|>', '<|ack|>',
  '\n<|call|>', '\n<|read|>', '\n<|write|>', '\n<|halt|>',
  '\n<|loop|>', '\n<|break|>', '\n<|fork|>',
  '\n<|yield|>', '\n<|commit|>', '\n<|fault|>', '\n<|policy|>',
];
