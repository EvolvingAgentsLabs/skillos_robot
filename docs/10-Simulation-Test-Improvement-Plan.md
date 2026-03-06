# Simulation & Test Suite Improvement Plan

Areas that need attention and can be improved without hardware — only simulation
and test code changes required.

---

## Priority 1 — Critical Gaps

### 1.1 virtual_roclaw.ts has no direct tests

The simulator itself (`src/virtual_roclaw.ts`) is never tested directly. It is
only exercised indirectly through scripts. A dedicated test suite should cover:

- **Pose tracking accuracy**: send MOVE_FORWARD → assert (x, y) delta matches
  `StepperKinematics` predictions.
- **Rotation**: send ROTATE_CW with degrees param → assert heading change.
- **Differential steering**: different left/right speeds → assert curved path.
- **Command history cap**: send 100 commands → assert history stays at 50.
- **Malformed frame handling**: send 4-byte / 8-byte / empty UDP → assert no crash.
- **LED_SET, RESET, GET_STATUS opcodes**: assert state response is correct.

**File to create:** `__tests__/simulation/virtual-roclaw.test.ts`

### 1.2 No full-loop integration test (bytecode → sim → pose)

No test currently sends a bytecode frame through UDP to virtual_roclaw and reads
back the resulting pose via GET_STATUS. This is the most important sim-only
integration gap.

**Test outline:**
1. Start virtual_roclaw UDP server on a random port.
2. Send `encodeFrame(Opcode.MOVE_FORWARD, 128, 128)` via UDP.
3. Wait one pulse duration.
4. Send `encodeFrame(Opcode.GET_STATUS, 0, 0)`.
5. Assert response contains non-zero x or y.
6. Tear down.

### 1.3 E2E navigation tests skip silently in CI

The four navigation E2E tests all skip when API keys are absent. The synthetic
test (`semantic-map-synthetic.e2e.test.ts`) is the only one that runs without
keys, but it alone cannot validate the full chain-of-thought pipeline.

**Fix:** Add a `--mock-inference` mode to the test harness (reusing the mock
server from `virtual_roclaw.ts`) so that text-based and vision E2E tests can run
with deterministic canned responses and no API key.

---

## Priority 2 — Simulation Fidelity

### 2.1 Instant velocity changes (no motor ramp)

`virtual_roclaw.ts` applies speed changes instantly. Real 28BYJ-48 steppers have
acceleration limits. Add a configurable acceleration ramp:

```
currentSpeed += sign(targetSpeed - currentSpeed) * accelRate * dt
```

This matters for strategy learning — the Dream Engine will extract different
patterns from sim traces if the sim doesn't model ramp-up.

### 2.2 No collision model in virtual_roclaw

The robot passes through walls. Even a simple 2D bounding-box collision map
(loaded from a JSON floor plan) would catch obstacle-avoidance strategy bugs
that currently slip through.

### 2.3 No UDP packet-loss simulation

Real UDP drops frames. Add a configurable `dropRate` (0.0–1.0) to the virtual
ESP32-S3 so tests can validate that the stack degrades gracefully under loss.

### 2.4 Pose drift accumulation

No test sends 500+ commands and checks cumulative odometry error. Over long
runs, floating-point drift in heading integration may compound. A regression test
should assert bounded drift after a closed-loop path (forward → rotate 360° →
forward → check return to origin within tolerance).

---

## Priority 3 — Test Quality & Assertions

### 3.1 Strengthen weak assertions

Many tests use `toBeDefined()` / `toBeTruthy()` / `not.toBeNull()` where a
concrete value is available. Examples worth tightening:

| File | Current | Better |
|------|---------|--------|
| `cortex/roclaw-tools.test.ts` | `expect(result.success).toBe(true)` | Also assert `result.message` contains expected substring |
| `memory/semantic-map.test.ts` | `expect(result).not.toBeNull()` | Assert `result.label === 'kitchen'` and `result.distance < threshold` |
| `cerebellum/vision-loop.test.ts` | `expect(loop).not.toBeNull()` | Assert `loop.isRunning() === false` initially |

A grep for `toBeDefined\|toBeTruthy\|toBeNull` and review each case.

### 3.2 Mock quality — stop mutating internals

Several tests mutate private properties directly:

```ts
// vision-loop.test.ts
(transmitter as any).connected = true;
(transmitter as any).socket = { send: jest.fn() };
```

Replace with proper mock constructors or use `jest.spyOn()` on public methods.
This prevents tests from silently passing when internal structure changes.

### 3.3 Missing error-path tests

| Component | Untested error path |
|-----------|-------------------|
| VisionLoop | MJPEG stream disconnects mid-frame |
| VisionLoop | Inference returns empty / unparseable response |
| UDPTransmitter | Port already in use (EADDRINUSE) |
| BytecodeCompiler | Unicode / non-ASCII garbage input |
| SemanticMap | `loadFromJSON()` with corrupt / partial data |
| mjswan_bridge | WebSocket closes during command send |

---

## Priority 4 — Missing Test Suites

