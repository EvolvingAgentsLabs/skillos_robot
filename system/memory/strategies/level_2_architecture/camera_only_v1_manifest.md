---
title: Camera-Only Visual Servoing (V1)
level: 2
trigger_goals:
  - navigate without IMU
  - egocentric navigation
  - first-person camera control
  - minimal hardware navigation
confidence: 0.85
created: 2026-05-01
---

# Camera-Only Visual Servoing (V1)

## Decision

Strip the motor control path to its minimal form: **Camera + Motors only**.
The VLM becomes both the spatial sensor and compass — perceiving the target's
position in the first-person camera frame and driving toward it via
proportional visual servoing.

## Context

The V2 architecture used an MPU-6050 IMU for:
- Dead-reckoned heading (gyro integration)
- Self-perception verification (action→accelerometer)
- Absolute coordinate projection (combined with SceneGraph)

This introduced:
- Calibration drift (gyro bias accumulates without magnetometer)
- Sensor fusion complexity (complementary/Kalman filter needed)
- Hardware cost (+MPU-6050 + I2C wiring)
- Failure modes (I2C bus hangs, sensor noise)

## Why Visual Servoing Is Superior

1. **Inherently robust** — "if target is left, turn left" works regardless of
   accumulated drift, magnetic interference, or calibration errors.

2. **Biological precedent** — insects navigate complex environments with
   optic flow alone. No inertial sensor needed for goal-directed behavior.

3. **Minimal hardware** — ESP32-S3-CAM + 2 steppers. Nothing else.
   ~$15 BOM for the complete mobile platform.

4. **Self-correcting** — every VLM cycle re-observes reality. No state
   accumulates between frames. Errors don't compound.

5. **Same dual-loop architecture** — SemanticLoop (1-2 Hz VLM) feeds
   EgocentricReactiveLoop (20 Hz motor) via cached perception. The pattern
   is identical to overhead mode; only the decision logic changes.

## Algorithm

```
1. No target visible         → SEARCH (rotate CW to scan)
2. Target large + at bottom  → ARRIVED (STOP)
3. Target left of center     → TURN_LEFT (ROTATE_CCW)
4. Target right of center    → TURN_RIGHT (ROTATE_CW)
5. Target centered           → MOVE_FORWARD (speed ∝ distance)
```

Collision prevention: EgocentricReflexGuard vetoes MOVE_FORWARD when any
obstacle has `size > 0.3 AND |cx - 0.5| < 0.2 AND cy > 0.6` (large,
centered, near the bottom of frame = physically close and blocking).

## Tradeoffs

| Overhead mode | Egocentric mode |
|---|---|
| Absolute coordinates (cm) | Relative frame coordinates only |
| IMU-aided heading | No heading — VLM is the compass |
| SceneGraph with distances | Bbox size as distance proxy |
| Works with external camera | Requires onboard first-person camera |
| Better for multi-waypoint paths | Best for single-target seek |
| 3 FreeRTOS tasks | 2 FreeRTOS tasks |

## What We Lose

- Dead-reckoned pose (posX, posY, headingDeg)
- Self-perception locomotion loop (drive→accel verification)
- Precise distance estimates between VLM cycles
- Multi-waypoint topological navigation (needs overhead planning)

## What We Gain

- Zero calibration, zero drift, zero sensor fusion
- Simpler firmware (2 tasks, no I2C, no Wire.h)
- Lower hardware cost (~$15 total BOM)
- Faster development iteration (fewer failure modes)
- Graceful degradation (if VLM is slow, robot just pauses)

## Files

- `src/control/egocentric_controller.ts` — core decision logic
- `src/control/egocentric_reflex_guard.ts` — bbox collision veto
- `firmware/roclaw_egocentric/` — camera-only firmware variant
- `scripts/run_sim3d.ts --egocentric` — entry point flag
- `src/brain/perception/vision_loop.ts` — enableDualLoop with controlMode

## Backward Compatibility

- Default mode remains `overhead` (existing behavior unchanged)
- `--egocentric` is opt-in
- All existing tests pass without modification
- Overhead firmware (`firmware/roclaw_unified/`) stays intact
