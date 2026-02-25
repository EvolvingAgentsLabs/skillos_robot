# The Dual-Brain Architecture

## Why Two LLMs?

A single LLM cannot handle both strategic planning and real-time motor control. The requirements are contradictory:

| Requirement | Cortex (Planning) | Cerebellum (Control) |
|-------------|-------------------|---------------------|
| Latency | Seconds acceptable | Sub-second required |
| Context | Full conversation history | Single frame |
| Output | Natural language goals | 6-byte hex commands |
| Model | Large (Claude, GPT-4) | Small (Qwen-VL 8B) |
| Location | Cloud | Local |

## The Biological Metaphor

The names aren't arbitrary:

- **Cortex** (cerebral cortex): In biology, handles abstract thought, planning, language. Slow but powerful. In RoClaw, this is the OpenClaw node — it understands "go to the kitchen" and translates it to a motor control goal.

- **Cerebellum**: In biology, handles motor coordination, balance, learned movements. Fast and automatic. In RoClaw, this is the Qwen-VL vision loop — it sees a camera frame and outputs the next motor command in ~200ms.

## Data Flow

```
User: "Go check the kitchen"
  ↓
OpenClaw Gateway (routes to RoClaw node)
  ↓
Cortex (translates goal)
  Goal: "Navigate to the kitchen. Look for kitchen-like features."
  ↓
Cerebellum (reactive loop at ~2 FPS)
  Frame 1: See hallway → AA 01 80 80 01 FF (forward)
  Frame 2: See wall → AA 04 60 80 E4 FF (turn right)
  Frame 3: See kitchen → AA 07 00 00 07 FF (stop)
  ↓
Cortex reports: "Arrived at kitchen. I see a counter, refrigerator, and sink."
```

## Latency Analysis

The critical path is the Cerebellum's reactive loop:

| Stage | Time |
|-------|------|
| Frame capture (ESP32-CAM → host) | ~20ms |
| JPEG decode + base64 encode | ~5ms |
| VLM inference (Qwen-VL 8B local) | ~200ms |
| Bytecode compilation | ~0.1ms |
| UDP transmission (host → ESP32-S3) | ~2ms |
| Bytecode parsing on ESP32 | ~0.1ms |
| **Total** | **~230ms** |

At ~4 FPS, the robot can react to obstacles in real-time. This is fast enough for a robot moving at 4.7 cm/s — it travels less than 2cm between decisions.

## The Cortex is Thin

The Cortex is intentionally minimal. It:

1. Receives a tool invocation from OpenClaw
2. Translates it to a Cerebellum goal string
3. Starts/stops the vision loop
4. Reports results back to OpenClaw

Path planning and localization live in the **Semantic Map** — a VLM-powered topological graph that runs as an async sidecar to the Cerebellum. It analyzes camera frames to build a map of locations (nodes) and navigation paths (edges), enabling re-identification of visited places and multi-hop pathfinding. See [LLMunix Evolution](04-LLMunix-Evolution.md) for details.
