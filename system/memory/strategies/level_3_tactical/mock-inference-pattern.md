---
id: strat_3_mock-inference-pattern
version: 2
hierarchy_level: 3
title: Deterministic Mock Inference for Testing
trigger_goals: ["mock inference", "test inference", "deterministic", "scenario runner", "A/B test"]
preconditions: ["InferenceFunction interface available from llmunix-core", "Scene text or system prompt contains analyzable keywords"]
confidence: 0.6
success_count: 2
failure_count: 0
source_traces: ["cognitive-stack-ab.test.ts:64-181", "dream-engine.test.ts:72-102", "dream_20260311_a7b3", "dream_20260312_f4a9"]
deprecated: false
---

# Deterministic Mock Inference for Testing

## Steps
1. Define the InferenceFunction signature: async (systemPrompt: string, userMessage: string) => Promise<string>
2. For Baseline inference: parse sceneText keywords (collision, target visible, path blocked, doorway) and emit TOOLCALL JSON with naive parameters (high speed, small rotations)
3. For Strategy-augmented inference: accept strategies[] and constraints[] arrays. Check constraints with hasConstraint(keyword) and strategies with hasStrategy(keyword) to modify behavior (slower speeds, larger rotations, careful approaches)
4. For Dream Engine inference: respond to systemPrompt keywords -- "failure"/"Analyze" returns JSON constraint, "abstract"/"strategy" returns JSON strategy, "merge" returns merged strategy, default returns summary string
5. Ensure all mock functions are pure (no side effects, no state mutation) for test determinism
6. Use the mock inference as the `infer` parameter when constructing DreamEngine, scenario runners, or cognitive stack components

## Negative Constraints
- Do not include API key dependencies in mock inference -- tests must run offline and without cost
- Do not use random values in mock inference -- all outputs must be deterministic for assertion reliability
- Do not hardcode specific scenario details in mock inference -- use keyword matching so the same mock works across multiple scenarios

## Notes
- **Version 1 → Version 2:** See strat_3_mock-inference-structured-parsing for improvements to robustness and structured parsing
- The cognitive-stack-ab.test.ts file defines three mock types: createBaselineInference(), createStrategyAugmentedInference(), and inline dream inference
- Mock inference responds to 7 scene categories: goal reached, collision, path blocked, target visible, target not visible, doorway visible, path clear
- Strategy augmentation changes behavior in 4 ways: slower speeds near obstacles, larger rotation angles, systematic scanning, careful doorway approach
- Dream engine mock responds to 4 prompt categories: failure analysis, strategy merge, strategy abstraction, dream summary
- **Future iteration:** Move makeNavigationDecision() logic into shared service module (strat_3_shared-scenario-runner) to eliminate duplication with scenario_runner.ts
