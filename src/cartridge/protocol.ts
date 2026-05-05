// src/cartridge/protocol.ts
// Wire protocol between an upstream OS (llm_os / skillos_mini) and the
// robot cartridge adapter. JSON over WebSocket.
//
// Request/response are correlated by `id`. Progress events share the
// request `id` and may arrive between the request and final result.

export type CartridgeRequest = {
  id: string;
  type: 'call';
  cartridge: 'robot';
  method: string;
  args: Record<string, unknown>;
};

export type CartridgeResult =
  | { id: string; type: 'result'; ok: true;  result: unknown }
  | { id: string; type: 'result'; ok: false; error: { code: string; message: string } };

export type CartridgeProgress = {
  id: string;
  type: 'progress';
  data: Record<string, unknown>;
};

export type CartridgeMessage = CartridgeRequest | CartridgeResult | CartridgeProgress;

export const ERR = {
  UNKNOWN_METHOD: 'UNKNOWN_METHOD',
  INVALID_ARGS: 'INVALID_ARGS',
  TIMEOUT: 'TIMEOUT',
  HARDWARE_UNAVAILABLE: 'HARDWARE_UNAVAILABLE',
  REFLEX_VETO: 'REFLEX_VETO',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrCode = typeof ERR[keyof typeof ERR];

export function makeError(id: string, code: ErrCode, message: string): CartridgeResult {
  return { id, type: 'result', ok: false, error: { code, message } };
}

export function makeResult<T>(id: string, result: T): CartridgeResult {
  return { id, type: 'result', ok: true, result };
}

export function makeProgress(id: string, data: Record<string, unknown>): CartridgeProgress {
  return { id, type: 'progress', data };
}
