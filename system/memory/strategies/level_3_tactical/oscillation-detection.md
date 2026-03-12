---
id: strat_3_oscillation-detection
version: 1
hierarchy_level: 3
title: Oscillation Detection for Alternating Rotation Sequences
trigger_goals: ["oscillation", "stuck detection", "alternating", "CW/CCW", "heading accumulation"]
preconditions: ["Rotation opcode history available (ROTATE_CW, ROTATE_CCW)", "Heading tracking enabled in motor state", "Window size for oscillation detection (e.g., 12-frame sliding window)"]
confidence: 0.6
success_count: 0
failure_count: 0
source_traces: ["tr_ab_analysis_20260312"]
deprecated: false
---

# Oscillation Detection for Alternating Rotation Sequences

## Context

Previous stuck detection logic (opcode-identity and entropy-based) failed to catch oscillation patterns where a robot alternated between opposite rotations. A/B test failure case:
- Model issued ROTATE_CW 90° followed by ROTATE_CCW 90° alternately for 200 frames
- Net heading change = 0° (rotations cancel out)
- No forward progress, robot never moved
- Stuck detector was silent because no opcode repeated identically (pattern was CW, CCW, CW, CCW, ...)
- Oscillation persisted until timeout (full 200-frame failure)

The entropy-based detector from tr_009 only measures opcode frequency distribution, not directional consistency.

## Steps

1. Maintain a sliding window of recent rotation opcodes (last 12-16 frames) and their heading deltas

2. Compute cumulative heading change over the window:
   - ROTATE_CW delta = +90° (or +45°, depending on opcode encoding)
   - ROTATE_CCW delta = -90°
   - heading_accumulation = sum of all deltas in window

3. Detect oscillation pattern:
   - If |heading_accumulation| <= 45° AND window contains both ROTATE_CW and ROTATE_CCW:
     - Pattern indicates alternating rotations canceling each other
     - Increment oscillation counter

4. When oscillation counter reaches threshold (e.g., 2 consecutive windows showing oscillation):
   - **Fire stuck detection** with "oscillation pattern detected" reason
   - Trigger recovery: issue MOVE_FORWARD or reverse-then-rotate to break oscillation

5. Reset oscillation counter when heading_accumulation exceeds threshold (e.g., > 90°), indicating directional consistency

## Negative Constraints

- HIGH: Do not ignore oscillation patterns just because opcodes alternate — track cumulative heading change, not opcode frequency
- HIGH: Do not set oscillation detection window too small (<8 frames) or true navigation reversals get misidentified as oscillation
- MEDIUM: Do not use heading_accumulation threshold = 0 (exact cancellation); use a tolerance band (±45°) to catch near-cancellations
- MEDIUM: Do not fire oscillation detection on first window; require 2+ consecutive oscillating windows to avoid noise

## Notes

- This strategy complements progress-aware stuck detection — together they cover both linear repetition (same opcode) and alternating reversal patterns
- The 12-16 frame window is empirically chosen from the 200-frame failure case; if oscillations are shorter (e.g., 4-frame CW/CCW cycles), reduce window size
- Heading tracking must be integrated into motor state (RobotState). If not available, estimate from opcode history with known rotation magnitudes
- Oscillation detection should be cheaper than position tracking (heading is already updated in motor loop) but more sophisticated than opcode count
