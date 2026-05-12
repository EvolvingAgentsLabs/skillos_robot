# skillos_robot

A physical (or simulated) embodiment of `llm_os`. The robot exposes itself as a `robot.*` cartridge over WebSocket; an upstream `llm_os` kernel (running in a browser tab, or via skillos_mini's launcher) calls cartridge methods to navigate and observe the world. Internally the robot delegates to **remote LLMs as tools** -- Qwen3-VL-8B via OpenRouter for vision (default), Gemma 4 for orchestration, Gemini Robotics-ER as an alternative, and the kernel-CPU running upstream as the strategic decision-maker.

In one sentence: **`skillos_robot` is the `vision + motors` device driver of `llm_os`.**

Part of the [Evolving Agents](https://github.com/EvolvingAgentsLabs) ecosystem.

## How the pieces fit

```
Browser tab running llm_os kernel + game cartridge
        |
        |  (upstream "scavenger" or similar -- high-level goal)
        v
skillos_mini launcher (chooses the strategy markdown)
        |
        |  WebSocket cartridge call:
        |  <|call|>robot.navigate {"goal": "the red cube"}<|/call|>
        v
skillos_robot cartridge adapter (this repo, src/cartridge/)
        |
        |  Internally uses these LLMs as tools:
        |  - Qwen3-VL-8B via OpenRouter (cloud, default) -- produces SceneGraph
        |  - Gemma 4 via OpenRouter -- ISA orchestrator brain
        |  - Gemini Robotics-ER (cloud, alternative)
        |  - HierarchicalPlanner with stub or real infer
        v
ReactiveController @ 20 Hz --> bytecode --> ESP32-S3-CAM (UDP)
                                      ^
                                      MJPEG camera feeds the VLM loop
```

The kernel-CPU upstream doesn't know about OpenRouter, Gemini, or UDP. It knows about cartridge methods. The robot translates high-level intent into perception calls and motor primitives.


## ISA Orchestrator (autonomous brain)

When no upstream `llm_os` kernel is available, the robot can run autonomously using the **ISA orchestrator** -- a conversational LLM brain (Gemma 4 via OpenRouter) that emits ISA opcodes in a loop:

```
Gemma 4 (26B-A4B via OpenRouter)
    | emits ISA opcodes: call, think, loop, wait, halt...
    v
ISA Executor (src/orchestrator/)
    | dispatches to cartridge methods, manages conversation
    | fd=3: navigation events (wait for arrival)
    | fd=4/5: microphone/speaker (speak/listen)
    v
Cartridge Methods (same process, no WebSocket overhead)
    | navigate, observe, describe, speak, listen, stop
    v
ReactiveController @ 20 Hz --> dead reckoning / UDP to ESP32
```

The orchestrator supports multi-step tasks: greeting people, asking questions, listening for answers, navigating to destinations, and reporting results. It uses the same 14-opcode ISA as `llm_os v3` (call, halt, think, read, write, loop, break, fork, yield, wait, commit, fault, policy).

### 2D simulation

```bash
# Run the care assistant scenario with 2D visualization:
OPENROUTER_API_KEY=sk-or-v1-... npm run sim:2d

# Then open in browser:
open http://localhost:9092
```

The 2D viewer (`sim/sim2d.html`) shows a top-down canvas of the arena with the robot, people, doors, and obstacles. State is broadcast over WebSocket at 5 Hz. The conversation log, robot position, heading, and goal distance are shown in a side panel.


## Cartridge interface (the public surface)

Seven methods exposed to upstream LLM-OS callers via WebSocket at `ws://<host>:7424/cartridge`:

| Method | Backing tool inside this repo |
|---|---|
| `robot.observe({})` | Returns `SceneGraph.toJSON()` -- fed by the VLM loop |
| `robot.describe({})` | Returns the most recent VLM textual description |
| `robot.navigate({goal, ...})` | `HierarchicalPlanner.planGoal()` -- decomposes NL goal into plan steps |
| `robot.set_speed({max})` | Mutates `ReactiveController.setSpeedTier()` |
| `robot.stop({})` | UDP STOP frame (opcode `0x07`) -- bypasses the loops, ESP32 firmware halts within one tick |
| `robot.speak({text})` | Speaks text via IOAdapter (console, MacOS `say`, or stub) |
| `robot.listen({timeout_s})` | Listens for input via IOAdapter (stdin, stub canned responses) |

Wire format and method semantics: [`src/cartridge/README.md`](src/cartridge/README.md).


## Quick start

### 2D simulation (recommended for first run)

```bash
npm install
cp .env.example .env   # set OPENROUTER_API_KEY
npm run sim:2d          # starts orchestrator + 2D viewer
# open http://localhost:9092 in browser
```

### As a cartridge for an upstream LLM-OS

```bash
npm run cartridge:demo                                  # default port 7424
# or with hardware:
npm run cartridge:demo -- --robot-host 192.168.1.42
```

Then any WebSocket client can issue cartridge calls. See [`src/cartridge/README.md`](src/cartridge/README.md) for protocol + smoke-test client.

### Standalone orchestrator (no upstream OS)

```bash
# Console mode (interactive stdin/stdout):
OPENROUTER_API_KEY=sk-or-v1-... npm run orchestrator:demo

# Dataset generation (automated, stub I/O -- for fine-tuning):
OPENROUTER_API_KEY=sk-or-v1-... npm run orchestrator:dataset
```

### Standalone CLI (direct robot driving)

```bash
robot navigate "go to the red cube"              # cloud VLM (OpenRouter Qwen3-VL-8B)
robot navigate --gemini "go through the doorway"  # Gemini Robotics-ER alternative
robot navigate --egocentric "go to the red cube"
robot dream                                       # nightly trace replay
robot test                                        # ESP32 connection check
robot status
```


## Inference tools (remote and local)

The robot uses *other LLMs* as building blocks. They're tools in the cartridge sense -- pluggable, optional, called as needed:

- **Qwen3-VL-8B via OpenRouter** (cloud, default). Vision-capable, supports images. $0.08/M input, $0.50/M output, 131K context. Returns labeled bounding boxes; SceneGraph projector turns them into 3D arena coordinates. Set `OPENROUTER_API_KEY` in `.env`.
- **Gemma 4 via OpenRouter** (orchestrator brain). MoE 26B total / 4B active per token. Emits ISA opcodes for multi-step task execution. Uses the same `OPENROUTER_API_KEY`. Set `ORCHESTRATOR_MODEL` in `.env`.
- **Gemini Robotics-ER** (cloud, alternative). Vision + spatial reasoning with native tool calling. Use `--gemini` flag. Set `GOOGLE_API_KEY` in `.env`.
- **Ollama** (local fallback). No internet, text-only (does not support images). Use `--ollama` flag for offline motor control without vision.
- **The upstream LLM-OS kernel** is itself an "LLM as tool" -- it's the one that decides *what* to do; this robot just does it.

The robot doesn't ship with its own LLM. It composes: a cloud VLM (OpenRouter/Qwen3-VL), an orchestration brain (Gemma 4), an optional alternative (Gemini), and an upstream conductor (the kernel) -- multiple LLMs, each used for what it's best at.


## Two ISAs, no conflict

- The **upstream LLM-OS ISA** is the syscall layer. The kernel's grammar emits `<|call|>robot.navigate {"goal":...}<|/call|>` -- the cartridge contract.
- The **6-byte UDP bytecode ISA** is the device-driver layer. `[0xAA] [opcode] [param_l] [param_r] [checksum] [0xFF]` -- the wire to the ESP32.

The cartridge adapter bridges them. No competition.


## Architecture details

Full 5-tier stack, perception policies, memory system, hardware spec:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

Operator guide: [docs/USAGE.md](docs/USAGE.md)
Build a scene: [docs/TUTORIAL.md](docs/TUTORIAL.md)
Roadmap: [docs/NEXT_STEPS.md](docs/NEXT_STEPS.md)

## License

Apache 2.0