### 4.1 mjswan_bridge integration tests

Only two test files exist for mjswan (`bytecode-to-velocity.test.ts` and
`mjpeg-server.test.ts`). Missing:

- WebSocket connection lifecycle (connect, disconnect, reconnect).
- Full control loop: send bytecode → receive ctrl values → receive pose.
- Goal confirmation: robot reaches target within euclidean threshold.
- Error recovery: browser crashes mid-session.

Can be tested with a mock WebSocket server (no browser needed).

### 4.2 Dream Engine trace-to-strategy round-trip

`dream-v2.test.ts` tests phases in isolation. No test verifies:

1. Run a simulated session producing traces.
2. Run dream engine on those traces.
3. Assert new strategies appear in the strategy store.
4. Run planner — assert it selects the newly learned strategy.
5. Assert strategy confidence increases after repeated success.

This is a pure in-memory test with mock inference.

### 4.3 Strategy decay / pruning

No test verifies that strategies with declining success rates get their
confidence reduced or pruned by the Dream Engine over multiple dream cycles.

### 4.4 Semantic map serialization edge cases

- Empty map round-trip (zero nodes, zero edges).
- Map with duplicate node IDs.
- Map with edges referencing deleted nodes.
- Very large map (1000 nodes) — assert load time stays under 100ms.

---

## Priority 5 — Performance & Stress

### 5.1 Memory leak regression test

Run VisionLoop for 10,000 frames with mock inference. Assert heap usage stays
within a bound (e.g., < 50 MB growth). Frame history buffer and command history
are the likely leak vectors.

### 5.2 Bytecode compiler throughput

Compile 10,000 text commands sequentially. Assert < 1ms per compile. This
validates that the regex-based parser doesn't have pathological backtracking.

### 5.3 MJPEG server under load

Connect 10 clients to the virtual ESP32-CAM MJPEG server. Assert all receive
frames and none block others. Tests the `res.write()` pipeline.

---

## Priority 6 — Configuration & Hardcoded Values

### 6.1 Extract test-relevant constants

| Value | Location | Issue |
|-------|----------|-------|
| `PULSE_DURATION_S = 0.5` | virtual_roclaw.ts:162 | Should be configurable for faster tests |
| `50ms` GET_STATUS delay | mjswan_bridge.ts:392 | Race condition risk; needs timeout test |
| Target `-0.6, -0.5` | mjswan_bridge.ts:196 | Only one target tested |
| `wheelDiameterCm: 6.0` | stepper-kinematics.test.ts | No test for alternative wheel sizes |
| `'0.0.0.0'` bind address | virtual_roclaw.ts:342 | No localhost-only option for CI |

### 6.2 Jest configuration

`jest.config.js` only scans `__tests__/`. If any colocated `*.test.ts` files
exist in `src/`, they would be missed. Consider adding `'<rootDir>/src'` to
roots, or enforce the convention with a lint rule.

---

## Priority 7 — Safety Enforcement in Simulation

### 7.1 Neither simulator enforces safety-config.ts limits

`safety-config.ts` defines `maxMotorPWM: 200`, `maxContinuousMs: 30000`,
`maxContinuousSteps: 40960`, `emergencyStopCm: 8`, and `hostHeartbeatMs: 2000`.
Neither `virtual_roclaw.ts` nor `mjswan_bridge.ts` enforces any of these. A
command with `paramLeft: 255` is accepted and applied at full speed. A motor that
runs for 60 seconds straight is never stopped.

**Fix:** Wire `clampMotorPWM` and `clampStepperSpeed` from `safety-config.ts`
into `applyCommand()` of `virtual_roclaw.ts`. Add a cumulative motor runtime
tracker that emits an emergency-stop after `maxContinuousMs`. Add corresponding
tests that verify clamped commands and timeout cutoffs.

### 7.2 No host heartbeat timeout simulation

The firmware is designed to emergency-stop if no heartbeat arrives within
`hostTimeoutMs: 5000`. Neither sim enforces this. This means the stack has never
been tested against the real firmware's watchdog behavior.

**Fix:** Add a heartbeat watchdog timer to `virtual_roclaw.ts`. If no UDP
message arrives within the configured timeout, set `motorRunning = false` and
zero speeds. Write a test that starts motors, waits 6 seconds without sending,
and asserts the motors auto-stopped.

### 7.3 Missing battery depletion model

`FirmwareSafetyStatus` includes `lastBatteryVoltage` and the safety config
defines `minBatteryVoltage: 3.0`. Neither sim tracks battery. Over long sim
sessions, strategies will be learned against infinite-energy conditions.

**Fix:** Add a simple linear voltage drain model to `virtual_roclaw.ts`:
`voltage -= commandCount * drainPerCommand`. When voltage drops below threshold,
reject motor commands. Test that long sequences eventually trigger low-battery
stops.

---

## Priority 8 — Sim-to-Real Gap Risks

### 8.1 ROTATE_CW/CCW uses degrees, not physics

