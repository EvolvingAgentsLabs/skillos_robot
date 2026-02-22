/**
 * RoClaw Bytecode Compiler — The Neural Compiler
 *
 * Compiles VLM output into 6-byte binary frames for the ESP32-S3.
 * Three compilation modes:
 *   1. Grammar-constrained: Qwen outputs hex directly via GBNF grammar
 *   2. Few-shot: Qwen outputs hex via instinct prompting
 *   3. Host fallback: Qwen outputs text commands, host compiles to bytecode
 *
 * ISA v1: 13 opcodes, 6-byte frames
 * Frame: [0xAA] [OPCODE] [PARAM_L] [PARAM_R] [CHECKSUM] [0xFF]
 */

import { logger } from '../shared/logger';

// =============================================================================
// ISA v1 — Opcode Table
// =============================================================================

export const Opcode = {
  MOVE_FORWARD:  0x01,
  MOVE_BACKWARD: 0x02,
  TURN_LEFT:     0x03,
  TURN_RIGHT:    0x04,
  ROTATE_CW:     0x05,
  ROTATE_CCW:    0x06,
  STOP:          0x07,
  GET_STATUS:    0x08,
  SET_SPEED:     0x09,
  MOVE_STEPS:    0x0A,
  MOVE_STEPS_R:  0x0B,
  LED_SET:       0x10,
  RESET:         0xFE,
} as const;

export type OpcodeValue = typeof Opcode[keyof typeof Opcode];

export const OPCODE_NAMES: Record<number, string> = {
  0x01: 'MOVE_FORWARD',
  0x02: 'MOVE_BACKWARD',
  0x03: 'TURN_LEFT',
  0x04: 'TURN_RIGHT',
  0x05: 'ROTATE_CW',
  0x06: 'ROTATE_CCW',
  0x07: 'STOP',
  0x08: 'GET_STATUS',
  0x09: 'SET_SPEED',
  0x0A: 'MOVE_STEPS',
  0x0B: 'MOVE_STEPS_R',
  0x10: 'LED_SET',
  0xFE: 'RESET',
};

// =============================================================================
// Frame Constants
// =============================================================================

export const FRAME_START = 0xAA;
export const FRAME_END = 0xFF;
export const FRAME_SIZE = 6;

// =============================================================================
// Bytecode Frame
// =============================================================================

export interface BytecodeFrame {
  opcode: number;
  paramLeft: number;
  paramRight: number;
}

/**
 * Calculate checksum for a bytecode frame (XOR of bytes 1-3).
 */
export function calculateChecksum(opcode: number, paramLeft: number, paramRight: number): number {
  return (opcode ^ paramLeft ^ paramRight) & 0xFF;
}

/**
 * Encode a BytecodeFrame into a 6-byte Buffer ready for UDP transmission.
 */
export function encodeFrame(frame: BytecodeFrame): Buffer {
  const checksum = calculateChecksum(frame.opcode, frame.paramLeft, frame.paramRight);
  return Buffer.from([
    FRAME_START,
    frame.opcode & 0xFF,
    frame.paramLeft & 0xFF,
    frame.paramRight & 0xFF,
    checksum,
    FRAME_END,
  ]);
}

/**
 * Decode a 6-byte Buffer into a BytecodeFrame.
 * Returns null if the buffer is invalid (wrong markers or checksum).
 */
export function decodeFrame(buffer: Buffer): BytecodeFrame | null {
  if (buffer.length < FRAME_SIZE) return null;
  if (buffer[0] !== FRAME_START || buffer[5] !== FRAME_END) return null;

  const opcode = buffer[1];
  const paramLeft = buffer[2];
  const paramRight = buffer[3];
  const expectedChecksum = calculateChecksum(opcode, paramLeft, paramRight);

  if (buffer[4] !== expectedChecksum) return null;

  return { opcode, paramLeft, paramRight };
}

/**
 * Format a Buffer as a hex string for logging (e.g., "AA 01 64 64 CB FF").
 */
