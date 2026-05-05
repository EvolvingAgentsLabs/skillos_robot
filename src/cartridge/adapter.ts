// src/cartridge/adapter.ts
// WebSocket server that exposes the robot as an llm_os-style cartridge.
// Listens for {type:call, cartridge:'robot', method, args} messages and
// dispatches to METHODS in ./methods.ts. Replies with {type:result}
// envelopes; emits {type:progress} events during long-running calls.

import { WebSocketServer, type WebSocket } from 'ws';
import { ERR, makeError, makeProgress, type CartridgeMessage } from './protocol';
import { METHODS } from './methods';

export interface AdapterOptions {
  port?: number;            // default 7424 (matches manifest.json default_url)
  path?: string;            // default '/cartridge'
  onListen?: (port: number, path: string) => void;
}

export function startCartridgeAdapter(opts: AdapterOptions = {}): { close: () => Promise<void> } {
  const port = opts.port ?? 7424;
  const path = opts.path ?? '/cartridge';

  const wss = new WebSocketServer({ port, path });
  wss.on('listening', () => {
    if (opts.onListen) opts.onListen(port, path);
    else console.log(`[cartridge] adapter listening on ws://localhost:${port}${path}`);
  });

  // Track in-flight requests so we can cancel them on socket close.
  const cancelMap = new Map<string, () => void>();

  wss.on('connection', (ws: WebSocket) => {
    console.log('[cartridge] client connected');

    ws.on('message', async (data) => {
      let msg: CartridgeMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        ws.send(JSON.stringify(makeError(
          'unknown', ERR.INVALID_ARGS, `invalid JSON: ${(err as Error).message}`,
        )));
        return;
      }

      if (msg.type !== 'call') {
        // Adapter is request-only — ignore stray result/progress messages.
        return;
      }

      const reqId = msg.id;
      if (msg.cartridge !== 'robot') {
        ws.send(JSON.stringify(makeError(
          reqId, ERR.UNKNOWN_METHOD, `unknown cartridge: ${msg.cartridge}`,
        )));
        return;
      }
      const impl = METHODS[msg.method];
      if (!impl) {
        ws.send(JSON.stringify(makeError(
          reqId, ERR.UNKNOWN_METHOD, `unknown method: ${msg.method}`,
        )));
        return;
      }

      let cancelled = false;
      cancelMap.set(reqId, () => { cancelled = true; });
      const ctx = {
        emit: (payload: Record<string, unknown>) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(makeProgress(reqId, payload)));
          }
        },
        cancelled: () => cancelled,
      };

      try {
        const result = await impl(msg.args ?? {}, ctx, reqId);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(result));
      } catch (err) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(makeError(
            reqId, ERR.INTERNAL, (err as Error).message,
          )));
        }
      } finally {
        cancelMap.delete(reqId);
      }
    });

    ws.on('close', () => {
      console.log('[cartridge] client disconnected');
      // Cancel all in-flight requests for this socket.
      for (const cancel of cancelMap.values()) cancel();
      cancelMap.clear();
    });

    ws.on('error', (err) => {
      console.error('[cartridge] socket error:', err);
    });
  });

  return {
    async close() {
      return new Promise((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
