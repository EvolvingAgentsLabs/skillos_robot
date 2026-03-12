---
id: strat_4_obstacle-avoidance-reactive
version: 1
hierarchy_level: 4
title: Reactive Obstacle Avoidance with Constraint-Aware Speed Control
trigger_goals: ["obstacle", "avoid", "collision", "wall", "blocked", "stuck"]
preconditions: ["Camera feed or scene text available", "Bytecode compiler ready", "Obstacle distance estimable from scene"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["cognitive-stack-ab.test.ts:399-435", "cognitive-stack-ab.test.ts:716-779", "dream_20260311_a7b3"]
deprecated: false
---

# Reactive Obstacle Avoidance with Constraint-Aware Speed Control

## Steps
1. When obstacle or wall is detected in scene text, immediately reduce speed to 60-80 (not full 128-255)
2. If collision warning ("very close to a wall"), move backward at speed 60 before attempting rotation -- do not try to turn in-place when pressed against obstacle
3. If path ahead is blocked, rotate 90 degrees (not 30) to systematically survey alternative paths
4. After rotation, re-check scene before advancing -- do not blindly move forward after turning
5. If stuck detected (6+ consecutive identical opcodes), break the loop with a larger rotation (90-120 degrees) or switch to reverse-then-rotate sequence
6. When obstacle is cleared and path is open, resume forward motion at moderate speed (100-120, not maximum 255)

## Negative Constraints
- HIGH: Do not move forward at full speed (>100) when obstacles are within 50cm
- HIGH: Do not use small rotation angles (<45 degrees) to clear blocked paths -- they often fail to reveal alternative routes
- MEDIUM: Do not repeat the same opcode more than 5 times consecutively without reassessing the scene
- LOW: Do not resume full speed immediately after clearing an obstacle -- maintain moderate speed for one additional frame

## Notes
- A/B testing showed that baseline (no constraints) produces more collisions and stuck events than strategy-augmented inference
- The constraint "back away then rotate" (used in Full Stack) is strictly superior to "just rotate" (used in Baseline) when pressed against obstacles
- Stuck detection threshold is 6 consecutive identical non-STOP opcodes -- this is calibrated to allow some repetition for long straight paths while catching true stuck conditions
- This pattern was extracted from comparison of Baseline vs Full Stack results in the obstacle-avoidance and wall-following scenarios
