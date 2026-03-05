# Gemini Robotics-ER Integration Report

**Date:** March 5, 2026
**Branch:** `integration-mjswan-gemini-robotics`
**Status:** Feature-complete, simulation-verified

## Overview

RoClaw now supports Google's Gemini Robotics-ER as a drop-in inference backend alongside the existing Qwen-VL/OpenRouter stack. The integration includes native structured tool calling (eliminating hex text parsing), spatial grounding with bounding boxes, configurable thinking budgets for strategic analysis, and a physics-based goal confirmation system using proximity detection from the MuJoCo simulation.

## What's Integrated

### Gemini Inference Backend (`src/2_qwen_cerebellum/gemini_robotics.ts`)

- **GeminiRoboticsInference** class with full Gemini API support
- 7 motor control tool declarations: `move_forward`, `move_backward`, `turn_left`, `turn_right`, `rotate_cw`, `rotate_ccw`, `stop`
- Structured function calling: Gemini returns `TOOLCALL:{"name":"move_forward","args":{"speed_l":128,"speed_r":128}}` instead of raw hex bytes
- Thinking budget: 0 for fast motor control, configurable (1024+) for dream consolidation
- Exponential backoff retry logic, stats tracking, timeout handling

### Tool-Calling Bytecode Compilation (`src/2_qwen_cerebellum/bytecode_compiler.ts`)

- `getToolCallingSystemPrompt(goal)` generates Gemini-specific system instructions
- `tryParseToolCall(text)` maps structured tool calls to bytecodes (Mode 0)
- Proper parameter scaling from Gemini's 0-255 normalized outputs

### VisionLoop Dual-Mode (`src/2_qwen_cerebellum/vision_loop.ts`)

- `useToolCallingPrompt` config flag switches between tool-calling and hex bytecode prompts
- Frame history and temporal context work identically in both modes
- New `confirmArrival(reason)` method for external arrival confirmation (physics engine)

### Scene Analysis via Gemini (`src/1_openclaw_cortex/roclaw_tools.ts`)

- `ensureMapInfer()` auto-selects Gemini when `GOOGLE_API_KEY` is available
- Higher token limit (1024) and longer timeout (30s) for analytical tasks
- Falls back to Qwen if no Google key

### Dream Consolidation (`src/3_llmunix_memory/dream_inference.ts`)

- Gemini with thinking budget (1024 tokens) for deep strategy analysis
- Auto-detects provider: `DREAM_PROVIDER=gemini` or key-based fallback
- Temperature 0.3 for consistent strategic reasoning

### 3D Simulation Runner (`scripts/run_sim3d.ts`)

- `--gemini` CLI flag routes all inference through Gemini
- Tool calling enabled by default in Gemini mode
- Physics-based goal polling (see below)

## Physics-Based Goal Confirmation

### Problem

The VLM's STOP output is unreliable: it may output STOP prematurely (declaring arrival far from the target) or never output STOP at all. We needed ground-truth from the physics engine.

### Solution

Three-layer system using the MuJoCo simulation's real-time pose data:

**1. Bridge: Target Tracking** (`src/mjswan_bridge.ts`)

- `GoalTarget` type: `{ name, x, y, radius }` with default `red_cube:-0.6:-0.5:0.25`
- `--target "name:x:y:radius"` CLI arg for custom targets
- Distance computation on every WebSocket pose update:
  ```
  dx = pose.x - target.x; dy = pose.y - target.y
  targetDistance = sqrt(dx*dx + dy*dy)
  goalReached = targetDistance < target.radius
  ```
- Extended `GET_STATUS` response: `{ targetName, targetDistance, goalReached }`
- Dashboard shows: `Target: red_cube  Dist: 0.42m` or `REACHED`

**2. VisionLoop: External Arrival** (`src/2_qwen_cerebellum/vision_loop.ts`)

- `confirmArrival(reason)` closes reactive traces as SUCCESS, emits `'arrival'`, stops the loop
- Decouples arrival from VLM STOP — physics engine can trigger it

**3. Cognitive Stack: Distance Polling** (`scripts/run_sim3d.ts`)

