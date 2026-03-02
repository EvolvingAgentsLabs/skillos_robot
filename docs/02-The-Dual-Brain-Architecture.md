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

## The 4-Tier Cognitive Hierarchy

The dual-brain design extends into a 4-tier cognitive hierarchy that bridges high-level goals to reactive motor control:

```
Level 1: MAIN GOAL (Cortex)           "Fetch me a drink"
    |                                   Queries strategies, decomposes into sub-goals
    v
Level 2: STRATEGIC PLAN               "Traverse hallway → kitchen"
    |                                   Uses route strategies from memory
    v
Level 3: TACTICAL PLAN                "Door blocked. Route around couch."
    |                                   Strategy-informed navigation
    v
Level 4: REACTIVE EXECUTION           Sub-second motor corrections (bytecodes)
                                       Constraint-aware VisionLoop
```

The **Hierarchical Planner** (`src/1_openclaw_cortex/planner.ts`) sits in the Cortex and queries the memory system for strategies relevant to the current goal. It decomposes goals into multi-step plans, injecting strategy hints and negative constraints into each step. When no strategies exist yet, it gracefully falls through to the existing PoseMap/TopoMap navigation.

## The Cortex

The Cortex handles goal decomposition, planning, and navigation session management:

1. Receives a tool invocation from OpenClaw
2. Queries the **Hierarchical Planner** for a multi-step plan (if strategies exist)
3. Injects strategy hints and negative constraints into the Cerebellum's goal
4. Starts the VisionLoop with trace IDs for hierarchical logging
5. Creates a **NavigationSession** that listens for `'arrival'` events from the Cerebellum
6. On arrival: closes the current step trace as SUCCESS, advances to the next step via `planStrategicStep()`, or completes the GOAL trace if all steps are done
7. Reports results back to OpenClaw

The **arrival event** is the critical feedback mechanism that closes the Cortex↔Cerebellum loop. When the VisionLoop compiles a STOP opcode (meaning the VLM decided the robot has arrived), it emits `'arrival'`. The Cortex's NavigationSession listens for this event and either advances the multi-step plan or declares the navigation complete. Without this, traces would never close with SUCCESS and multi-step plans would never advance past the first step.

Path planning and localization live in the **Semantic Map** — a VLM-powered topological graph that runs as an async sidecar to the Cerebellum. It analyzes camera frames to build a map of locations (nodes) and navigation paths (edges), enabling re-identification of visited places and multi-hop pathfinding. See [LLMunix Evolution](04-LLMunix-Evolution.md) for details.
