---
id: strat_2_ab-testing-framework
version: 1
hierarchy_level: 2
title: A/B Testing Framework for Cognitive Stack Validation
trigger_goals: ["A/B test", "compare", "baseline", "full stack", "cognitive stack", "quality validation"]
preconditions: ["TextSceneSimulator available", "BytecodeCompiler available", "Mock inference functions defined", "At least 2 test scenarios configured"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["cognitive-stack-ab.test.ts", "dream_20260311_a7b3"]
deprecated: false
---

# A/B Testing Framework for Cognitive Stack Validation

## Steps
1. Define two inference conditions: Condition A (Baseline -- raw inference with no strategies or constraints) and Condition B (Full Stack -- inference augmented with strategies and negative constraints)
2. Create deterministic mock inference functions that respond to scene text keywords, ensuring reproducible results without API calls
3. Configure realistic scenarios (corridor-target, room-exploration, obstacle-avoidance, wall-following, doorway-navigation) with distinct navigation challenges
4. Run each scenario through the generic `runScenario()` runner that accepts any InferenceFunction and produces structured ABResult metrics
5. Collect per-scenario metrics: goalReached (boolean), framesUsed (efficiency), collisions (safety), stuckCount (recovery), finalDistance (progress)
6. Assert that Full Stack performs at least as well as Baseline across all safety metrics (collisions <= baseline, stuckCount <= baseline)
7. Generate a comparative report with per-scenario breakdown and aggregate totals
8. Feed execution traces through the Dream Engine to validate that the Run -> Dream -> Improve cycle produces measurable improvement

## Negative Constraints
- Do not use real API calls in A/B tests -- mock inference ensures determinism and zero cost
- Do not compare only success/failure -- measure efficiency (frames), safety (collisions), and recovery (stuck count) as separate dimensions
- Do not run Full Stack tests without first establishing Baseline results for the same scenario

## Notes
- The framework validates 22 test assertions across 5 scenarios in the cognitive-stack-ab.test.ts suite
- All 459 tests pass across 26 suites, confirming the framework's reliability
- Mock inference uses keyword matching on scene text (e.g., "collision", "target visible", "path blocked") to produce deterministic TOOLCALL responses
- Strategy-augmented inference checks both strategies and constraints to make safer, more informed decisions