- Starts a UDP polling loop immediately (before `handleTool` blocks on planning)
- Sends `GET_STATUS` every 2 seconds, parses JSON response
- Logs: `Target "red_cube": 0.77m away`
- On `goalReached === true`: confirms arrival, sends STOP, triggers dream consolidation

### Simulation Results

| Metric | Value |
|--------|-------|
| Initial distance (robot at origin) | 0.77m (correct: sqrt(0.6^2 + 0.5^2)) |
| Polling interval | 2 seconds |
| Distance accuracy | Matches MuJoCo world coordinates (meters) |
| False VLM STOPs observed | 2 (at 1.10m and 0.70m — correctly NOT confirmed by physics) |
| Minimum distance reached | 0.70m (robot approached but didn't enter 0.25m radius) |
| TypeScript compilation | Clean (0 errors) |
| Test suite | 410 passed, 24 suites |

### Bugs Found & Fixed During Testing

1. **Infinity serialization** — `targetDistance: Infinity` (initial state) became `null` in JSON, crashing `null.toFixed(2)` in the poller. Fixed by computing initial distance from origin to target.
2. **Late polling start** — Polling was gated on `handleTool` returning (30+ seconds for topo planning). Moved to start before `handleTool`.
3. **Unreliable one-shot UDP listener** — One-shot `on('message')` pattern missed responses. Replaced with permanent handler + explicit `bind()`.

## Gemini vs Qwen: Component Matrix

| Component | Gemini | Qwen | Notes |
|-----------|--------|------|-------|
| Motor control (VisionLoop) | Tool calling | Hex bytecode | `--gemini` flag |
| Scene analysis (topo map) | Auto-detected | Fallback | Higher token limit for Gemini |
| Navigation planning | Backend-agnostic | Backend-agnostic | Uses `InferenceFunction` |
| Hierarchical planner | Backend-agnostic | Backend-agnostic | Uses `InferenceFunction` |
| Dream consolidation | Thinking budget | Standard | Auto-detects provider |
| Semantic map analysis | Backend-agnostic | Backend-agnostic | Uses `InferenceFunction` |
| Spatial grounding | Prepared | N/A | BBox features parsed, not yet active |
| Physics goal confirmation | N/A | N/A | Independent of inference backend |

## Pending Work

### Testing Needed

- **End-to-end goal reach**: Robot needs to navigate within 0.25m of the red cube to trigger physics confirmation. VLM navigation quality limits this — the robot explores but doesn't consistently approach the target.
- **Spatial grounding**: `SpatialFeature` with bounding boxes is implemented but not actively tested with Gemini.
- **Gemini live integration tests**: `gemini-robotics-live.test.ts` exists but requires `GOOGLE_API_KEY` to run.

### Known Limitations

- **VLM navigation quality**: Gemini tends to rotate/scan instead of moving directly toward the target. The tool-calling prompt may need tuning for more decisive forward movement.
- **Premature STOP**: Gemini calls `stop()` tool before reaching the target. Physics confirmation correctly rejects these, but the VisionLoop stops and must be restarted by the planner's step-retry logic.
- **Thinking budget latency**: Adding thinking tokens to the motor control loop would slow it from ~200ms to seconds. Kept at 0 for motor control intentionally.

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `GOOGLE_API_KEY` | Gemini API key | (required for Gemini) |
| `GEMINI_MODEL` | Model ID | `gemini-robotics-er-1.5-preview` |
| `GEMINI_THINKING_BUDGET` | Thinking tokens | `0` (motor), `1024` (dream) |
| `DREAM_PROVIDER` | Force dream backend | Auto-detect |
| `OPENROUTER_API_KEY` | Qwen fallback | (required for Qwen) |

## Running the Simulation

```bash
# Terminal 1: Start bridge with target tracking
npm run sim:3d

# Terminal 2: Open browser (MuJoCo 3D scene)
open http://localhost:8000?bridge=ws://localhost:9090

# Terminal 3: Run cognitive stack with Gemini
GOOGLE_API_KEY=your_key npx tsx scripts/run_sim3d.ts --gemini --goal "the red cube"
```

The bridge dashboard shows real-time target distance, and the cognitive stack logs `Target "red_cube": X.XXm away` every 2 seconds.