export function formatHex(buffer: Buffer): string {
  return Array.from(buffer)
    .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

// =============================================================================
// Compilation Modes
// =============================================================================

export type CompilationMode = 'grammar' | 'fewshot' | 'host';

/**
 * Text command patterns for host-fallback mode.
 * Maps human-readable commands to bytecode frames.
 */
const TEXT_COMMAND_PATTERNS: Array<{
  pattern: RegExp;
  compile: (match: RegExpMatchArray) => BytecodeFrame;
}> = [
  {
    pattern: /^FORWARD\s+(-?\d+)\s+(-?\d+)$/i,
    compile: (m) => ({ opcode: Opcode.MOVE_FORWARD, paramLeft: clampByte(m[1]), paramRight: clampByte(m[2]) }),
  },
  {
    pattern: /^BACKWARD\s+(-?\d+)\s+(-?\d+)$/i,
    compile: (m) => ({ opcode: Opcode.MOVE_BACKWARD, paramLeft: clampByte(m[1]), paramRight: clampByte(m[2]) }),
  },
  {
    pattern: /^TURN_LEFT\s+(-?\d+)\s+(-?\d+)$/i,
    compile: (m) => ({ opcode: Opcode.TURN_LEFT, paramLeft: clampByte(m[1]), paramRight: clampByte(m[2]) }),
  },
  {
    pattern: /^TURN_RIGHT\s+(-?\d+)\s+(-?\d+)$/i,
    compile: (m) => ({ opcode: Opcode.TURN_RIGHT, paramLeft: clampByte(m[1]), paramRight: clampByte(m[2]) }),
  },
  {
    pattern: /^ROTATE_CW\s+(-?\d+)\s+(-?\d+)$/i,
    compile: (m) => ({ opcode: Opcode.ROTATE_CW, paramLeft: clampByte(m[1]), paramRight: clampByte(m[2]) }),
  },
  {
    pattern: /^ROTATE_CCW\s+(-?\d+)\s+(-?\d+)$/i,
    compile: (m) => ({ opcode: Opcode.ROTATE_CCW, paramLeft: clampByte(m[1]), paramRight: clampByte(m[2]) }),
  },
  {
    pattern: /^STOP$/i,
    compile: () => ({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 }),
  },
  {
    pattern: /^STATUS$/i,
    compile: () => ({ opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 }),
  },
];

function clampByte(value: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(255, n));
}

// =============================================================================
// BytecodeCompiler
// =============================================================================

export interface CompilerStats {
  framesCompiled: number;
  grammarHits: number;
  fewshotHits: number;
  hostFallbacks: number;
  failures: number;
}

export class BytecodeCompiler {
  private mode: CompilationMode;
  private stats: CompilerStats = {
    framesCompiled: 0,
    grammarHits: 0,
    fewshotHits: 0,
    hostFallbacks: 0,
    failures: 0,
  };

  constructor(mode: CompilationMode = 'fewshot') {
    this.mode = mode;
  }

  /**
   * Compile VLM output text into a bytecode Buffer.
   * Tries modes in priority order: grammar > fewshot > host fallback.
   */
  compile(vlmOutput: string): Buffer | null {
    const trimmed = vlmOutput.trim();

    // Mode 1: Grammar-constrained — VLM outputs raw hex like "AA 01 64 64 CB FF"
    const hexResult = this.tryParseHex(trimmed);
    if (hexResult) {
      this.stats.grammarHits++;
      this.stats.framesCompiled++;
      logger.debug('Compiler', 'Grammar mode', { hex: formatHex(hexResult) });
      return hexResult;
    }

    // Mode 2: Few-shot — VLM outputs hex possibly with extra text
    const fewshotResult = this.tryExtractHex(trimmed);
    if (fewshotResult) {
      this.stats.fewshotHits++;
      this.stats.framesCompiled++;
      logger.debug('Compiler', 'Few-shot mode', { hex: formatHex(fewshotResult) });
      return fewshotResult;
    }

    // Mode 3: Host fallback — VLM outputs text commands like "FORWARD 100 100"
    const hostResult = this.tryParseTextCommand(trimmed);
    if (hostResult) {
      this.stats.hostFallbacks++;
      this.stats.framesCompiled++;
      logger.debug('Compiler', 'Host fallback', { hex: formatHex(hostResult) });
      return hostResult;
    }

    this.stats.failures++;
    logger.warn('Compiler', 'Failed to compile VLM output', { output: trimmed.slice(0, 100) });
    return null;
  }

