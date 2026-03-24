# When a Markdown File Drives a Robot Through a Physics Simulation

**A robot just navigated to a red cube in a MuJoCo physics simulation — and the command that triggered it was plain text flowing through a pure markdown operating system.**

---

## The Cognitive Trinity

We built a three-part architecture inspired by the human brain, where each component handles a different cognitive function:

**SkillOS (Prefrontal Cortex)** — Created by Ismael Faro at Evolving Agents Labs, SkillOS is a pure markdown operating system where agents and tools are defined entirely as markdown documents. No compiled code, no complex APIs — just markdown that any LLM can interpret to become a powerful problem-solving system. When a SkillOS agent writes `robot.go_to "the red cube"`, it has no idea whether it's talking to a simulation, a real robot, or a mock. It just reasons about goals.

**RoClaw (Cerebellum)** — The physical robot and its VLM-powered motor control stack. A Gemini 3.1 Flash Lite vision-language model looks at live camera frames 2 times per second, decides what motor command to issue, and compiles that decision into 6-byte bytecodes that drive differential-drive wheels. This is reactive, fast, and low-level — like a cerebellum handling balance and movement without conscious thought.

**evolving-memory (Hippocampus)** — A shared cognitive trajectory engine that stores execution traces, runs bio-inspired dream consolidation (modeled on biological SWS and REM sleep), and extracts reusable navigation strategies. Between sessions, the system literally "dreams" to consolidate what it learned.

---

## How It Works: Six Services, One Goal

When a SkillOS agent says "navigate to the red cube," this is what happens across six networked services:

```
SkillOS Agent (markdown reasoning)
  |
  v
RoClaw Bridge (:8430) — translates REST to tool invocations
  |
  v
HTTP Tool Server (:8440) — shared VLM context, planner, compiler
  |
  v
VisionLoop (2 FPS):
  1. Grab camera frame from MuJoCo simulation
  2. Send frame + goal to Gemini 3.1 Flash Lite
  3. VLM returns: move_forward(128, 128)
  4. Compile to bytecode: AA 01 80 80 01 FF
  5. Transmit via UDP
  |
  v
MuJoCo Physics Engine — steps simulation, renders frame
  |
  v
Browser — real-time 3D visualization
```

The command flows through hierarchical planning, VLM inference on live camera frames, bytecode compilation, UDP transmission, and physics-based motor execution — all observable in a browser at `localhost:8000`.

---

## The Test: Fresh Simulation, Real Navigation

Starting from a clean state — no prior navigation data, empty topological map:

| Metric | Result |
|--------|--------|
| Initial distance to target | 0.78m |
| Goal reached | **Yes** (distance 0.22m < 0.25m threshold) |
| Time to arrival | ~8 seconds |
| Position stability | Rock solid, no oscillation |
| Topological nodes built | 37 (semantic map of the environment) |
| VLM scene description at target | "A bright, solid red surface dominates the view" |

The robot started at the origin, the VLM identified "red cube directly ahead, no obstacles blocking the path," drove forward, and stopped within 0.22m of the target. `goalReached: true`.

---

## Why Markdown Matters for Robotics

The key insight from SkillOS — Ismael Faro's project — is that the planning layer doesn't need to be code. A SkillOS navigation agent is a markdown file that defines:

- **When to check the scene** before moving
- **How to handle obstacles** (wait for the cat to move, reroute around furniture)
- **When to consult memory** for past navigation strategies
- **How to create new tools at runtime** when encountering novel situations

The robot's recovery behaviors aren't pre-programmed — they emerge from LLM interpretation of markdown specifications. If the robot encounters a new kind of obstacle, SkillOS can dynamically create a new recovery tool as markdown and immediately use it. The system evolves its capabilities without recompilation.

This is the same pattern that's emerging across the AI agent ecosystem: markdown as the universal interface for agent capabilities, replacing heavyweight server protocols with plain text that any LLM can read and execute.

---

## The Stack is Open Source

All three components are open source under Evolving Agents Labs:

- **SkillOS**: github.com/EvolvingAgentsLabs/skillos
- **RoClaw**: github.com/EvolvingAgentsLabs/RoClaw
- **evolving-memory**: github.com/EvolvingAgentsLabs/evolving-memory

Nine robot tools work through the full chain: `go_to`, `explore`, `describe_scene`, `analyze_scene`, `stop`, `status`, `read_memory`, `record_observation`, `get_map`. The bridge supports three backends — live MuJoCo simulation, real ESP32-S3 hardware, or mock mode — all transparent to the SkillOS agents above.

---

## What's Next

1. **Real hardware**: The same HTTP tool server mode should work with the physical 3D-printed robot — the bridge doesn't care whether it's talking to MuJoCo or real motors.

2. **Dream consolidation loop**: After navigation sessions, trigger dream consolidation to extract strategies from SIM_3D traces. The next time the robot faces a similar goal, it starts with learned strategies instead of from scratch.

3. **Multi-goal sequences**: Chain tool calls — describe, navigate, analyze, record — to build rich semantic maps across sessions.

4. **Obstacle avoidance**: The current scene has obstacles (purple box, green box, yellow cylinder). Next tests will validate navigation around them to reach the target.

The Cognitive Trinity shows that you can wire a markdown-based reasoning layer to a VLM-powered motor cortex through a shared memory system — and the robot actually reaches its goal in a physics simulation. The gap between "AI agent" and "physical robot" is narrower than you think.

---

*Built with SkillOS by Ismael Faro, RoClaw and evolving-memory by Evolving Agents Labs. Powered by Gemini 3.1 Flash Lite for VLM inference, MuJoCo for physics simulation, and Claude for development.*

#AI #Robotics #LLM #VisionLanguageModels #MuJoCo #OpenSource #EvolvingAgents #SkillOS #AgenticAI
