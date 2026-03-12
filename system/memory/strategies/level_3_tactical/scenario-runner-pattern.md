---
id: strat_3_scenario-runner-pattern
version: 2
hierarchy_level: 3
title: Generic Scenario Runner for Navigation Testing
trigger_goals: ["scenario runner", "run scenario", "navigation test", "realistic scenarios", "simulation test"]
preconditions: ["TextSceneSimulator imported", "BytecodeCompiler instantiated", "DreamScenario with rooms, walls, objects, target defined", "InferenceFunction provided"]
confidence: 0.6
success_count: 2
failure_count: 0
source_traces: ["cognitive-stack-ab.test.ts:203-288", "dream-simulator.test.ts", "dream_20260311_a7b3", "dream_20260312_f4a9"]
deprecated: false
---

# Generic Scenario Runner for Navigation Testing

## Steps
1. Initialize TextSceneSimulator with a DreamScenario (defines world geometry, start pose, target, max frames, goal threshold)
2. Initialize BytecodeCompiler in 'fewshot' mode and get the tool-calling system prompt with the scenario goal
3. Loop for up to maxFrames iterations: render current frame, build user message with last 3 frames as context, call inference function, compile VLM output to bytecode, step the simulator
4. Track metrics per frame: opcode name (decoded from bytecode), target distance, collision flag
5. Detect stuck conditions: 6+ consecutive identical opcodes (excluding STOP) increment stuckCount
6. Terminate on: goal reached (distance < threshold), STOP opcode, compile failure, or maxFrames exhausted
7. Return structured ABResult: scenarioId, title, goalReached, framesUsed, collisions, stuckCount, finalDistance, frameLog

## Negative Constraints
- Do not run scenarios without a maxFrames limit -- infinite loops will hang the test suite
- Do not ignore compile failures -- they indicate malformed inference output and should terminate the run
- Do not count STOP opcode repetitions as stuck -- stopping is intentional behavior

## Notes
- The 5 built-in scenarios cover distinct navigation challenges: corridor-target (straight line), room-exploration (doorway traversal), obstacle-avoidance (multi-obstacle field), wall-following (L-shaped corridor), doorway-navigation (narrow passage)
- Frame context window of 3 previous frames helps the inference function maintain temporal coherence
- The ABResult.frameLog provides full debugging visibility into every decision made during a run
- Scenario runner is condition-agnostic -- same function handles both Baseline and Full Stack conditions
- **Version 2 improvements:** See strat_3_shared-scenario-runner for eliminating code duplication between A/B tests and dream simulator; see strat_3_spatial-progress-validation for improving stuck detection reliability
