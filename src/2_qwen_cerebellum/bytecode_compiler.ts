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
    pattern: /^FORWARD\s+(-?\d+)\s+(-?\d+)/i,
    compile: (m) => ({ opcode: Opcode.MOVE_FORWARD, paramLeft: clampByte(m[1]), paramRight: clampByte(m[2]) }),
  },
  {
    pattern: /^BACKWARD\s+(-?\d+)\s+(-?\d+)/i,
    compile: (m) => ({ opcode: Opcode.MOVE_BACKWARD, paramLeft: clampByte(m[1]), paramRight: clampByte(m[2]) }),
  },
  {
    pattern: /^TURN_LEFT\s+(-?\d+)\s+(-?\d+)/i,
    compile: (m) => ({ opcode: Opcode.TURN_LEFT, paramLeft: clampByte(m[1]), paramRight: clampByte(m[2]) }),
  },
  {
    pattern: /^TURN_RIGHT\s+(-?\d+)\s+(-?\d+)/i,
    compile: (m) => ({ opcode: Opcode.TURN_RIGHT, paramLeft: clampByte(m[1]), paramRight: clampByte(m[2]) }),
  },
  {
    pattern: /^ROTATE_CW\s+(-?\d+)\s+(-?\d+)/i,
    compile: (m) => ({ opcode: Opcode.ROTATE_CW, paramLeft: clampByte(m[1]), paramRight: clampByte(m[2]) }),
  },
  {
    pattern: /^ROTATE_CCW\s+(-?\d+)\s+(-?\d+)/i,
    compile: (m) => ({ opcode: Opcode.ROTATE_CCW, paramLeft: clampByte(m[1]), paramRight: clampByte(m[2]) }),
  },
  {
    pattern: /^STOP/i,
    compile: () => ({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 }),
  },
  {
    pattern: /^STATUS/i,
    compile: () => ({ opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 }),
  },
];

function clampByte(value: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(255, n));
}

/**
 * Normalize a text command: strip trailing punctuation, markdown formatting,
 * and replace commas with spaces for permissive parsing.
 */
