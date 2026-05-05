// src/cartridge/methods.ts
// Cartridge method implementations. Each method is a thin wrapper around
// existing skillos_robot subsystems — the planner, SemanticLoop's latest
// SceneGraph, the reactive controller, the UDP transmitter.
//
// The current bodies are STUB implementations with explicit TODO markers
// pointing at the real integration sites. They return realistic shapes
// so an upstream caller can develop against the wire protocol while the
// real wiring lands incrementally.

import { ERR, makeError, makeResult, type CartridgeResult } from './protocol';
import { getRobotState } from './state';
import { Opcode, encodeFrame } from '../control/bytecode_compiler';

export interface MethodContext {
  /** Send a progress event to the caller. */
  emit: (data: Record<string, unknown>) => void;
  /** True if the upstream cancelled / disconnected mid-call. */
  cancelled: () => boolean;
}

export type MethodImpl = (
  args: Record<string, unknown>,
  ctx: MethodContext,
  reqId: string,
) => Promise<CartridgeResult>;

// ── navigate ──────────────────────────────────────────────────────
// TODO: integrate with src/brain/planning/planner.ts. The planner today
// is invoked synchronously from index.ts startup; needs to be refactored
// to accept a goal at runtime and emit progress events.
const navigate: MethodImpl = async (args, ctx, reqId) => {
  const goal = String(args.goal ?? '').trim();
  if (!goal) return makeError(reqId, ERR.INVALID_ARGS, 'navigate requires args.goal (string)');

  const timeoutS = typeof args.timeout_s === 'number' ? args.timeout_s : 60;
  const policy = args.policy === 'fast' ? 'fast' : 'safe';

  ctx.emit({ phase: 'planning', goal });
  // TODO: const plan = await planner.run({ goal, policy });
  // Stub: pretend planning takes 1 step and emit progress.
  await new Promise(r => setTimeout(r, 50));
  if (ctx.cancelled()) return makeError(reqId, ERR.INTERNAL, 'cancelled');

  ctx.emit({ phase: 'executing', steps: 1 });
  // TODO: const trace = await reactiveLoop.executePlan(plan, { timeoutS });
  // Stub: return a plausible result shape.
  return makeError(reqId, ERR.NOT_IMPLEMENTED,
    'navigate is scaffolded — wire to brain/planning/planner.ts and control/reactive_loop.ts');
};

// ── observe ───────────────────────────────────────────────────────
// TODO: read from the live SceneGraph instance held by SemanticLoop.
// Today SceneGraph is constructed inside the perception pipeline; needs
// to be exposed via a singleton or DI to be queryable from here.
const observe: MethodImpl = async (_args, _ctx, reqId) => {
  // TODO: const snapshot = sceneGraph.snapshot();
  // Stub: return a recognizable shape upstream developers can code against.
  return makeError(reqId, ERR.NOT_IMPLEMENTED,
    'observe is scaffolded — wire to brain/memory/scene_graph.ts (snapshot accessor needed)');
};

// ── describe ──────────────────────────────────────────────────────
// TODO: cache the most recent VLM textual output from SemanticLoop and
// return it. Or trigger a fresh VLM call against the current frame
// buffer (more authoritative, slower).
const describe: MethodImpl = async (_args, _ctx, reqId) => {
  return makeError(reqId, ERR.NOT_IMPLEMENTED,
    'describe is scaffolded — wire to brain/perception/semantic_loop.ts (latest VLM result accessor needed)');
};

// ── stop ──────────────────────────────────────────────────────────
// Emits STOP (opcode 0x07) directly over UDP. Bypasses the 20Hz reactive
// loop — the ESP32 firmware safety layer guarantees the motors halt
// within one tick (~50ms). Idempotent: sending STOP when already stopped
// is harmless.
const stop: MethodImpl = async (_args, _ctx, reqId) => {
  const { transmitter } = getRobotState();
  if (!transmitter) {
    return makeError(reqId, ERR.HARDWARE_UNAVAILABLE,
      'UDP transmitter not configured. Start adapter with --robot-host <ip> [--robot-port <n>].');
  }
  try {
    const frame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
    await transmitter.send(frame);
    return makeResult(reqId, { stopped: true, opcode: 'STOP', frame_bytes: frame.length });
  } catch (err) {
    return makeError(reqId, ERR.HARDWARE_UNAVAILABLE,
      `STOP transmit failed: ${(err as Error).message}`);
  }
};

// ── set_speed ─────────────────────────────────────────────────────
// TODO: update ReactiveController's speed cap. Should take effect within
// one tick (~50ms) since the controller reads its config each cycle.
const setSpeed: MethodImpl = async (args, _ctx, reqId) => {
  const max = String(args.max ?? '');
  if (!['slow', 'normal', 'fast'].includes(max)) {
    return makeError(reqId, ERR.INVALID_ARGS, 'set_speed.max must be slow|normal|fast');
  }
  // TODO: reactiveController.setSpeedCap(max);
  return makeError(reqId, ERR.NOT_IMPLEMENTED,
    'set_speed is scaffolded — wire to control/reactive_controller.ts (setSpeedCap helper)');
};

export const METHODS: Record<string, MethodImpl> = {
  navigate,
  observe,
  describe,
  stop,
  set_speed: setSpeed,
};
