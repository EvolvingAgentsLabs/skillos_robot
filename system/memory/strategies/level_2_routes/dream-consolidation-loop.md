---
id: strat_2_dream-consolidation-loop
version: 1
hierarchy_level: 2
title: Full Cognitive Loop -- Run then Dream then Improve
trigger_goals: ["dream", "consolidate", "learning loop", "improve", "cognitive loop", "run dream improve"]
preconditions: ["DreamEngine instantiated with adapter and mock inference", "StrategyStore with writable directory", "Trace files from prior execution cycles available"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["cognitive-stack-ab.test.ts:716-779", "dream-engine.test.ts:234-287", "dream_20260311_a7b3"]
deprecated: false
---

# Full Cognitive Loop -- Run then Dream then Improve

## Steps
1. CYCLE 1 (Run): Execute scenarios with baseline inference (no strategies), collecting execution traces with outcomes, confidence, and action sequences
2. GENERATE TRACES: Write structured trace files from execution results using HierarchicalTraceLogger or generateTraces(), tagging each with source (DREAM_TEXT, SIM_2D, SIM_3D, or REAL_WORLD)
3. DREAM: Instantiate DreamEngine with a DreamDomainAdapter and mock inference function. Run engine.dream() to process traces through SWS (failure analysis) and REM (strategy abstraction) phases
4. EXTRACT: Dream engine produces (a) negative constraints from failure sequences, (b) new strategies from success sequences, (c) a journal entry summarizing the consolidation
5. CYCLE 2 (Improve): Create strategy-augmented inference by injecting learned strategies and constraints. Re-run the same scenarios
6. VALIDATE: Assert that Cycle 2 metrics improve over Cycle 1 -- fewer collisions, fewer stuck events, equal or better goal completion

## Negative Constraints
- Do not skip trace generation between cycles -- the dream engine requires structured traces as input
- Do not use the same inference function for both cycles -- Cycle 2 must incorporate learned knowledge
- Do not assume dream-derived strategies have the same confidence as real-world strategies -- apply fidelity weighting

## Notes
- The test in cognitive-stack-ab.test.ts (Test 8) demonstrates this full loop with obstacle-avoidance as the target scenario
- Dream inference is mocked to return deterministic JSON for failure analysis, strategy abstraction, and summary phases
- The pattern generalizes: any scenario can be improved through this loop as long as traces are properly generated
- Memory fidelity weighting ensures REAL_WORLD experiences (1.0) outweigh DREAM_TEXT (0.3) by 3.33x
