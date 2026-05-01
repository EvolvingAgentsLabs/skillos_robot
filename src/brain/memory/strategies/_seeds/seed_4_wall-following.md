---
id: seed_4_wall-following
version: 1
level: 4
title: Wall Following
trigger_goals: ["follow wall", "corridor", "hallway", "navigate along"]
preconditions: ["camera active", "wall visible on one side"]
confidence: 0.3
success_count: 0
failure_count: 0
source_traces: []
deprecated: false
---

# Wall Following

## Steps

1. Detect wall position (left or right side of camera frame)
2. Maintain parallel distance using differential speed (faster on wall side)
3. If wall curves, adjust turn rate to maintain consistent gap
4. At wall corners, slow down and turn to follow the new wall segment
5. If wall disappears (doorway/opening), continue straight briefly then reassess

## Negative Constraints

- Do not hug the wall too closely (maintain at least 15cm gap)
- Do not oscillate rapidly between left and right corrections
