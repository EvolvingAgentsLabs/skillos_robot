---
id: strat_3_progress-aware-stuck-detection
version: 1
hierarchy_level: 3
title: Progress-Aware Stuck Detection with Spatial Validation
trigger_goals: ["stuck detector", "false positive", "spatial progress", "corridor navigation", "opcode repetition"]
preconditions: ["Robot position tracking available (from SemanticMap or odometry)", "Opcode history maintained in VisionLoop", "Minimum 2 position samples for delta calculation"]
confidence: 0.6
success_count: 0
failure_count: 0
source_traces: ["tr_ab_analysis_20260312"]
deprecated: false
---

# Progress-Aware Stuck Detection with Spatial Validation

## Context

Previous stuck detection in vision_loop.ts used opcode-identity-only logic: count consecutive identical non-STOP opcodes, fire stuck detection at threshold (6). This approach produced false positives in corridor navigation where the robot issued repeated MOVE_FORWARD commands while making steady spatial progress (~1.5cm/frame).

Analysis from A/B test failures:
- Corridor scenario: 3 false stuck detections → abort at frame 19 instead of reaching goal
- Problem: detector counts opcode repetition regardless of whether the robot actually moved

## Steps

1. Before incrementing the opcode repetition counter, record the current robot position (x, y, heading from SemanticMap)

2. When opcode repetition reaches threshold (e.g., 6 identical consecutive opcodes), do NOT immediately fire stuck detection

3. Instead, query the previous recorded position (from N frames ago, where N = threshold - 1)

4. Calculate spatial delta: distance = sqrt((x_now - x_prev)^2 + (y_now - y_prev)^2)

5. If distance >= minimum_progress_threshold (e.g., 5cm / 50 pixels at typical scale):
   - **DO NOT fire stuck detection** — robot is making progress despite opcode repetition
   - Reset opcode counter and continue
   - Log progress observation for telemetry

6. If distance < minimum_progress_threshold:
   - Robot has not moved despite repeated identical opcodes
   - **Now fire stuck detection** with high confidence
   - Trigger recovery action (90-degree rotation or reverse-then-rotate sequence)

7. For long-running corridors where robot advances steadily, the progress check allows unlimited MOVE_FORWARD repetition without false detection

## Negative Constraints

- HIGH: Do not fire stuck detection immediately on opcode repetition without checking spatial position delta
- HIGH: Do not set minimum_progress_threshold too high (>10cm) or stuck detection becomes ineffective
- HIGH: Do not use opcode counts as the sole stuck detection metric — always validate with spatial position
- MEDIUM: Do not query position from unreliable sources (dead reckoning without localization) — use semantic map or visual odometry

## Notes

- This strategy specifically addresses the Corridor Scenario failure where MOVE_FORWARD repetition was interpreted as being stuck when the robot advanced 1.5cm per frame
- Minimum progress threshold should be calibrated to the robot's typical forward speed (e.g., MOVE_FORWARD at normal speed = 1-2cm/frame)
- The spatial validation is backward-compatible with the existing 6-opcode threshold — it just adds a gating condition
- Recommendation: log position deltas for telemetry and tuning threshold over time
