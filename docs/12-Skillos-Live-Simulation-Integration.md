# Skillos Live Simulation Integration

**Date**: March 2026
**Status**: Working end-to-end in MuJoCo simulation

---

## Summary

The Cognitive Trinity — skillos (Prefrontal Cortex), RoClaw (Cerebellum), and evolving-memory (Hippocampus) — now runs end-to-end through a live MuJoCo physics simulation. A new HTTP tool server in `run_sim3d.ts` exposes the full cognitive stack as an API, letting skillos agents control the simulated robot in real time.

Previously, skillos could only interact with RoClaw in mock mode (`--simulate`), which returned canned responses. Now, when a skillos agent sends `robot.go_to "the red cube"`, the command flows through the entire pipeline: hierarchical planning, VLM inference on live MuJoCo camera frames, bytecode compilation, UDP transmission, and physics-based motor execution — all observable in a browser.

---

## Architecture

Six services form the full stack:

```
Port    Service                         Role
────    ───────                         ────
:8000   mjswan scene                    MuJoCo WASM + Three.js renderer
:9090   mjswan bridge (WebSocket)       Browser ↔ physics engine
:8081   mjswan bridge (MJPEG)           Camera stream → VisionLoop
:8420   evolving-memory                 Hippocampus (traces, dreams, queries)
:8440   run_sim3d.ts --serve            HTTP tool server (new)
:8430   roclaw_bridge.py --tool-server  skillos ↔ tool server bridge
```

The data flow for a single `robot.go_to` invocation:

```
skillos agent
  │ POST /tool/robot.go_to {"location": "the red cube"}
  ▼
roclaw_bridge.py :8430  (HttpToolClient)
  │ POST /invoke {"tool": "robot.go_to", "args": {"location": "the red cube"}}
  ▼
run_sim3d.ts --serve :8440
  │ handleTool("robot.go_to", {location: "the red cube"}, ctx)
  │   ├─ HierarchicalPlanner decomposes goal into steps
  │   ├─ SemanticMapLoop seeds topological map from camera
  │   └─ VisionLoop starts continuous control loop
  ▼
VisionLoop (2 FPS cycle)
  │ 1. Grab MJPEG frame from :8081
  │ 2. Send frame + goal to Gemini 3.1 Flash Lite
  │ 3. VLM returns tool call: move_forward(128, 128)
  │ 4. BytecodeCompiler → AA 01 80 80 01 FF
  │ 5. UDPTransmitter → :4210
  ▼
mjswan bridge :9090
  │ Translates bytecodes to MuJoCo velocity actuators
  │ Steps physics simulation
  │ Renders frame → MJPEG :8081 (loop closes)
  ▼
Browser (http://localhost:8000?bridge=ws://localhost:9090)
  └─ Real-time 3D view of robot navigating
```

### Three Backend Modes

The bridge (`roclaw_bridge.py`) supports three backend strategies, all transparent to skillos agents:

| Flag | Backend | Use case |
|------|---------|----------|
| `--tool-server http://localhost:8440` | HTTP to `run_sim3d.ts --serve` | Live MuJoCo simulation with full VLM |
| `--gateway ws://localhost:8080` | WebSocket to OpenClaw Gateway | Real hardware |
| `--simulate` | Mock responses | Agent logic testing, no hardware |

Skillos agents always POST to `:8430/tool/robot.*` regardless of which backend is active.

---

## What We Built

### HTTP Tool Server (`--serve` mode)

Added to `scripts/run_sim3d.ts`:

- **`GET /health`** — Returns status and list of 9 available tools
- **`POST /invoke`** — Accepts `{tool, args}`, calls `handleTool()` with the shared ToolContext (compiler, transmitter, visionLoop, inference), returns the result
- **`POST /shutdown`** — Graceful shutdown with optional dream consolidation

The ToolContext is initialized once at startup. All incoming invocations share the same VisionLoop, BytecodeCompiler, UDPTransmitter, and Gemini inference — no per-request overhead.

Uses Node's built-in `http` module. Zero new dependencies.

### HttpToolClient (bridge side)

Added to `roclaw_bridge.py`:

- Implements the same `connect()` / `invoke_tool()` / `close()` interface as `GatewayClient` and `SimulationClient`
- `connect()` verifies the tool server via `GET /health`
- `invoke_tool()` sends `POST /invoke` with `{tool, args}`
- Uses Python stdlib `urllib.request`. Zero new dependencies.

---

## Test Results

### Fresh Simulation Run

Starting from a clean state (no prior navigation, empty topo map):

| Test | Result |
|------|--------|
| Health checks (3 services) | All responded `ok` |
| `robot.get_map` (before nav) | 0 entries, 0 topo nodes |
| `robot.describe_scene` | VLM read live MuJoCo camera frame |
| `robot.go_to "the red cube"` | Navigation started, planner activated |
| VLM bytecode flow | `rotate_cw`, `turn_right`, `move_forward` at ~2 FPS |
| `robot.analyze_scene` (mid-nav) | Confidence 0.95, features: `[grid floor, red cube, yellow cylinder, green cube]` |
| `robot.describe_scene` (mid-nav) | "A red cube is positioned in the center of the frame" |
| `robot.status` (physics) | `targetName: "red_cube"`, distance decreasing |
| Distance tracking | 1.77m → 1.01m → 0.79m → 0.60m → 0.38m → 0.27m |
| `robot.get_map` (after nav) | 24 topo nodes built during navigation |

