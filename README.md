# skillos_robot

A physical (or simulated) embodiment of `llm_os`. The robot exposes itself as a `robot.*` cartridge over WebSocket; an upstream `llm_os` kernel (running in a browser tab, or via skillos_mini's launcher) calls cartridge methods to navigate and observe the world. Internally the robot delegates to **remote LLMs as tools** — Qwen3-VL-8B via OpenRouter for vision (default), Gemini Robotics-ER as an alternative, and the kernel-CPU running upstream as the strategic decision-maker.

In one sentence: **`skillos_robot` is the `vision + motors` device driver of `llm_os`.**

Part of the [Evolving Agents](https://github.com/EvolvingAgentsLabs) ecosystem.

## How the pieces fit

```
Browser tab running llm_os kernel + game cartridge
        │
        │  (upstream "scavenger" or similar — high-level goal)
        ▼
skillos_mini launcher (chooses the strategy markdown)
        │
        │  WebSocket cartridge call:
        │  <|call|>robot.navigate {"goal": "the red cube"}<|/call|>
        ▼
skillos_robot cartridge adapter (this repo, src/cartridge/)
        │
        │  Internally uses these LLMs as tools:
        │  - Qwen3-VL-8B via OpenRouter (cloud, default) — produces SceneGraph
        │  - Gemini Robotics-ER (cloud, alternative)
        │  - HierarchicalPlanner with stub or real infer
        ▼
ReactiveController @ 20 Hz → bytecode → ESP32-S3-CAM (UDP)
                                      ↑
                                      MJPEG camera feeds the VLM loop
```

The kernel-CPU upstream doesn't know about OpenRouter, Gemini, or UDP. It knows about cartridge methods. The robot translates high-level intent into perception calls and motor primitives.

## Cartridge interface (the public surface)

All five methods exposed to upstream LLM-OS callers via WebSocket at `ws://<host>:7424/cartridge`:

| Method | Backing tool inside this repo |
|---|---|
| `robot.observe({})` | Returns `SceneGraph.toJSON()` — fed by the VLM loop |
| `robot.describe({})` | Returns the most recent VLM textual description |
| `robot.navigate({goal, …})` | `HierarchicalPlanner.planGoal()` (uses an `infer` function — typically OpenRouter/Qwen3-VL, optionally Gemini, or stub for protocol smoke tests) |
| `robot.set_speed({max})` | Mutates `ReactiveController.setSpeedTier()` |
| `robot.stop({})` | UDP STOP frame (opcode `0x07`) — bypasses the loops, ESP32 firmware halts within one tick |

Wire format and method semantics: [`src/cartridge/README.md`](src/cartridge/README.md). Real-world counterpart of `llm_os/cart/game/scavenger`: [`src/cartridge/scavenger-challenge.md`](src/cartridge/scavenger-challenge.md) — the same compiled-state shape SceneGraph emits is what the JS Scavenger demo emits, so the same prompt and opcode set drive both the browser game and the physical task.

## Quick start

### As a cartridge for an upstream LLM-OS

```bash
npm install
npm run cartridge:demo                                  # default port 7424
# or with hardware:
npm run cartridge:demo -- --robot-host 192.168.1.42
```

Then any WebSocket client can issue cartridge calls. See [`src/cartridge/README.md`](src/cartridge/README.md) for protocol + smoke-test client.

### Standalone (no upstream OS)

The original CLI still works for direct robot driving:

```bash
robot navigate "go to the red cube"            # cloud VLM (OpenRouter Qwen3-VL-8B)
robot navigate --gemini "go through the doorway"# Gemini Robotics-ER alternative
robot navigate --egocentric "go to the red cube"
robot sim --serve                              # MuJoCo bridge
robot dream                                    # nightly trace replay
robot test                                     # ESP32 connection check
robot status
```

## Inference tools (remote and local)

The robot uses *other LLMs* as building blocks. They're tools in the cartridge sense — pluggable, optional, called as needed:

- **Qwen3-VL-8B via OpenRouter** (cloud, default). Vision-capable, supports images. $0.08/M input, $0.50/M output, 131K context. Returns labeled bounding boxes; SceneGraph projector turns them into 3D arena coordinates. Set `OPENROUTER_API_KEY` in `.env`.
- **Gemini Robotics-ER** (cloud, alternative). Vision + spatial reasoning with native tool calling. Use `--gemini` flag. Set `GOOGLE_API_KEY` in `.env`.
- **Ollama** (local fallback). No internet, text-only (does not support images). Use `--ollama` flag for offline motor control without vision.
- **The upstream LLM-OS kernel** is itself an "LLM as tool" — it's the one that decides *what* to do; this robot just does it.

The robot doesn't ship with its own LLM. It composes: a cloud VLM (OpenRouter/Qwen3-VL), an optional alternative (Gemini), and an upstream conductor (the kernel) — multiple LLMs, each used for what it's best at.

## Two ISAs, no conflict

- The **upstream LLM-OS ISA** is the syscall layer. The kernel's grammar emits `<|call|>robot.navigate {"goal":...}<|/call|>` — the cartridge contract.
- The **6-byte UDP bytecode ISA** is the device-driver layer. `[0xAA] [opcode] [param_l] [param_r] [checksum] [0xFF]` — the wire to the ESP32.

The cartridge adapter bridges them. No competition.

## Architecture details

Full 5-tier stack, perception policies, memory system, hardware spec:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

Operator guide: [docs/USAGE.md](docs/USAGE.md)
Build a scene: [docs/TUTORIAL.md](docs/TUTORIAL.md)
Roadmap: [docs/NEXT_STEPS.md](docs/NEXT_STEPS.md)

## License

Apache 2.0
