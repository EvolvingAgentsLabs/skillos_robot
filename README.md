# robot

Navigate a real or simulated robot with vision language models.
Give it a goal in plain language — it sees through the camera, reasons about the scene, and drives to the target.

Part of the [Evolving Agents](https://github.com/EvolvingAgentsLabs) ecosystem.

## Install

```bash
git clone https://github.com/EvolvingAgentsLabs/skillos_robot.git
cd skillos_robot && npm install
```

## Use

```bash
# Navigate in simulation (cloud teacher — Gemini)
robot navigate "go to the red cube"

# Navigate with first-person camera (no IMU required)
robot navigate --egocentric "go to the red cube"

# Navigate with local model (no internet)
robot navigate --local "go through the doorway"

# Start simulation server only
robot sim --serve

# Dream consolidation — retry failed traces overnight
robot dream

# Test hardware connection (ESP32-S3)
robot test

# Show status
robot status
```

### Prerequisites for simulation

```bash
# Terminal 1 — build and serve the MuJoCo scene
cd sim && python build_scene.py

# Terminal 2 — start the bridge
robot sim --serve

# Terminal 3 — open browser
open http://localhost:8000?bridge=ws://localhost:9090
```

### Prerequisites for hardware

```bash
# Flash firmware/roclaw_unified/ to your ESP32-S3-CAM
# (requires PlatformIO: pio run -t upload)
echo "ROBOT_IP=192.168.1.42" > .env
robot test
```

## How it works

Two decoupled loops run concurrently:
- **Semantic loop** (1–2 Hz) — a VLM perceives the scene and updates a shared SceneGraph
- **Reactive loop** (10–20 Hz) — a deterministic controller reads the SceneGraph and emits 6-byte motor commands over UDP to the ESP32-S3

Two control modes:
- **Overhead** (default) — external camera views the arena from above, SceneGraph coordinates, IMU-aided heading
- **Egocentric** (`--egocentric`) — first-person camera only. Target position in frame drives turns/forward. No IMU, no absolute coordinates. "If the target is left of center, turn left."

Every run produces a YAML-frontmatter markdown trace. Failed traces get retried in MuJoCo simulation during dream consolidation and fed back as training data.

Two inference backends:
- **Gemini** — cloud teacher. Collects traces + benchmarks. Default.
- **Ollama** — local student. Qwen3-VL via Ollama. No internet. Use `--local` flag.

## Architecture

Full 5-tier stack, perception policies, memory system, and hardware spec:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

Operator guide: [docs/USAGE.md](docs/USAGE.md)
Build a scene: [docs/TUTORIAL.md](docs/TUTORIAL.md)
Roadmap: [docs/NEXT_STEPS.md](docs/NEXT_STEPS.md)

## License

Apache 2.0