function normalizeTextCommand(text: string): string {
  let normalized = text;
  // Strip markdown formatting (* and `) but preserve underscores in command names
  normalized = normalized.replace(/[*`]/g, '');
  // Replace commas with spaces
  normalized = normalized.replace(/,/g, ' ');
  // Strip trailing punctuation
  normalized = normalized.replace(/[.!?;]+$/, '');
  return normalized.trim();
}

// =============================================================================
// BytecodeCompiler
// =============================================================================

export interface CompilerStats {
  framesCompiled: number;
  grammarHits: number;
  fewshotHits: number;
  hostFallbacks: number;
  toolcallHits: number;
  failures: number;
}

// =============================================================================
// Tool Call → Opcode Mapping (for Gemini structured tool calling)
// =============================================================================

const TOOL_OPCODE_MAP: Record<string, number> = {
  move_forward: Opcode.MOVE_FORWARD,
  move_backward: Opcode.MOVE_BACKWARD,
  turn_left: Opcode.TURN_LEFT,
  turn_right: Opcode.TURN_RIGHT,
  rotate_cw: Opcode.ROTATE_CW,
  rotate_ccw: Opcode.ROTATE_CCW,
  stop: Opcode.STOP,
};

export class BytecodeCompiler {
  private mode: CompilationMode;
  private stats: CompilerStats = {
    framesCompiled: 0,
    grammarHits: 0,
    fewshotHits: 0,
    hostFallbacks: 0,
    toolcallHits: 0,
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

    // Mode 0: Tool call — Gemini outputs TOOLCALL:{...} via structured function calling
    const toolcallResult = this.tryParseToolCall(trimmed);
    if (toolcallResult) {
      this.stats.toolcallHits++;
      this.stats.framesCompiled++;
      logger.debug('Compiler', 'Tool call mode', { hex: formatHex(toolcallResult) });
      return toolcallResult;
    }

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
   * Create a STOP frame with optional holding torque.
   * holdTorque=false (default): freewheel — coils disabled
   * holdTorque=true: maintain position — coils stay energized
   */
  createStopFrame(holdTorque: boolean = false): Buffer {
    return encodeFrame({
      opcode: Opcode.STOP,
      paramLeft: holdTorque ? 1 : 0,
      paramRight: 0,
    });
  }

  /**
   * Get the system prompt for Qwen-VL that teaches it to output bytecode.
   */
  getSystemPrompt(goal: string): string {
    return BYTECODE_SYSTEM_PROMPT.replace('{{GOAL}}', goal);
  }

  /**
   * Get the system prompt for tool-calling VLMs (e.g. Gemini Robotics-ER).
   * Describes navigation using function names instead of hex bytecodes.
   */
  getToolCallingSystemPrompt(goal: string): string {
    return TOOL_CALLING_SYSTEM_PROMPT.replace('{{GOAL}}', goal);
  }

  /**
   * Get the system prompt for text-scene simulation (no video/images).
   * Describes the two-pass scene format and includes chain-of-thought,
   * few-shot examples, and explicit decision rules.
   */
  getTextSceneSystemPrompt(goal: string): string {
    return TEXT_SCENE_SYSTEM_PROMPT.replace('{{GOAL}}', goal);
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

  private tryParseToolCall(text: string): Buffer | null {
    if (!text.startsWith('TOOLCALL:')) return null;

    try {
      const json = JSON.parse(text.slice('TOOLCALL:'.length));
      const name = json.name as string;
      const args = json.args as Record<string, number> | undefined;

      const opcode = TOOL_OPCODE_MAP[name];
      if (opcode === undefined) return null;

      let paramLeft = 0;
      let paramRight = 0;

      if (args) {
        let rawL: number;
        let rawR: number;

        if (name === 'rotate_cw' || name === 'rotate_ccw') {
          rawL = args.degrees ?? 0;
          rawR = args.speed ?? 0;
        } else {
          rawL = args.speed_l ?? 0;
          rawR = args.speed_r ?? 0;
        }

        // Detect normalized 0-1 range: if both values are <= 1.0 and at least
        // one is fractional, scale to 0-255 (Gemini Robotics-ER sometimes
        // outputs normalized motor values instead of byte-range integers)
        if (rawL <= 1.0 && rawR <= 1.0 && (rawL % 1 !== 0 || rawR % 1 !== 0)) {
          rawL = rawL * 255;
          rawR = rawR * 255;
        }

        paramLeft = Math.max(0, Math.min(255, Math.round(rawL)));
        paramRight = Math.max(0, Math.min(255, Math.round(rawR)));
      }

      return encodeFrame({ opcode, paramLeft, paramRight });
    } catch {
      return null;
    }
  }

  private tryParseHex(text: string): Buffer | null {
    // Match exactly 6 hex bytes: "AA 01 64 64 CB FF"
    const hexPattern = /^([0-9A-Fa-f]{2}\s+){5}[0-9A-Fa-f]{2}$/;
    if (!hexPattern.test(text)) return null;

    const bytes = text.split(/\s+/).map(h => parseInt(h, 16));
    if (bytes.length !== FRAME_SIZE) return null;

    const buffer = Buffer.from(bytes);
    // Validate frame structure
    if (decodeFrame(buffer) === null) {
      // VLMs often get the checksum wrong — repair if structure is valid
      return this.tryRepairChecksum(buffer);
    }

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
    if (decodeFrame(buffer) === null) {
      return this.tryRepairChecksum(buffer);
    }

    return buffer;
  }

  /**
   * Attempt to repair a frame with correct start/end markers and valid opcode
   * but incorrect checksum. VLMs reliably produce correct opcodes and params
   * but frequently miscalculate the XOR checksum.
   */
  private tryRepairChecksum(buffer: Buffer): Buffer | null {
    if (buffer.length < FRAME_SIZE) return null;
    if (buffer[0] !== FRAME_START || buffer[5] !== FRAME_END) return null;

    const opcode = buffer[1];
    // Reject if opcode is not recognized
    if (!OPCODE_NAMES[opcode]) return null;

    const paramLeft = buffer[2];
    const paramRight = buffer[3];
    const correctChecksum = calculateChecksum(opcode, paramLeft, paramRight);

    logger.debug('Compiler', 'Repaired checksum', {
      opcode: OPCODE_NAMES[opcode],
      bad: `0x${buffer[4].toString(16).toUpperCase()}`,
      good: `0x${correctChecksum.toString(16).toUpperCase()}`,
    });

    return encodeFrame({ opcode, paramLeft, paramRight });
  }

  private tryParseTextCommand(text: string): Buffer | null {
    // Try each line of output
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
      const normalized = normalizeTextCommand(line);
      for (const { pattern, compile } of TEXT_COMMAND_PATTERNS) {
        const match = normalized.match(pattern);
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

const BYTECODE_SYSTEM_PROMPT = `You are a robot motor controller with video perception. You see through the robot's camera and output motor commands.

GOAL: {{GOAL}}

VIDEO INPUT: You receive a rolling sequence of camera frames (oldest→newest) representing the last few seconds of movement. This is effectively a short video clip.
- Compare frames to perceive your velocity, direction of travel, and momentum.
- Use parallax between frames to estimate depth and 3D spatial layout.
- If objects are growing larger across frames, you are approaching them.
- If the scene is shifting left, you are turning right (and vice versa).

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

NAVIGATION STRATEGY:
- If the path ahead is clear and the goal is visible, MOVE FORWARD.
- If the path ahead is blocked (wall, obstacle filling most of the view, or very dark/close surface), ROTATE to scan for the goal or a clear path. Do NOT move forward into walls.
- If you see the target object (e.g. the red cube), turn toward it and approach.
- STOP only when you have arrived at the goal (target object is very close and centered).

EXAMPLES:
- See clear path ahead → AA 01 80 80 01 FF
- Wall ahead, need to scan → AA 05 5A 80 DB FF
- See wall on left → AA 04 60 80 E4 FF
- See obstacle close, rotate to find path → AA 06 5A 80 DC FF
- Target visible on the right → AA 04 40 80 C4 FF
- Arrived at target (very close) → AA 07 00 00 07 FF
- Need to turn around → AA 05 B4 80 31 FF

Your response must be EXACTLY 6 hex bytes separated by spaces.`;

// =============================================================================
// Tool-Calling System Prompt (for Gemini Robotics-ER with function calling)
// =============================================================================

const TOOL_CALLING_SYSTEM_PROMPT = `You are a robot motor controller with video perception. You see through the robot's camera and control it by calling the available tool functions.

GOAL: {{GOAL}}

VIDEO INPUT: You receive a rolling sequence of camera frames (oldest→newest) representing the last few seconds of movement. This is effectively a short video clip.
- Compare frames to perceive your velocity, direction of travel, and momentum.
- Use parallax between frames to estimate depth and 3D spatial layout.
- If objects are growing larger across frames, you are approaching them.
- If the scene is shifting left, you are turning right (and vice versa).

OUTPUT: Call exactly ONE tool function per response. Choose the best action based on what you see.

AVAILABLE ACTIONS:
- move_forward(speed_l, speed_r) — Move forward. Use equal speeds (e.g. 128,128) for straight, different speeds for gentle curves.
- move_backward(speed_l, speed_r) — Move backward.
- turn_left(speed_l, speed_r) — Turn left using differential speed. speed_l < speed_r makes a left turn.
- turn_right(speed_l, speed_r) — Turn right using differential speed. speed_l > speed_r makes a right turn.
- rotate_cw(degrees, speed) — Rotate clockwise in place by the given degrees (0-180).
- rotate_ccw(degrees, speed) — Rotate counter-clockwise in place by the given degrees (0-180).
- stop() — Stop all motors. ONLY call this when you have arrived at the goal.

Speed values range 0-255. Use 80-180 for normal movement, 40-80 for slow/careful, 180-255 for fast.

NAVIGATION STRATEGY:
- If the path ahead is clear and the goal is forward, call move_forward with moderate speed (128,128).
- If you see the target object, turn toward it and approach. If it's slightly left, call turn_left. If right, call turn_right.
- If the target is directly ahead and close, call move_forward to approach it.
- If a wall or obstacle is blocking your path, call rotate_cw or rotate_ccw to scan for a clear path (try 45-90 degrees).
- If you are stuck (same view for many frames), call rotate_cw(90, 128) to find a new path.
- Call stop() ONLY when the target object is very large and centered in the frame (you have arrived).
- VARY your commands based on what you see. Do NOT repeat the same action if the scene is changing.

CRITICAL: Analyze each frame carefully. If the target is visible, navigate toward it. Different scenes require different actions.`;

// =============================================================================
// GBNF Grammar (for grammar-constrained decoding)
// =============================================================================

/**
 * GBNF grammar that forces the VLM to output exactly 6 hex bytes.
 * Use with llama.cpp or compatible servers that support grammar-constrained decoding.
 */
// =============================================================================
// ISA v1.1 — V2 Frame Format (8 bytes with sequence numbers + ACK)
// =============================================================================

export const FRAME_SIZE_V2 = 8;
export const ACK_FLAG = 0x01;
export const ACK_OPCODE = 0xFD;

// Add ACK to Opcode and OPCODE_NAMES (done via module augmentation below)
(Opcode as any).ACK = ACK_OPCODE;
(OPCODE_NAMES as any)[ACK_OPCODE] = 'ACK';

/**
 * V2 frame extends V1 with sequence number and flags.
 * Frame: [0xAA][SEQ][OPCODE][PARAM_L][PARAM_R][FLAGS][CHECKSUM][0xFF]
 *   0     1     2       3        4       5       6        7
 */
export interface BytecodeFrameV2 extends BytecodeFrame {
  sequenceNumber: number;  // 0-255, wrapping
  flags: number;           // bit 0 = ACK_REQUESTED
}

/**
 * Calculate checksum for a V2 frame (XOR of bytes 1-5).
 */
export function calculateChecksumV2(
  seq: number, opcode: number, paramLeft: number, paramRight: number, flags: number,
): number {
  return (seq ^ opcode ^ paramLeft ^ paramRight ^ flags) & 0xFF;
}

/**
 * Encode a V2 frame into an 8-byte Buffer.
 */
export function encodeFrameV2(frame: BytecodeFrameV2): Buffer {
  const seq = frame.sequenceNumber & 0xFF;
  const flags = frame.flags & 0xFF;
  const checksum = calculateChecksumV2(seq, frame.opcode, frame.paramLeft, frame.paramRight, flags);
  return Buffer.from([
    FRAME_START,
    seq,
    frame.opcode & 0xFF,
    frame.paramLeft & 0xFF,
    frame.paramRight & 0xFF,
    flags,
    checksum,
    FRAME_END,
  ]);
}

/**
 * Decode an 8-byte V2 frame Buffer into a BytecodeFrameV2.
 * Returns null if the buffer is invalid (wrong markers or checksum).
 */
export function decodeFrameV2(buffer: Buffer): BytecodeFrameV2 | null {
  if (buffer.length < FRAME_SIZE_V2) return null;
  if (buffer[0] !== FRAME_START || buffer[7] !== FRAME_END) return null;

  const seq = buffer[1];
  const opcode = buffer[2];
  const paramLeft = buffer[3];
  const paramRight = buffer[4];
  const flags = buffer[5];
  const expectedChecksum = calculateChecksumV2(seq, opcode, paramLeft, paramRight, flags);

  if (buffer[6] !== expectedChecksum) return null;

  return { opcode, paramLeft, paramRight, sequenceNumber: seq, flags };
}

/**
 * Auto-detect and decode either a V1 (6-byte) or V2 (8-byte) frame.
 * Returns a BytecodeFrameV2 in both cases (V1 frames get seq=0, flags=0).
 */
export function decodeFrameAuto(buffer: Buffer): BytecodeFrameV2 | null {
  if (buffer.length === FRAME_SIZE_V2) {
    const v2 = decodeFrameV2(buffer);
    if (v2) return v2;
  }
  if (buffer.length === FRAME_SIZE) {
    const v1 = decodeFrame(buffer);
    if (v1) return { ...v1, sequenceNumber: 0, flags: 0 };
  }
  // Try V2 first for buffers of other sizes, then V1
  if (buffer.length >= FRAME_SIZE_V2) {
    const v2 = decodeFrameV2(buffer);
    if (v2) return v2;
  }
  if (buffer.length >= FRAME_SIZE) {
    const v1 = decodeFrame(buffer);
    if (v1) return { ...v1, sequenceNumber: 0, flags: 0 };
  }
  return null;
}

// =============================================================================
// GBNF Grammar (for grammar-constrained decoding)
// =============================================================================

export const BYTECODE_GBNF_GRAMMAR = `root ::= hex-byte " " hex-byte " " hex-byte " " hex-byte " " hex-byte " " hex-byte
hex-byte ::= hex-digit hex-digit
hex-digit ::= [0-9A-Fa-f]`;

// =============================================================================
// Text-Scene System Prompt (for text-based dream simulation — no video/images)
// =============================================================================

const TEXT_SCENE_SYSTEM_PROMPT = `You are a robot motor controller. GOAL: {{GOAL}}

CRITICAL RULES (read first):
1. NEVER repeat the same action 3x when PROGRESS shows "stuck" or "receding" — CHANGE action.
2. NEVER call stop() unless target distance < 20cm.
3. NEVER move_forward when forward clearance < 15cm — rotate instead.
4. NEVER alternate CW/CCW rotations — if you rotated CW last frame, do NOT rotate CCW next.
5. When COLLISION WARNING appears, move_backward then rotate. When WALL NEARBY appears, forward is safe.

INPUT: Two sections per frame — SPATIAL ANALYSIS (numbers) then SCENE PERCEPTION (description).
Read SPATIAL ANALYSIS first: PROGRESS, CLEARANCE, OPTIONS tell you exactly what to do.

ACTIONS (call exactly ONE per response):
- move_forward(speed_l, speed_r) — Speed 0-255. Equal = straight.
- move_backward(speed_l, speed_r)
- turn_left(speed_l, speed_r) — speed_l < speed_r
- turn_right(speed_l, speed_r) — speed_l > speed_r
- rotate_cw(degrees, speed) — Clockwise 0-180deg
- rotate_ccw(degrees, speed) — Counter-clockwise 0-180deg
- stop() — ONLY when target < 20cm

DECISION RULES:
- PROGRESS "approaching" + target within 15deg -> move_forward (speed 180-220)
- PROGRESS "receding" or "stuck" -> CHANGE action immediately
- Target bearing > +15deg -> rotate_cw or turn_right to face it
- Target bearing < -15deg -> rotate_ccw or turn_left to face it
- Forward BLOCKED + target ahead -> rotate to go around obstacle
- Clearance > 100cm -> speed 180-220 | 50-100cm -> 120-180 | 20-50cm -> 80-120

EXAMPLES:
1. forward: 200cm clear, approaching, target +3deg -> move_forward(200,200)
2. forward: 150cm clear, stuck, target +45deg -> rotate_cw(40,100)
3. forward: 30cm BLOCKED, target +5deg 120cm -> rotate_cw(60,100)
4. forward: 25cm clear, approaching, target -2deg 22cm -> move_forward(80,80)`;
