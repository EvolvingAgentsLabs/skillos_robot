---
id: seed_2_target-seek
version: 1
level: 2
title: Visual Target Seek
trigger_goals: ["find", "locate", "red", "blue", "green", "cube", "box", "object", "target", "go to the"]
preconditions: ["camera active"]
confidence: 0.3
success_count: 0
failure_count: 0
source_traces: []
deprecated: false
---

# Visual Target Seek

## Steps

1. Rotate 360° to scan all directions for the target
2. If the target is visible, turn to face it directly
3. Move forward toward the target, adjusting heading to keep it centered
4. Slow down as the target grows larger in the frame
5. Stop when the target fills a significant portion of the view (arrival)

## Context

Use when the goal involves navigating to a specific, visually identifiable object (e.g., "the red cube", "the blue box"). The target must be recognizable by color, shape, or label.
