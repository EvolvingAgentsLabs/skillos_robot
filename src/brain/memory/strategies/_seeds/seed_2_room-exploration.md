---
id: seed_2_room-exploration
version: 1
level: 2
title: Systematic Room Exploration
trigger_goals: ["explore", "search", "scan", "room", "look around"]
preconditions: ["camera active"]
confidence: 0.3
success_count: 0
failure_count: 0
source_traces: []
deprecated: false
---

# Systematic Room Exploration

## Steps

1. On entering a new room, rotate 360 degrees to survey the environment
2. Identify all exits (doors, openings, corridors)
3. Navigate to the nearest unexplored wall segment
4. Follow the wall clockwise to systematically cover the perimeter
5. After perimeter sweep, cross to any unexplored central areas
6. Record observations at notable locations (furniture, objects, landmarks)

## Negative Constraints

- Do not revisit already-mapped areas unless seeking a specific target
- Do not spend more than 2 minutes in a single room without finding new features
