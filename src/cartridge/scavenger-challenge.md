# Scavenger challenge — real-world counterpart to llm_os/cart/game/scavenger

The [Scavenger game](https://github.com/EvolvingAgentsLabs/llm_os/blob/main/cart/game/scavenger/full.md) in `llm_os` is a deliberate proxy for a physical robot challenge. The same prompt, the same opcode set, and the same compiled-state shape that drive a 350M-parameter LLM through the JS grid demo also drive a real or simulated robot through this cartridge — only the source of the compiled state changes.

## The task

A red cube is placed somewhere in the robot's arena. A blue square (a coloured floor mat, a marked corner) is placed elsewhere. The robot must:

1. Observe the scene, locate the red cube.
2. Drive to within arrival-threshold distance of the red cube.
3. Drive to within arrival-threshold distance of the blue square.

(The current robot has no gripper, so "pickup" / "deliver" become "arrive at target" / "arrive at destination". Once an arm cartridge ships, replace these with real grasps.)

## How the existing cartridge methods cover it

| Game step | Cartridge method | Backing subsystem |
|---|---|---|
| Observe scene | `robot.observe({})` | `SceneGraph.toJSON()` (live, written by SemanticLoop @ 1–2 Hz) |
| Plan path to red cube | `robot.navigate({goal: "red_cube"})` | `HierarchicalPlanner.planGoal()` decomposes |
| Execute path | (not a cartridge call — integrator pipes plan steps into the reactive loop) | `ReactiveController` @ 20 Hz, bytecode → ESP32 |
| Confirm arrival | `robot.observe({})` again | SceneGraph distance to red_cube node |
| Plan path to blue square | `robot.navigate({goal: "blue_square"})` | same planner |
| Emergency abort if needed | `robot.stop({})` | UDP STOP frame, bypasses reactive loop |

No new methods needed. The 5 cartridge methods (`stop`, `observe`, `describe`, `set_speed`, `navigate`) wired in commits `01e40f9`–`bc4c340` cover the entire challenge.

## Compiled-state parity with the JS demo

The LLM-CPU side prompt is the same in both worlds. What changes is the *source* of the compiled state:

```
JS Scavenger (browser)        ──→  Real Scavenger (this robot)
─────────────────────────         ─────────────────────────────────
analyzeScene() over JS grid    ↔  SceneGraph.toJSON() over real VLM detections
bearing N/NE/E/...             ↔  bearing computed from heading + target.position
Manhattan distance             ↔  Euclidean distance (cm)
walls / pits in level data     ↔  obstacle nodes in SceneGraph + reflex_guard veto
move budget                    ↔  wall-clock budget OR step counter
```

Both produce the same JSON shape:

```json
{
  "pos": [3.2, 5.1],
  "carrying": null,
  "step": 12,
  "objects": [
    { "label": "red_cube",    "at": [120, 35], "bearing": "NE", "dist": 142 },
    { "label": "blue_square", "at": [40, 220], "bearing": "SW", "dist": 195 }
  ],
  "quest": "navigate to red_cube, then to blue_square",
  "hint": "approach red_cube — heading NE, dist 142cm"
}
```

The LLM cannot distinguish the two — and that's the point.

## How to run the challenge

### 1. Simulator (no hardware needed)

```bash
# Terminal 1 — start the cartridge adapter against the MuJoCo sim.
# (Today: stop is wired; observe/describe/set_speed/navigate need
# setRobotState() integration in the embedded host process —
# see src/cartridge/README.md "Integration" section.)
npm run cartridge -- --port 7424

# Terminal 2 — drive the challenge from any cartridge client. Below is
# a minimal Node script that issues the four cartridge calls in order.
```

```js
// scripts/scavenger_smoke.mjs (sketch — write this once the integrator
// hookup lands)
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:7424/cartridge');
const inflight = new Map();

ws.on('open', async () => {
  const obs = await call('observe', {});
  console.log('scene:', obs.objects.map(o => `${o.label}@(${o.at})`).join(', '));

  const planA = await call('navigate', { goal: 'red_cube', timeout_s: 60 });
  console.log('plan to red_cube:', planA.step_count, 'steps');
  // (integrator pipes plan into reactive loop here — out of scope of
  //  the cartridge contract; see src/cartridge/README.md)

  const planB = await call('navigate', { goal: 'blue_square', timeout_s: 60 });
  console.log('plan to blue_square:', planB.step_count, 'steps');
});

function call(method, args) {
  return new Promise((resolve, reject) => {
    const id = `r${Math.random().toString(36).slice(2)}`;
    inflight.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, type: 'call', cartridge: 'robot', method, args }));
  });
}

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'progress') return;  // ignore for smoke
  const p = inflight.get(msg.id);
  if (!p) return;
  inflight.delete(msg.id);
  msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error?.message));
});
```

### 2. Real arena (hardware)

Same client, different physical setup. The integrator's host process registers the live UDPTransmitter, SceneGraph, ReactiveController, and HierarchicalPlanner via `setRobotState()` — once that's wired, the four cartridge calls drive a real robot through a real challenge.

## Why this exists

Three reasons:

1. **Cross-context validation.** If the same LLM-CPU plays the JS Scavenger and the real Scavenger with the same prompt, the kernel + cartridge model is generic across worlds. That's the load-bearing claim of the OS/Program separation.

2. **Cheap iteration on the harder version.** The JS demo runs in 5 seconds; a real-world test takes 5 minutes per attempt. Develop strategy hints, scene-summarisation tweaks, and prompt changes in the JS demo first; transfer to the robot once they pay off.

3. **Demonstrates the SkillOS thesis.** A single Recipe (a sequence of cartridge calls + agent reasoning) drives outcomes in both information-space (the grid) and physical-space (the arena). The Recipe doesn't change; only the cartridge backend changes.

## Status

- **JS Scavenger** (in `llm_os/demo/scavenger-browser/`): runs end-to-end, plays itself.
- **JS Scavenger bundled into skillos_mini** (at `mobile/public/demos/scavenger/`): runs in the mobile app's static-asset bundle.
- **Real Scavenger** (this doc): cartridge methods exist; the integrator wiring step (registering live SceneGraph / ReactiveController / Planner via `setRobotState()`) is the remaining hookup. See `src/cartridge/README.md` "Integration" section.