  /**
   * Create a bytecode frame from explicit parameters.
   */
  createFrame(opcode: OpcodeValue, paramLeft: number = 0, paramRight: number = 0): Buffer {
    return encodeFrame({ opcode, paramLeft, paramRight });
  }

  /**
   * Get the system prompt for Qwen-VL that teaches it to output bytecode.
   */
  getSystemPrompt(goal: string): string {
    return BYTECODE_SYSTEM_PROMPT.replace('{{GOAL}}', goal);
  }

  getStats(): CompilerStats {
    return { ...this.stats };
  }

  getMode(): CompilationMode {
    return this.mode;
  }

  setMode(mode: CompilationMode): void {
    this.mode = mode;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private tryParseHex(text: string): Buffer | null {
    // Match exactly 6 hex bytes: "AA 01 64 64 CB FF"
    const hexPattern = /^([0-9A-Fa-f]{2}\s+){5}[0-9A-Fa-f]{2}$/;
    if (!hexPattern.test(text)) return null;

    const bytes = text.split(/\s+/).map(h => parseInt(h, 16));
    if (bytes.length !== FRAME_SIZE) return null;

    const buffer = Buffer.from(bytes);
    // Validate frame structure
    if (decodeFrame(buffer) === null) return null;

    return buffer;
  }

  private tryExtractHex(text: string): Buffer | null {
    // Find 6 consecutive hex bytes anywhere in the text
    const hexPattern = /([0-9A-Fa-f]{2}(?:\s+[0-9A-Fa-f]{2}){5})/;
    const match = text.match(hexPattern);
    if (!match) return null;

    const bytes = match[1].split(/\s+/).map(h => parseInt(h, 16));
    if (bytes.length !== FRAME_SIZE) return null;

    const buffer = Buffer.from(bytes);
    if (decodeFrame(buffer) === null) return null;

    return buffer;
  }

  private tryParseTextCommand(text: string): Buffer | null {
    // Try each line of output
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
      for (const { pattern, compile } of TEXT_COMMAND_PATTERNS) {
        const match = line.match(pattern);
        if (match) {
          return encodeFrame(compile(match));
        }
      }
    }

    return null;
  }
}

// =============================================================================
// System Prompt for Qwen-VL
// =============================================================================

const BYTECODE_SYSTEM_PROMPT = `You are a robot motor controller. You see through the robot's camera and output motor commands.

GOAL: {{GOAL}}

FRAMES: You receive the last few camera frames in chronological order (oldest first). Use the visual differences between frames to understand your motion and trajectory.

OUTPUT FORMAT: Output ONLY a 6-byte hex command. Nothing else. No explanation.

COMMAND REFERENCE:
AA 01 LL RR CC FF  — Move forward (LL=left speed, RR=right speed, 00-FF)
AA 02 LL RR CC FF  — Move backward
AA 03 LL RR CC FF  — Turn left (differential)
AA 04 LL RR CC FF  — Turn right (differential)
AA 05 DD SS CC FF  — Rotate clockwise (DD=degrees, SS=speed)
AA 06 DD SS CC FF  — Rotate counter-clockwise
AA 07 00 00 07 FF  — Stop

CC = checksum (XOR of bytes 1-3)

EXAMPLES:
- See clear path ahead → AA 01 80 80 01 FF
- See wall on left → AA 04 60 80 E4 FF
- See obstacle close → AA 07 00 00 07 FF
- Need to turn around → AA 05 B4 80 21 FF

Your response must be EXACTLY 6 hex bytes separated by spaces.`;

// =============================================================================
// GBNF Grammar (for grammar-constrained decoding)
// =============================================================================

/**
 * GBNF grammar that forces the VLM to output exactly 6 hex bytes.
 * Use with llama.cpp or compatible servers that support grammar-constrained decoding.
 */
export const BYTECODE_GBNF_GRAMMAR = `root ::= hex-byte " " hex-byte " " hex-byte " " hex-byte " " hex-byte " " hex-byte
hex-byte ::= hex-digit hex-digit
hex-digit ::= [0-9A-Fa-f]`;
