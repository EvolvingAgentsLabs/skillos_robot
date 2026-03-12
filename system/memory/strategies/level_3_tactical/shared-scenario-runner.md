---
id: strat_3_shared-scenario-runner
version: 1
hierarchy_level: 3
title: Extract Shared Scenario Runner to Eliminate A/B Test Code Duplication
trigger_goals: ["code duplication", "A/B test", "scenario runner", "runScenario", "test refactoring"]
preconditions: ["A/B test and production scenario runner implementations exist", "Both use identical runScenario() signature", "Both have similar stuck detection and frame logging logic"]
confidence: 0.5
success_count: 0
failure_count: 0
source_traces: ["dream_20260312_f4a9"]
deprecated: false
---

# Extract Shared Scenario Runner to Eliminate A/B Test Code Duplication

## Problem
The A/B test suite (cognitive-stack-ab.test.ts lines 275-393) and the production dream simulator (dream_simulator/scenario_runner.ts lines 113-244) contain ~95% identical `runScenario()` implementations:

- Both parse TextSceneSimulator frames
- Both compile VLM output to bytecode using BytecodeCompiler
- Both maintain identical frameLog structure
- Both implement stuck detection: 6+ consecutive identical opcodes
- Both call the same `infer(systemPrompt, userMessage)` function

This 160-line duplication creates three risks:
1. **Regression masking**: Bug fixes in one location don't propagate to the other
2. **Behavioral divergence**: A/B test results become unrepresentative of real scenario execution
3. **Test maintenance burden**: Changes to stuck detection, frame parsing, or compilation require updates in two places

## Steps

1. **Create shared service module** `src/3_llmunix_memory/dream_simulator/common_runner.ts`:
   - Extract generic `runScenarioBase()` function with signature: `async (scenario, infer, config) => ScenarioResult`
   - Extract `buildUserMessage()` helper (currently duplicated in scenario_runner.ts lines 338-391 and cognitive-stack-ab.test.ts lines 290-335)
   - Extract `FrameLogEntry` interface (already defined in scenario_runner.ts, missing from test)
   - Extract stuck detection logic into a pure function: `detectStuck(lastOpcode, currentOpcode, threshold) => boolean`

2. **Update cognitive-stack-ab.test.ts**:
   - Remove `runScenario()` function (lines 275-393)
   - Import `runScenarioBase` from common_runner
   - Update `runScenario()` wrapper to call shared implementation with test-specific callbacks
   - Preserve test's `makeNavigationDecision()` inference function

3. **Update scenario_runner.ts**:
   - Replace internal `runScenario()` method with call to `runScenarioBase()`
   - Maintain `DreamScenarioRunner` class structure for backward compatibility
   - Pass dream router config as inference function

4. **Add regression tests**:
   - Create `__tests__/llmunix-core/shared-scenario-runner.test.ts`
   - Test that both A/B test and dream simulator produce identical results on the same scenario
   - Assert frame logs match, stuck detection counts match, goal-reached flags match

5. **Validate**: Run all 459 tests to confirm no behavioral changes

## Negative Constraints
- Do not remove the BytecodeCompiler initialization from the shared function -- compilation mode affects output
- Do not change the stuck detection threshold (6 consecutive opcodes) without running A/B tests to measure impact
- Do not merge `makeNavigationDecision()` into the shared runner -- A/B tests need the mock inference to be pluggable

## Notes
- The shared runner module becomes the canonical implementation for scenario simulation
- Both A/B tests and production will call the same code path, eliminating regression divergence
- This refactoring unblocks future improvements to stuck detection without code duplication (see strat_3_spatial-progress-validation)
- Estimated impact: 160 lines of duplicate code eliminated, 1 regression vector removed
