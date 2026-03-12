---
id: strat_3_backward-compat-wrapper-preservation
version: 1
hierarchy_level: 3
title: Backward-Compatible Wrapper Preservation During Simplification
trigger_goals: ["backward compatibility", "existing tests", "wrapper class", "mock preservation", "test infrastructure"]
preconditions: ["Existing test suite with mock-based testing patterns", "Wrapper classes or adapter classes used as mock targets", "Simplification or migration that removes production usage of these classes"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["dream_20260311_a7f3_geminicore_integration"]
deprecated: false
---

# Backward-Compatible Wrapper Preservation During Simplification

## Steps
1. Before removing any class, search the test suite for direct imports and instantiations of that class (e.g., `grep -r "CerebellumInference" __tests__/`)
2. Categorize each test usage: (a) mocking the class constructor, (b) calling instance methods, (c) type-only imports
3. If any test directly instantiates the class for mocking purposes, the class MUST be preserved in the codebase
4. If the class is no longer used in production: add a doc comment noting it is retained for test compatibility (e.g., "Kept for backward compatibility -- tests mock this class directly")
5. If the class implements a shared interface (e.g., InferenceFunction), ensure the interface contract is still met even if the implementation is no longer called in production
6. For re-exported types associated with the class (e.g., InferenceConfig, InferenceStats), preserve those exports as well -- tests may import them
7. Run the full test suite to confirm all mocking patterns still work
8. Optionally: add a code comment with the dream ID that justifies the preservation decision for future maintainers

## Negative Constraints
- Do not delete classes that have ANY test importing them without first migrating those tests to the new class
- Do not assume "unused in production" means "safe to delete" -- test infrastructure has different lifecycle rules
- Do not break the export surface of a module during simplification: if `inference.ts` exported CerebellumInference, it must continue to do so

## Notes
- In the GeminiCore integration, CerebellumInference was kept even though production routing moved entirely to GeminiRoboticsInference. The class appears in gemini-robotics.test.ts (indirectly via InferenceStats import), and multiple integration tests mock it.
- The BytecodeEntry interface in trace_types.ts follows the same pattern: it provides `bytecodeToAction()` and `actionToBytecode()` conversion helpers for backward compatibility even though the core uses ActionEntry.
- The re-export pattern in trace_types.ts (re-exporting HierarchyLevel, TraceOutcome, etc. from core) ensures existing RoClaw-layer consumers do not need import path changes.
