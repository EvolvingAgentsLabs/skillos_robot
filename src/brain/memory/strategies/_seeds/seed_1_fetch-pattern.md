---
id: seed_1_fetch-pattern
version: 1
level: 1
title: Fetch Object Pattern
trigger_goals: ["fetch", "get", "bring", "retrieve", "find and return"]
preconditions: ["camera active", "target object known"]
confidence: 0.3
success_count: 0
failure_count: 0
source_traces: []
deprecated: false
---

# Fetch Object Pattern

## Steps

1. Plan route from current location to the target area using known map
2. Navigate to the target area (use Level 2 route strategies)
3. On arrival, scan the area for the target object
4. If object found, confirm identification and approach it
5. Report finding to the user (RoClaw V1 has no gripper)
6. Plan return route to the starting location
7. Navigate back to the start

## Negative Constraints

- Do not declare object found without visual confirmation
- Do not navigate to unknown areas without first checking for routes on the map
