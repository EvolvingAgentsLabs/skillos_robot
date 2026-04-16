# Gemini Robotics-ER 1.6 Integration Report

**Date:** April 14, 2026 (updated from March 5, 2026)
**Model:** `gemini-robotics-er-1.6-preview`
**Status:** Production — telemetry-guided navigation verified end-to-end

## Overview

RoClaw uses [Gemini Robotics-ER 1.6](https://deepmind.google/discover/blog/gemini-robotics-brings-ai-into-the-physical-world/) as the default VLM for embodied navigation. The integration includes native structured tool calling (7 motor opcodes), telemetry-guided navigation (pose + bearing + distance injection into VLM prompts), spatial grounding with bounding boxes, configurable thinking budgets, code execution support, and physics-based goal confirmation from MuJoCo.

**Resources:**
- [DeepMind Blog: Gemini Robotics brings AI into the physical world](https://deepmind.google/discover/blog/gemini-robotics-brings-ai-into-the-physical-world/)
- [Gemini API Robotics Documentation](https://ai.google.dev/gemini-api/docs/robotics)

## Gemini Robotics-ER 1.6 Features Used

### Spatial Grounding
- **Pointing:** `[y, x]` normalized 0-1000 coordinates for object location
- **Bounding Boxes:** `[ymin, xmin, ymax, xmax]` format for object detection in scene analysis
- `SpatialFeature` type supports both array format (Robotics-ER native) and legacy `{x,y,w,h}` objects
- Proportional navigation hints: 5-bucket system (FAR LEFT / SLIGHTLY LEFT / CENTERED / SLIGHTLY RIGHT / FAR RIGHT) with estimated turn angles

### Native Function Calling
- 7 motor control tools declared as structured function schemas
- The model returns tool calls (`move_forward(180, 180)`) that compile directly to 6-byte bytecodes
- No text parsing — structured `functionCall` responses map 1:1 to motor opcodes

| Tool | Opcode | Parameters |
|------|--------|------------|
| `move_forward` | `0x01` | `speed_l`, `speed_r` (0-255) |
| `move_backward` | `0x02` | `speed_l`, `speed_r` |
| `turn_left` | `0x03` | `speed_l`, `speed_r` |
| `turn_right` | `0x04` | `speed_l`, `speed_r` |
| `rotate_cw` | `0x05` | `degrees`, `speed` |
| `rotate_ccw` | `0x06` | `degrees`, `speed` |
| `stop` | `0x07` | — |

### Embodied Reasoning
- Interprets first-person camera frames fused with SENSOR DATA (bearing, distance, pose)
- Frame history (4 consecutive frames) provides temporal context for velocity and depth perception
- The system prompt is minimal: "Execute the recommended command from SENSOR DATA"

### Code Execution
- `codeExecution` tool enabled for Robotics-ER models (gated on `model.includes('robotics-er')`)
- Allows the model to write Python for distance computation, image analysis, and instrument reading
- Not active in the fast motor loop — available for scene analysis tasks

### Thinking Budget Control
- `thinkingBudget=0` for 2Hz motor control loop (fast, reactive)
- `thinkingBudget=1024` for scene analysis and dream consolidation (deep reasoning)
- Configurable via `GEMINI_THINKING_BUDGET` and `GEMINI_SCENE_THINKING_BUDGET` env vars
- For Robotics-ER (non-lite) models, `thinkingConfig` is always sent (budget=0 means no extended thinking)

### Success Detection
- Physics-based arrival confirmation: bridge computes distance from robot to target every pose update
- `goalReached` flag when distance < target radius (default 0.25m)
- Decoupled from VLM output — the model's `stop()` calls are validated against physics ground truth

## Telemetry-Guided Navigation (New in 1.6 Integration)

The major upgrade from the 1.5 integration is **telemetry-guided navigation** — the bridge computes real-time bearing and distance to the target and injects this as SENSOR DATA into every VLM prompt.

### Architecture

```
Bridge (mjswan_bridge.ts)
  ├── Receives pose from MuJoCo via WebSocket
  ├── Computes: targetBearing = atan2(dy, dx) - heading  (MuJoCo convention: 0 = +X axis)
  ├── Computes: targetDist = sqrt(dx² + dy²)
  └── Pushes telemetry via UDP every 500ms

TelemetryMonitor (telemetry_monitor.ts)
  └── Parses push messages, stores latest { pose, targetDist, targetBearing }

VisionLoop (vision_loop.ts)
  ├── Calls telemetryProvider() to get latest bearing + distance
  ├── Injects SENSOR DATA section into VLM user message:
  │     SENSOR DATA (from bridge):
  │     - Target bearing: -15° (slightly right)
  │     - Target distance: 42cm
  │     >>> CALL: move_forward(180, 180)
  └── Speed-tuned rotation hints:
        - |bearing| ≤ 25°: move_forward (speed 180 or 100 based on distance)
        - |bearing| 25-70°: rotate (speed 50, ~53°/step)
        - |bearing| > 70°: rotate (speed 70, ~74°/step)
        - distance < 15cm: stop()
```

### Bearing Computation

The bearing formula uses MuJoCo's yaw convention where heading=0 means facing the +X axis:

```typescript
const absBearing = Math.atan2(tdy, tdx);  // 0 = +X axis (matches MuJoCo yaw)
let relBearing = absBearing - state.pose.h;
// Normalize to -PI..PI
while (relBearing > Math.PI) relBearing -= 2 * Math.PI;
while (relBearing < -Math.PI) relBearing += 2 * Math.PI;
```

- Positive bearing = target is to the LEFT (CCW rotation needed)
- Negative bearing = target is to the RIGHT (CW rotation needed)

### Rotation Speed Tuning

MuJoCo simulation has a friction threshold — speed values below ~50 (0.31 rad/s) are insufficient to overcome wheel friction. The telemetry system uses:

| Bearing Range | Action | Speed | Actual Rotation/Step |
|---------------|--------|-------|---------------------|
| ≤ 25° | `move_forward` | 180 (far) / 100 (close) | N/A |
| 25°–70° | `rotate_cw/ccw` | 50 | ~53°/step |
| > 70° | `rotate_cw/ccw` | 70 | ~74°/step |
| distance < 15cm | `stop` | — | — |

## Perception-Only Inference Mode (Scene-Graph Pipeline)

In addition to the default motor-control inference mode, RoClaw now supports a **perception-only** Gemini configuration via `createPerceptionInference()` (`src/2_qwen_cerebellum/gemini_robotics.ts`):

| Setting | Motor Mode (default) | Perception Mode |
|---------|---------------------|-----------------|
| Tool calling | 7 motor tools declared | Disabled |
| Output format | Structured `functionCall` | `responseMimeType: 'application/json'` |
| Prompt | `TOOL_CALLING_SYSTEM_PROMPT` | `OVERHEAD_SCENE_PROMPT` |
| Thinking budget | 0 (fast, reactive) | 1024 (spatial reasoning) |
| Max output tokens | 1024 | 2048 |
| Output | Motor tool call (e.g., `move_forward(180, 180)`) | JSON object list (`{objects: [{label, box_2d}]}`) |

The perception inference feeds the **SceneGraphPolicy** pipeline: Gemini outputs bounding boxes, `VisionProjector` converts to arena cm, `SceneGraph` tracks objects, and `ReactiveController` generates motor commands deterministically. Both paths produce identical 6-byte bytecodes.

## Simulation Results

### Latest Run (April 16, 2026)

| Metric | Value |
|--------|-------|
| Goal | "navigate to the red cube" |
| Model | `gemini-robotics-er-1.6-preview` |
| Policy | VLMMotorPolicy (default) |
| Initial distance | 78cm |
| Final distance | 25cm (within 0.25m radius) |
| Total frames | 24 |
| Duration | 85s |
| Outcome | SUCCESS |
| Confidence | 0.9 |

This run validated the PerceptionPolicy refactor — the VLMMotorPolicy (extracted from the original VisionLoop code) produces byte-for-byte identical behavior.

### Previous Run (April 14, 2026)

| Metric | Value |
|--------|-------|
| Goal | "navigate to the red cube" |
| Model | `gemini-robotics-er-1.6-preview` |
| Initial distance | 78cm |
| Final distance | 23cm (within 0.25m radius) |
| Total frames | 52 |
| Duration | 137s |
| Outcome | SUCCESS |
| Confidence | 0.9 |
| Phase 1 (rotation) | 12 frames of `rotate_ccw` to align with target |
| Phase 2 (approach) | 40 frames of `move_forward` (speed 180 → 100 as distance decreased) |

### Previous Run (March 5, 2026 — ER 1.5)

| Metric | Value |
|--------|-------|
| Model | `gemini-robotics-er-1.5-preview` |
| Minimum distance reached | 0.70m (did NOT reach 0.25m target) |
| False VLM STOPs | 2 (at 1.10m and 0.70m) |
| Outcome | Did not reach target |

The upgrade from ER 1.5 to 1.6 with telemetry guidance achieved successful navigation for the first time.

## What's Integrated

### Gemini Inference Backend (`src/2_qwen_cerebellum/gemini_robotics.ts`)

- **GeminiRoboticsInference** class with full Gemini API support
- 7 motor control tool declarations as structured function schemas
- `codeExecution` tool conditionally enabled for Robotics-ER models
- Thinking budget: 0 for fast motor control, configurable (1024+) for dream consolidation
- Exponential backoff retry logic, stats tracking, timeout handling
- Default model: `gemini-robotics-er-1.6-preview`

### Telemetry-Guided VisionLoop (`src/2_qwen_cerebellum/vision_loop.ts`)

- `setTelemetryProvider(fn)` accepts a callback returning `{ pose, targetDist, targetBearing }`
- SENSOR DATA injection into VLM user message with bearing, distance, and `>>> CALL:` directive
- Speed-tuned rotation hints based on bearing magnitude
- Shannon entropy stuck detection (STUCK_WINDOW=12, threshold=0.5)
- Frame history and temporal context for multi-frame reasoning

### Bridge Telemetry (`src/mjswan_bridge.ts`)

- `TelemetryMessage` includes `targetDist` and `targetBearing` fields
- `startTelemetryBroadcast(target)` computes relative bearing using `atan2(tdy, tdx)` (MuJoCo convention)
- Bearing normalized to -180°..180°
- Telemetry pushed via UDP every 500ms

### Tool-Calling Bytecode Compilation (`src/2_qwen_cerebellum/bytecode_compiler.ts`)

- `TOOL_CALLING_SYSTEM_PROMPT` simplified to trust SENSOR DATA directives
- `tryParseToolCall(text)` maps structured tool calls to bytecodes
- Parameter scaling from Gemini's 0-255 normalized outputs

### Scene Analysis via Gemini (`src/1_openclaw_cortex/roclaw_tools.ts`)

- `ensureMapInfer()` auto-selects Gemini when `GOOGLE_API_KEY` is available
- Separate `GEMINI_SCENE_THINKING_BUDGET` (default: 1024) for deeper spatial reasoning
- Falls back to Qwen if no Google key

### Dream Consolidation (`src/3_llmunix_memory/dream_inference.ts`)

- Gemini with thinking budget (1024 tokens) for deep strategy analysis
- Auto-detects provider: `DREAM_PROVIDER=gemini` or key-based fallback
- Temperature 0.3 for consistent strategic reasoning

## Gemini vs Qwen: Component Matrix

| Component | Gemini Robotics-ER 1.6 | Qwen-VL | Notes |
|-----------|------------------------|---------|-------|
| Motor control (VisionLoop) | Tool calling + telemetry | Hex bytecode | `--gemini` flag |
| Scene analysis (topo map) | Auto-detected | Fallback | Higher token limit + thinking budget for Gemini |
| Navigation planning | Backend-agnostic | Backend-agnostic | Uses `InferenceFunction` |
| Hierarchical planner | Backend-agnostic | Backend-agnostic | Uses `InferenceFunction` |
| Dream consolidation | Thinking budget | Standard | Auto-detects provider |
| Spatial grounding | `[ymin,xmin,ymax,xmax]` bboxes | N/A | Native in Robotics-ER |
| Code execution | Enabled | N/A | Gated on model name |
| Physics goal confirmation | N/A | N/A | Independent of inference backend |

## Bugs Found & Fixed

### Telemetry Integration (April 2026)
1. **Bearing formula wrong axis** — `atan2(tdx, tdy)` gives 0=+Y but MuJoCo heading 0=+X. Fixed to `atan2(tdy, tdx)`.
2. **LEFT/RIGHT sign convention** — Positive relBearing = CCW = LEFT (not RIGHT). Fixed by swapping labels and CW/CCW mapping.
3. **Rotation speed too low** — Speed 30 (0.185 rad/s) below MuJoCo friction threshold — robot didn't move. Fixed with speed 50-70.
4. **Rotation speed too high** — Speed 100 (~106°/step with coast) caused oscillation overshoot. Reduced to 50-70.
5. **Stuck detection feedback loop** — `handleStepRetry` → planner → "do not move forward" → infinite rotation. Fixed by clearing stale constraints and injecting breakout directives.
6. **External camera black frames** — Camera `xyaxes="1 0 0 0 -1 0"` looked UP. Fixed to `"1 0 0 0 1 0"`.

### Physics Confirmation (March 2026)
1. **Infinity serialization** — `targetDistance: Infinity` became `null` in JSON. Fixed by computing initial distance.
2. **Late polling start** — Polling gated on `handleTool` (30+ seconds). Moved to start before `handleTool`.
3. **Unreliable UDP listener** — One-shot pattern missed responses. Replaced with permanent handler.

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `GOOGLE_API_KEY` | Gemini API key | (required for Gemini) |
| `GEMINI_MODEL` | Model ID | `gemini-robotics-er-1.6-preview` |
| `GEMINI_THINKING_BUDGET` | Motor control thinking tokens | `0` |
| `GEMINI_SCENE_THINKING_BUDGET` | Scene analysis thinking tokens | `1024` |
| `DREAM_PROVIDER` | Force dream backend | Auto-detect |
| `OPENROUTER_API_KEY` | Qwen fallback | (required for Qwen) |

## Running the Simulation

```bash
# Terminal 1: Build scene (one-time)
cd sim && python build_scene.py

# Terminal 2: Start bridge with telemetry + target tracking
npm run sim:3d

# Terminal 3: Open browser (MuJoCo 3D scene)
open http://localhost:8000?bridge=ws://localhost:9090

# Terminal 4: Run cognitive stack with Gemini Robotics-ER 1.6
npx tsx scripts/run_sim3d.ts --gemini --goal "navigate to the red cube"
```

The bridge pushes telemetry (pose, bearing, distance) every 500ms. The VisionLoop injects this as SENSOR DATA into each VLM prompt. The cognitive stack confirms arrival via physics when within 0.25m of the target.
