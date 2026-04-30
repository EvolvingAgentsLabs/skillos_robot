---
id: seed_3_doorway-approach
version: 1
level: 3
title: Doorway Approach
trigger_goals: ["door", "doorway", "entrance", "through", "exit"]
preconditions: ["camera active", "doorway visible"]
confidence: 0.3
success_count: 0
failure_count: 0
source_traces: []
deprecated: false
---

# Doorway Approach

## Steps

1. Reduce speed to 50% when doorway frame edges are visible
2. Align robot center with doorway center using differential steering
3. Verify both sides of doorway have clearance (robot is 20cm wide)
4. Proceed through at reduced speed, maintaining center alignment
5. Once through, resume normal speed and reassess environment

## Negative Constraints

- Do not attempt to pass through openings narrower than 25cm
- Do not accelerate while inside the doorway frame
