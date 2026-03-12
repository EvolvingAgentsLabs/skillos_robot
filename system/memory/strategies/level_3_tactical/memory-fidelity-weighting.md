---
id: strat_3_memory-fidelity-weighting
version: 1
hierarchy_level: 3
title: Memory Fidelity Weighting for Multi-Source Trace Consolidation
trigger_goals: ["fidelity", "memory weighting", "trace source", "dream weight", "real world weight", "confidence scaling"]
preconditions: ["TraceSource enum available (REAL_WORLD, SIM_3D, SIM_2D, DREAM_TEXT, UNKNOWN_SOURCE)", "TRACE_FIDELITY_WEIGHTS constant imported from llmunix-core/types"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["cognitive-stack-ab.test.ts:688-709", "dream-engine.test.ts:339-556", "dream_20260311_a7b3"]
deprecated: false
---

# Memory Fidelity Weighting for Multi-Source Trace Consolidation

## Steps
1. Tag every trace at creation time with its TraceSource (REAL_WORLD, SIM_3D, SIM_2D, DREAM_TEXT)
2. When grouping traces into sequences, assign fidelityWeight from TRACE_FIDELITY_WEIGHTS lookup
3. For mixed-source groups (parent-child with different sources), use the highest-fidelity source as the dominant source
4. Apply fidelityWeight as a multiplier in the scoring formula: score = (confidence * 0.4 + outcome_score * 0.4 + recency_score * 0.2) * fidelityWeight
5. When creating strategies from dream-sourced traces, set initial confidence = 0.5 * fidelityWeight (e.g., 0.5 * 0.3 = 0.15 for DREAM_TEXT)
6. Include source and fidelity in summarizeSequence output for audit trail (format: "Source: SOURCE_NAME (fidelity: WEIGHT)")
7. Real-world strategies can override dream-derived strategies when both match the same goal -- higher fidelity takes precedence

## Negative Constraints
- Do not give dream-sourced strategies the same initial confidence as real-world strategies -- the 3.33x ratio (1.0/0.3) is intentional
- Do not forget to tag legacy traces -- untagged traces default to UNKNOWN_SOURCE (fidelity 0.6), which may be inappropriately high for synthetic data
- Do not skip fidelity weighting in the scoring formula -- it is the mechanism that prevents hallucinated dream knowledge from dominating real experience

## Notes
- Fidelity hierarchy: REAL_WORLD (1.0) > SIM_3D (0.8) > UNKNOWN_SOURCE (0.6) > SIM_2D (0.5) > DREAM_TEXT (0.3)
- UNKNOWN_SOURCE at 0.6 is deliberately moderate -- it is higher than dream but lower than any known simulator
- The dream engine test suite validates: correct weight assignment, correct scoring ratios, correct initial confidence, correct source parsing, correct dominant source selection for mixed groups, and complete coverage of all TraceSource values
- Strategy confidence still caps at 0.95 regardless of source -- even real-world strategies need repeated reinforcement to reach high confidence