`virtual_roclaw.ts:222` applies `state.heading += frame.paramLeft` — treating
paramLeft as exact degrees. The mjswan bridge instead converts to counter-
rotating wheel velocities, producing physically grounded rotation with slip and
overshoot. Real hardware will produce 70–110° for a commanded 90° rotation.

**Fix:** Replace the instant heading change with differential drive physics in
virtual_roclaw (match the mjswan approach). Add a test comparing virtual_roclaw
rotation output against `StepperKinematics.calculateTurnSteps()`.

### 8.2 Motor asymmetry is invisible

Both sims assume left and right motors are perfectly matched. Real 28BYJ-48
units vary in torque. A MOVE_FORWARD with equal params drifts on hardware but
tracks perfectly straight in sim.

**Fix:** Add a configurable `motorBias` parameter (e.g., `leftSpeedMultiplier:
0.95`) to `virtual_roclaw.ts` so tests can validate that the cerebellum's
reactive loop corrects for drift.

### 8.3 Camera produces pose-independent images

`virtual_roclaw.ts` streams a static JPEG regardless of (x, y, heading). The VLM
always "sees" the same scene. This means any strategy that depends on visual
feedback (all navigation) trains against a lie.

**Fix:** For the virtual sim, create a small set of labeled room images and
select which one to stream based on the robot's current (x, y) zone. Even 4–6
zone images would make VLM navigation testable without the mjswan browser.

---

## Priority 9 — Failure Mode Injection

### 9.1 No inference failure testing

The mock inference server in `virtual_roclaw.ts` always returns valid hex. Real
VLM inference can: timeout, return empty, return unparseable text, hit rate
limits (HTTP 429), or return partial JSON.

**Fix:** Add a `--fault-mode` flag to the mock server with modes:
- `timeout` — Respond after 10s delay.
- `empty` — Return `{ choices: [{ message: { content: "" } }] }`.
- `garbage` — Return non-hex, non-JSON text.
- `rate-limit` — Return HTTP 429 on every other request.
- `partial` — Return truncated JSON.

Write tests for each mode validating VisionLoop degrades safely (emits STOP,
retries, does not crash).

### 9.2 No MJPEG stream interruption testing

The virtual cam server delivers perfect frames forever. Real ESP32-CAM streams
drop frames, corrupt JPEG data, and disconnect on Wi-Fi issues.

**Fix:** Add a `--cam-fault` flag with modes:
- `corrupt` — Flip random bytes in JPEG data.
- `stall` — Stop sending frames after N frames.
- `disconnect` — Close the HTTP connection mid-stream.

Test that VisionLoop handles each without crashing.

### 9.3 No WebSocket reconnection testing for mjswan bridge

The bridge has no reconnection logic. If the browser tab closes, `browserSocket`
goes null and ctrl messages are silently dropped. The bridge never recovers.

**Fix:** Add reconnection detection (new `connection` event re-establishes
`browserSocket`). Test with mock WS client: connect → send commands → disconnect
→ reconnect → assert commands resume.

---

## Priority 10 — Learning Loop Validation

### 10.1 No end-to-end dream cycle test

The most valuable sim-only test that does not exist: run a complete learning
loop in memory.

```
1. Simulate a 5-step navigation session producing traces (mock inference).
2. Run DreamEngine.consolidate() on those traces.
3. Assert new strategies appear in the StrategyStore with confidence > 0.
4. Run Planner.planGoal() with a matching goal.
5. Assert the planner selects the newly learned strategy.
6. Simulate a second session using that strategy.
7. Run dream again.
8. Assert strategy confidence increased.
```

This validates the full cortex → cerebellum → traces → dream → strategy →
cortex loop without any hardware or API keys.

### 10.2 Strategy confidence monotonicity under repeated success

No test verifies that 10 consecutive successful traces for the same goal
monotonically increase strategy confidence. The current scoring formula (50%
trigger match + 30% confidence + 20% success rate) should be verified
empirically with mock data.

### 10.3 Negative constraint propagation

The Dream Engine extracts failure constraints in Phase 1. No test verifies that
these constraints actually appear in the planner's prompt and change its output.

**Test outline:**
1. Create traces where "turn left at hallway" always fails.
2. Run dream — assert `_negative_constraints.md` contains the learned rule.
3. Run planner for a hallway goal — assert the plan avoids left turns.

---

## Summary

| Priority | Items | Theme |
|----------|-------|-------|
| **P1** | 3 | Critical missing tests and silent CI skips |
| **P2** | 4 | Simulation doesn't model real physics well enough |
| **P3** | 3 | Existing tests have weak assertions and bad mocks |
| **P4** | 4 | Entire components lack test suites |
| **P5** | 3 | No performance or stress testing |
| **P6** | 2 | Hardcoded values and config gaps |
| **P7** | 3 | Safety limits defined but never enforced in sim |
| **P8** | 3 | Sim-to-real gaps that will break on hardware |
| **P9** | 3 | No failure injection for graceful degradation testing |
| **P10** | 3 | Learning loop never validated end-to-end |

**Total: 31 items** across 10 priority tiers. All are simulation-only or
test-only — no firmware or hardware changes needed.
