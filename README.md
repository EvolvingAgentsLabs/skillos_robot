<p align="center">
  <img src="assets/RoClaw.png" alt="RoClaw Logo" width="280">
</p>

# RoClaw

**The Physical Embodiment for OpenClaw**

> **Note to OpenClaw Users:** RoClaw is a drop-in Hardware Node. You do not need to modify your OpenClaw Gateway. Just run RoClaw on the same network, and your digital assistant will automatically detect its new physical body.

You already use [OpenClaw](https://github.com/openclaw/openclaw) to manage your digital life. Now, let it manage your physical space.

RoClaw is a 20cm cube robot that gives OpenClaw a body. Tell it "go check the kitchen" via WhatsApp, and it drives there — using a VLM that outputs raw motor bytecode.

## The Dual-Brain Architecture

RoClaw uses a biological dual-brain design: a slow-thinking **Cortex** for strategy and a fast-reacting **Cerebellum** for motor control.

```mermaid
graph TD
    USER[User via WhatsApp/Voice] -->|"Go check the kitchen"| OC[OpenClaw Gateway]
    OC -->|WebSocket| CORTEX[1. Cortex — OpenClaw Node]
    CORTEX -->|"Goal: navigate_to kitchen"| CEREBELLUM[2. Cerebellum — Local Qwen-VL]
    CEREBELLUM -->|"Sees camera frame"| COMPILE[Bytecode Compiler]
    COMPILE -->|"AA 01 64 64 CB FF"| ESP[ESP32-S3 Steppers]
    ESP -->|"Robot moves"| WORLD((Physical World))
    CEREBELLUM -->|"Experience trace"| MEMORY[3. LLMunix Memory]
    MEMORY -.->|"Learned skills (Phase 2)"| CORTEX
```

### The Trinity

| Project | Role | Brain Region | Speed |
|---------|------|-------------|-------|
| **OpenClaw** | Digital agent platform | Cortex | Seconds |
| **[LLMunix](https://github.com/EvolvingAgentsLabs/llmunix-starter)** | Memory & evolution engine | Hippocampus | Persistent |
| **RoClaw** | Physical robot body | Cerebellum | Sub-second |

## Navigation Chain of Thought

RoClaw introduces a **Chain of Thought for Robot Navigation** — a structured reasoning pipeline where a VLM reasons step-by-step through spatial understanding, just like LLM chain-of-thought works for text reasoning, but grounded in the physical world.

```mermaid
graph LR
    S["What do I see?"] -->|Scene Analysis| M["Have I been here?"]
    M -->|Location Matching| N["Where should I go?"]
    N -->|Navigation Planning| C["Motor Command"]
    C -->|Bytecode Compiler| B["AA 04 B4 64 D4 FF"]
```

Each step builds on the previous one:

1. **Scene Analysis** — The VLM interprets the camera frame (or text description) and extracts a location label, visual features, and navigation hints (exits, doors, paths).
2. **Location Matching** — The VLM compares the current scene against all known nodes in the topological map to determine if the robot has been here before.
3. **Navigation Planning** — Given the semantic map, current location, and target destination, the VLM reasons about which motor action to take.
4. **Bytecode Compilation** — The VLM's text command (`FORWARD 150 150`) compiles to a 6-byte motor frame (`AA 01 96 96 01 FF`).

The **Semantic Map** is the robot's working memory — a topological graph where nodes are locations (identified by their visual features) and edges are navigation paths between them. It accumulates as the robot explores, enabling re-identification of visited places and multi-hop path planning.

### E2E Validation (no hardware required)

The navigation chain of thought is validated with complementary E2E test suites — **no camera or hardware required**.

**Text-based tests** — Hand-written scene descriptions simulate camera input. Fast, deterministic, tests the semantic reasoning pipeline:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
npm test -- --testPathPattern=semantic-map.e2e
```

**Vision tests** — Real indoor photographs (CC0-licensed, from [Kaggle House Rooms Dataset](https://www.kaggle.com/datasets/robinreni/house-rooms-image-dataset)) are fed through the full production pipeline: `image → VLM description → SemanticMap analysis → map building → navigation → bytecode`:

```bash
# One-time: download fixture images
KAGGLE_USERNAME=... KAGGLE_KEY=... npx tsx __tests__/navigation/fixtures/download-kaggle-rooms.ts
# Run vision tests
npm test -- --testPathPattern=semantic-map-vision
```

**Outdoor tests** — Real walking-route captures with sequential frames and compass heading data:

```bash
npm test -- --testPathPattern=semantic-map-outdoor
```

**Synthetic tests** — Mock VLM inference with realistic JSON responses. Validates the Jaccard pre-filter, full Navigation CoT pipeline, and bytecode compilation **without any API key**:

```bash
npm test -- --testPathPattern=semantic-map-synthetic
```

**Test results with `qwen/qwen3-vl-8b-thinking`:**

| Capability | Text Tests | Vision Tests |
|------------|-----------|--------------|
| Scene analysis (kitchen, bedroom, hallway) | Correct labels + features | Correct from real photos |
| Location matching (same location, 2 angles) | `isSameLocation: true, confidence: 0.9` | `isSameLocation: true, confidence: 0.9` |
| Location distinction (kitchen vs bedroom) | `isSameLocation: false, confidence: 0.99` | `isSameLocation: false, confidence: 0.99` |
| Map building (multi-room exploration) | 5 nodes, 6 edges, revisit detection | 3 nodes, 2 edges from real images |
| Navigation planning (→ kitchen) | `TURN_RIGHT 180 100` | `TURN_RIGHT 100 180` |
| Full pipeline (→ bytecode) | `FORWARD 150 150` → `AA 01 96 96 01 FF` | `TURN_RIGHT 100 180` → `AA 04 64 B4 D4 FF` |
| Direct vision (image → SemanticMap) | N/A | Images passed directly to `analyzeScene()` |
| Pathfinding across built map | BFS shortest path works | BFS shortest path works |

**Synthetic tests (no API key needed):**

| Capability | Result |
|------------|--------|
| Jaccard pre-filter skips dissimilar nodes | kitchen vs bedroom → skipped (similarity < 0.15) |
| Jaccard pre-filter passes similar nodes | kitchen vs kitchen-from-table → VLM called |
| Full CoT pipeline (analyze → match → plan → compile) | Valid 6-byte bytecode frame |
| Map building with revisit detection | 4-room walkthrough → 3 nodes, correct revisit |
| Permissive compiler (trailing punctuation) | `"FORWARD 150, 150."` → `AA 01 96 96 01 FF` |
| Serialization round-trip | `toJSON()`/`loadFromJSON()` preserves fingerprints |

## Zero-Latency Bytecode

The killer feature: Qwen-VL generates motor commands as raw hex bytecode. No JSON parsing on the ESP32.

```
JSON (58 bytes):     {"cmd":"move_cm","left_cm":10,"right_cm":10,"speed":500}
Bytecode (6 bytes):  AA 01 64 64 CB FF
```

6 bytes. One `memcpy` into a struct. ~0.1ms parse time vs ~15ms for JSON.

### ISA v1 — 13 Opcodes

| Opcode | Name | Params |
|--------|------|--------|
| `0x01` | MOVE_FORWARD | speed_L, speed_R |
| `0x02` | MOVE_BACKWARD | speed_L, speed_R |
| `0x03` | TURN_LEFT | speed_L, speed_R |
| `0x04` | TURN_RIGHT | speed_L, speed_R |
| `0x05` | ROTATE_CW | degrees, speed |
| `0x06` | ROTATE_CCW | degrees, speed |
| `0x07` | STOP | hold_torque, - |
| `0x08` | GET_STATUS | - |
| `0x09` | SET_SPEED | max_speed, accel |
| `0x0A` | MOVE_STEPS_L | hi, lo |
| `0x0B` | MOVE_STEPS_R | hi, lo |
| `0x10` | LED_SET | R, G |
| `0xFE` | RESET | - |

## Recent Improvements

- **Inference Heartbeat** — GET_STATUS keepalive during slow VLM inference prevents ESP32 timeout
- **Feature Pre-Filter** — Jaccard similarity pre-filter skips obviously-different map nodes, reducing VLM API calls
- **Permissive Compiler** — Text commands with trailing punctuation, commas, or markdown formatting now compile
- **Frame Timestamps** — Frame history tracks capture time; `flushFrameHistory()` clears stale frames after emergency stop
- **UDP Diagnostics** — Sequence numbers and dropped-frame counter for reliability monitoring
- **Dreaming Engine** — `npm run dream` extracts recurring motor patterns from traces and promotes them to skills
- **ESP32 IP Filtering** — Optional `CORTEX_IP` allowlist on firmware rejects unauthorized UDP senders

## Quickstart

### Software Only (no hardware needed)

```bash
git clone https://github.com/EvolvingAgentsLabs/RoClaw.git
cd RoClaw
npm install
cp .env.example .env    # Add your OpenRouter API key
npm run type-check      # Verify TypeScript compiles
npm test                # Run test suite
```

### With Hardware

1. Print the chassis from `5_hardware_cad/stl_files/`
2. Assemble per the [BOM](5_hardware_cad/BOM.md)
3. Flash `4_somatic_firmware/esp32_s3_spinal_cord/` to ESP32-S3
4. Flash `4_somatic_firmware/esp32_cam_eyes/` to ESP32-CAM (or use an [Android phone as a camera](docs/05-Camera-Setup.md))
5. Update `.env` with ESP32 IP addresses and camera path (see [Camera Setup Guide](docs/05-Camera-Setup.md))
6. `npm run dev`

## The Robot

A 20cm 3D-printed cube with two stepper motors and a camera.

<p align="center">
  <img src="assets/image1.jpeg" alt="Base with motors and wheels" width="250">
  <img src="assets/image2.jpeg" alt="Components and workbench" width="250">
  <img src="assets/image3.jpeg" alt="Assembled chassis with camera window" width="250">
</p>

| Component | Spec |
|-----------|------|
| Chassis | 20cm cube, PLA (<200g print) |
| Motors | 2x 28BYJ-48 (4096 steps/rev) |
| Wheels | 6cm diameter |
| Camera | ESP32-CAM, 320x240 @ 10fps |
| Motor MCU | ESP32-S3-DevKitC-1 |
| Top speed | ~4.7 cm/s |
| Protocol | 6-byte UDP bytecode |

## Project Structure

```
RoClaw/
├── src/
│   ├── 1_openclaw_cortex/       # LLM 1: OpenClaw Gateway Node
│   ├── 2_qwen_cerebellum/       # LLM 2: VLM Motor Controller
│   ├── 3_llmunix_memory/        # Dreaming Engine & Memory
│   └── shared/                  # Kinematics, safety, logger
├── 4_somatic_firmware/          # C++ for ESP32 MCUs
├── 5_hardware_cad/              # STL files & Blender scene
├── scripts/
│   └── dream.ts                    # Dreaming Engine — pattern extraction
├── docs/                        # Architecture documentation
└── __tests__/
    └── navigation/
        ├── semantic-map.e2e.test.ts             # Text-based E2E tests
        ├── semantic-map-vision.e2e.test.ts      # Vision E2E tests (real images)
        ├── semantic-map-outdoor.e2e.test.ts     # Outdoor route E2E tests
        ├── semantic-map-synthetic.e2e.test.ts   # Synthetic E2E tests (no API key)
        └── fixtures/indoor_scenes/              # CC0 room photographs
```

The numbered folders encode the architecture:

1. **Cortex** — The slow thinker. Receives "go to the kitchen" from OpenClaw, translates to a Cerebellum goal.
2. **Cerebellum** — The fast reactor. Sees camera frames, outputs bytecode motor commands at 2 FPS.
3. **LLMunix Memory** — The dreamer. Stores hardware specs, learned skills, execution traces, and the semantic map (topological memory for navigation).
4. **Somatic Firmware** — The spinal cord. Bytecode-only UDP listener on ESP32-S3. MJPEG streamer on ESP32-CAM.
5. **Hardware CAD** — The body. 3D-printable parts and assembly reference.

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Run tests (`npm test`) and type check (`npm run type-check`)
4. Submit a PR

## License

MIT
