---
id: strat_3_spatial-progress-validation
version: 1
hierarchy_level: 3
title: Enhance Stuck Detection with Spatial Progress Validation
trigger_goals: ["stuck detection", "spatial progress", "false positive", "corridor navigation", "stuck state"]
preconditions: ["Current stuck detection uses 6 consecutive identical opcodes", "TextSceneSimulator provides position (x,y) in each frame", "frameLog tracks position and target distance history"]
confidence: 0.5
success_count: 0
failure_count: 0
source_traces: ["tr_ab_analysis_20260312"]
deprecated: false
---

# Enhance Stuck Detection with Spatial Progress Validation

## Problem
Current stuck detection fires when 6 consecutive identical opcodes are issued, without verifying spatial progress:

**Issue 1 — False positive in corridor traversal:**
- Corridor Target Seek scenario: robot issues MOVE_FORWARD every frame
- Robot physically progresses 1.5cm/frame (1.5cm * 6 frames = 9cm total movement)
- Stuck detector fires anyway: 6 identical opcodes → stuck count += 1 → abort after 3 detections (frame 19)
- Result: Goal never reached, false failure in A/B test

**Issue 2 — Oscillation not detected:**
- Obstacle Avoidance scenario: model alternates ROTATE_CW 90° / ROTATE_CCW 90°
- Opcodes never repeat 6 times consecutively (pattern: ROTATE_CW, ROTATE_CCW, ROTATE_CW, ...)
- Net heading change = 0° over 200 frames
- Stuck detector misses it: entropy-based approach counts opcode frequency, not directional accumulation
- Result: Robot wastes 200 frames in infinite loop

**Root causes:**
1. Opcode count ≠ spatial progress (a MOVE_FORWARD at 1.5cm/frame is valid, not stuck)
2. Oscillation detection requires directional state tracking, not just opcode counting

## Steps

1. **Enhance stuck detection function** in shared runner:
   ```typescript
   function detectStuckWithSpatialValidation(
     lastOpcode: number,
     currentOpcode: number,
     consecutiveCount: number,
     threshold: number,
     positionHistory: Array<{x: number, y: number}>,
     headingHistory: number[]
   ): { isStuck: boolean; reason: string } {
     // Check 1: Consecutive identical opcodes
     if (consecutiveCount < threshold) return { isStuck: false, reason: '' };

     // Check 2: Spatial progress validation
     // For MOVE opcodes: has position changed in last N frames?
     if ([Opcode.MOVE_FORWARD, Opcode.MOVE_BACKWARD].includes(currentOpcode)) {
       const recentPositions = positionHistory.slice(-threshold);
       const minDist = Math.min(...recentPositions.map((p, i, arr) =>
         i === 0 ? Infinity : Math.hypot(p.x - arr[i-1].x, p.y - arr[i-1].y)
       ));
       if (minDist > 0.5) return { isStuck: false, reason: 'Moving' };
     }

     // Check 3: Oscillation detection
     // For ROTATE opcodes: have we reversed direction multiple times?
     if ([Opcode.ROTATE_CW, Opcode.ROTATE_CCW, Opcode.TURN_LEFT, Opcode.TURN_RIGHT].includes(currentOpcode)) {
       const recent = headingHistory.slice(-threshold);
       const netHeadingChange = (recent[recent.length - 1] - recent[0] + 360) % 360;
       if (Math.abs(netHeadingChange) > 45) return { isStuck: false, reason: 'Turning' };
       // If net heading ~0 and threshold rotations issued → oscillation!
       if (Math.abs(netHeadingChange) < 10) return { isStuck: true, reason: 'Oscillation detected' };
     }

     return { isStuck: true, reason: 'No spatial progress with consecutive commands' };
   }
   ```

2. **Modify runScenarioBase()** to track position and heading in frameLog:
   - Add `positionHistory: Array<{x, y}>` to FrameLogEntry
   - Add `headingHistory: number[]` window (last 10 entries)
   - Pass these to `detectStuckWithSpatialValidation()` instead of just opcode count

3. **Update stuck detection threshold logic**:
   - Increase threshold from 6 to 10 consecutive identical opcodes (gives more spatial progress window)
   - Add separate oscillation detection that fires after 8+ rotations with net heading < 10°

4. **A/B test impact measurement**:
   - Run A/B tests before/after this change
   - Measure: false positive stuck detections in corridor scenario (should drop to ~0)
   - Measure: oscillation detection rate in obstacle-avoidance scenario (should improve)
   - Assert: overall success rate >= baseline

5. **Add regression test** in shared-scenario-runner.test.ts:
   - Test case: "MOVE_FORWARD for 10 consecutive frames with 1.5cm progress per frame should NOT trigger stuck"
   - Test case: "ROTATE_CW / ROTATE_CCW alternating 20 times with net 0° heading SHOULD trigger stuck"

## Negative Constraints
- Do not remove the opcode-count check entirely -- it still catches cases with corrupted position data
- Do not use finer-grained position tracking (e.g., every frame) because simulator may have position quantization
- Do not lower the oscillation detection threshold below 8 rotations (too aggressive, may catch legitimate scanning)

## Notes
- This strategy is enabled by the shared-scenario-runner refactoring (strat_3_shared-scenario-runner)
- Solving Issue #1 (false corridor positives) unblocks the A/B test from being invalidated by the stuck detector
- Solving Issue #2 (oscillation detection) requires tracking directional state, which the current entropy-based approach cannot capture
- Expected outcome: A/B tests become representative of true robot behavior; stuck detection becomes reliable for both linear and rotational stuck states
- Estimated lines: +80 lines in shared runner, +30 lines in tests