### Distance to Target Over Time

```
1.77m ─────────────────────── start
  │
1.01m ───────────────── T+10s (scanning, found target)
  │
0.79m ─────────────── T+20s (driving forward)
  │
0.60m ───────────── T+30s
  │
0.38m ─────────── T+40s
  │
0.27m ────────── T+50s (closest approach)
  │
0.38m ─────────── T+60s (overshot, correcting)
```

The robot navigated from 1.77m to 0.27m from the red cube — just outside the 0.25m arrival threshold. The VLM successfully identified the target, planned an approach, and drove toward it through the physics simulation.

### Topological Map

The VLM built a 24-node topological map during the navigation session, describing locations like:

- `loc_2` — "Illuminated passage: A dark, constrained passage with a checkerboard floor"
- `loc_4` — "Virtual testing environment: checkerboard floor, low-profile red object, large vertical pillar"
- `loc_7` — "Testing chamber: reddish-orange vertical plane and dark gray gridded floor"
- `loc_22` — "Void grid plane: high-contrast black-and-white checkered floor"

Each node includes features, navigation hints, position, and a feature fingerprint for re-identification.

---

## Nine Robot Tools

All 9 tools work through the full chain:

| Tool | Purpose | Verified |
|------|---------|----------|
| `robot.go_to` | Navigate to a location | Full VLM navigation loop |
| `robot.explore` | Autonomous exploration | VisionLoop + topo mapping |
| `robot.describe_scene` | VLM scene description | Live camera frame analysis |
| `robot.analyze_scene` | Deep scene analysis with features | Structured location data |
| `robot.stop` | Emergency halt | Sends STOP bytecode `AA 07 00 00 07 FF` |
| `robot.status` | Physics pose + distance | Reports x, y, heading, targetDistance |
| `robot.read_memory` | Robot memory context | Hardware profile + strategies |
| `robot.record_observation` | Label current location | Adds to PoseMap |
| `robot.get_map` | Topological + pose map | Full graph with 24 nodes |

---

## How to Run

### Prerequisites

- Node.js, Python 3.12
- `GOOGLE_API_KEY` set in `RoClaw/.env`

### Launch Sequence

```bash
# Terminal 1: MuJoCo scene (already built)
cd RoClaw/sim && python build_scene.py
# Open http://localhost:8000?bridge=ws://localhost:9090

# Terminal 2: Physics bridge
cd RoClaw && npm run sim:3d

# Terminal 3: Shared memory (optional, needed for dream consolidation)
cd evolving-memory && python -m evolving_memory.server --port 8420

# Terminal 4: HTTP tool server
cd RoClaw && npx tsx scripts/run_sim3d.ts --serve --gemini

# Terminal 5: Skillos bridge
cd skillos && python roclaw_bridge.py --port 8430 --tool-server http://localhost:8440

# Terminal 6: Test
curl http://localhost:8430/health
curl -X POST http://localhost:8430/tool/robot.describe_scene
curl -X POST http://localhost:8430/tool/robot.go_to \
  -H "Content-Type: application/json" \
  -d '{"location": "the red cube"}'
```

---

## Known Limitations

1. **VLM arrival detection**: Gemini 3.1 Flash Lite doesn't reliably issue STOP when very close to the target. The robot reaches 0.27m but oscillates instead of stopping at the 0.25m physics threshold. The physics engine tracks `goalReached` correctly — the gap is in VLM behavior, not in the wiring.

2. **Single-threaded tool server**: The HTTP server handles one request at a time. Long-running tools like `go_to` return immediately (navigation continues in background), but concurrent `/invoke` calls to the same tool could conflict.

3. **No streaming updates**: The `/invoke` endpoint returns a single response. There's no WebSocket or SSE stream for real-time navigation progress. Clients must poll `robot.status` to track distance.

---

## Next Steps

1. **Real hardware testing**: The same `--tool-server` mode should work with the physical ESP32-S3 robot by running `run_sim3d.ts --serve` without the `sim:3d` bridge (pointing at real camera and UDP endpoints). The HttpToolClient in the bridge doesn't care whether the tool server talks to MuJoCo or real motors.

2. **VLM arrival behavior**: Fine-tune the Gemini prompt or add a distance-based override in VisionLoop that forces STOP when `targetDistance < threshold`, bridging the gap between physics ground truth and VLM perception.

3. **Dream consolidation loop**: After navigation sessions, trigger dream consolidation through evolving-memory to extract strategies and negative constraints from the SIM_3D traces. These strategies should improve subsequent navigation attempts.

4. **Multi-goal sequences**: Skillos agents should be able to chain multiple tool calls (describe → go_to → analyze → record_observation) in a single execution, building up the semantic map across sessions.

5. **Obstacle avoidance refinement**: The current scene has a purple obstacle, green obstacle, and yellow cylinder alongside the red cube target. Future tests should validate that the robot correctly navigates around obstacles to reach the target.
