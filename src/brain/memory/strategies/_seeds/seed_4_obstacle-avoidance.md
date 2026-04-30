---
id: seed_4_obstacle-avoidance
version: 1
level: 4
title: Obstacle Avoidance
trigger_goals: ["avoid", "obstacle", "dodge", "explore"]
preconditions: ["camera active"]
confidence: 0.3
success_count: 0
failure_count: 0
source_traces: []
deprecated: false
---

# Obstacle Avoidance

## Steps

1. Continuously monitor camera feed for obstacles growing larger across frames
2. When obstacle occupies >40% of frame width, issue STOP command
3. Turn away from obstacle (prefer the side with more open space)
4. Verify new path is clear before resuming forward motion
5. Resume forward movement at reduced speed

## Negative Constraints

- Do not reverse blindly without rear clearance
- Do not maintain high speed when obstacles are within 30cm
