# Cartridge adapter

skillos_robot exposed as an llm_os-style cartridge over WebSocket. Lets an upstream OS (skillos_mini, llm_os browser demo) call into the robot's high-level capabilities — navigate, observe, describe, stop, set_speed — without knowing anything about UDP bytecode, the 20Hz reactive loop, or ESP32 firmware.

## Architecture

```
upstream OS (skillos_mini cartridge runner)
  │
  │  WebSocket (this folder)
  ▼
robot cartridge adapter (this folder)  ──→  planner / SemanticLoop / ReactiveController
                                              │
                                              │  6-byte UDP bytecode
                                              ▼
                                            ESP32-S3-CAM (motor + IMU + camera)
```

**Realtime stays onboard.** The 20Hz reactive loop, reflex guard, and ESP32 firmware are unchanged. The cartridge adapter is the *strategic-layer* surface — high-level intents come in, real-time execution remains where it has to be.

## Wire protocol

JSON over WebSocket. Default URL `ws://localhost:7424/cartridge` (configurable).

**Request** (caller → adapter):
```json
{
  "id": "req-abc",
  "type": "call",
  "cartridge": "robot",
  "method": "navigate",
  "args": { "goal": "the red cube", "timeout_s": 60, "policy": "safe" }
}
```

**Progress event** (adapter → caller, optional, multiple per request):
```json
{ "id": "req-abc", "type": "progress", "data": { "phase": "executing", "steps": 3 } }
```

**Result** (adapter → caller, exactly one per request):
```json
{ "id": "req-abc", "type": "result", "ok": true, "result": { "distance_m": 1.2 } }
```
or
```json
{ "id": "req-abc", "type": "result", "ok": false, "error": { "code": "TIMEOUT", "message": "navigate exceeded 60s" } }
```

Full type definitions in [`protocol.ts`](protocol.ts).

## Running the adapter

```bash
# from skillos_robot (a.k.a. RoClaw) repo root
npx tsx src/cartridge/cli.ts             # default port 7424
npx tsx src/cartridge/cli.ts --port 8000 # custom port
```

The adapter logs `client connected` / `client disconnected` and the status of each request as it flows through.

## Methods

| Method | Status | Purpose |
|---|---|---|
| `navigate({goal, timeout_s, policy})` | scaffolded | NL goal → planner → reactive loop → bytecode |
| `observe({})` | scaffolded | SceneGraph snapshot (objects, positions, distances) |
| `describe({})` | scaffolded | NL description from SemanticLoop's last VLM result |
| `stop({})` | scaffolded | Emergency stop (STOP bytecode via UDP) |
| `set_speed({max})` | scaffolded | Cap reactive controller speed |

Method bodies live in [`methods.ts`](methods.ts). Each currently returns `NOT_IMPLEMENTED` with an explicit TODO marker pointing at the runtime integration site (planner, SemanticLoop, ReactiveController, UDP transmitter). Wire format and message envelope are real and testable today; runtime integration lands incrementally.

## Cartridge manifest

[`manifest.json`](manifest.json) declares the cartridge in **llm_os kernel format** — same shape the kernel's [`Cartridge`](https://github.com/EvolvingAgentsLabs/llm_os/blob/main/kernel/cartridge.js) class consumes. This means an llm_os browser demo can mount the robot as a remote cartridge: build the trie from `manifest.json`, generate `<|call|>robot.navigate {...}<|/call|>` opcodes, and the result of each call is whatever this WebSocket adapter returns. No code translation needed at the manifest layer.

## Two ISAs, no conflict

skillos_robot has its own ISA — the 6-byte UDP bytecode for stepper-motor commands ([`bytecode_compiler.ts`](../control/bytecode_compiler.ts)). llm_os has its own ISA — the 14-opcode LLM-token grammar. They sit at different abstractions:

- llm_os ISA: **syscall layer** (LLM emits `<|call|>robot.navigate {...}<|/call|>`)
- robot ISA: **device-driver layer** (motor wire format on UDP)

The cartridge adapter is the bridge. An upstream OS emits a syscall; the adapter dispatches to the planner; the planner produces motor primitives; the reactive loop emits bytecode. Nothing competes.

## Implementation order

The wire protocol (this PR) lands first. Method bodies are stubbed with explicit TODO markers. Subsequent PRs wire each method to its real backing subsystem:

1. **PR A — `stop`**. Smallest dependency surface (just UDP). Should be a one-liner once `udp_transmitter.ts` exposes a `sendStop()` helper.
2. **PR B — `observe`**. Requires SceneGraph singleton accessor. Read-only against existing data structure.
3. **PR C — `describe`**. Requires SemanticLoop to cache its last VLM textual output.
4. **PR D — `set_speed`**. Requires ReactiveController to expose a runtime speed cap setter.
5. **PR E — `navigate`**. The big one. Refactor `planner.run()` to be a function that takes a goal + emits progress events instead of being startup-coupled.

Until those land, the adapter is useful as a wire-format reference and as a smoke target for upstream callers developing against the cartridge contract.

## Smoke test

Trivial Node/Browser client that calls each method and prints results:

```js
const ws = new WebSocket('ws://localhost:7424/cartridge');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.onopen = () => {
  ws.send(JSON.stringify({
    id: 'test-1', type: 'call', cartridge: 'robot',
    method: 'observe', args: {},
  }));
};
// expect: { id: 'test-1', type: 'result', ok: false,
//           error: { code: 'NOT_IMPLEMENTED', message: '...' } }
```

That round-trip exercises the protocol; replace with a real implementation in `methods.ts` once the underlying subsystem is ready.
