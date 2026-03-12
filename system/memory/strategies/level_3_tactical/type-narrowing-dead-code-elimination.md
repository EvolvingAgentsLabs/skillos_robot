---
id: strat_3_type-narrowing-dead-code-elimination
version: 1
hierarchy_level: 3
title: TypeScript Type Narrowing for Safe Dead Code Elimination
trigger_goals: ["type narrowing", "dead code", "type-check", "union type", "simplification", "DreamInferenceMode"]
preconditions: ["TypeScript strict mode enabled", "Union type with members that are no longer used in any production path", "Test suite available to verify no consumer breaks"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["dream_20260311_a7f3_geminicore_integration"]
deprecated: false
---

# TypeScript Type Narrowing for Safe Dead Code Elimination

## Steps
1. Identify the union type to narrow (e.g., `type DreamInferenceMode = 'claude' | 'gemini' | 'dual'`)
2. Search the codebase for all references to the removed union members using grep/search (e.g., search for `'claude'` and `'dual'` in all .ts files)
3. For each reference found: determine if it is production code, test code, or dead code
4. Remove production code branches for the eliminated members (e.g., if/else branches handling 'claude' or 'dual' mode)
5. Update test code: if tests cover removed modes, delete those test cases; if tests use the type generically, update expected values
6. Narrow the type definition to only the surviving member(s): `type DreamInferenceMode = 'gemini'`
7. Run tsc --noEmit -- the compiler will flag any remaining references to removed members as type errors
8. Fix any remaining type errors (these are the spots you missed in step 2-5)
9. Run the full test suite to confirm no behavioral regressions

## Negative Constraints
- Do not use `as any` to silence type errors from narrowing -- each error reveals a consumer that needs updating
- Do not narrow a type if any active production code path still uses the removed members
- Do not remove the type alias entirely if it is exported and consumed externally -- keep the alias with the narrowed definition for API compatibility
- Do not forget to check re-export chains: if the type is re-exported from multiple modules, all re-exports must be consistent

## Notes
- In the GeminiCore integration, DreamInferenceMode was narrowed from 3 members to 1, and tsc surfaced all downstream impacts instantly. The type system served as a verification tool.
- The `DreamInferenceRouter.getMode()` method was simplified to always return `'gemini'` (dream_inference_router.ts line 77), eliminating a switch statement.
- The pattern "narrow the type, let the compiler find the dead code" is more reliable than manual code search because it catches transitive dependencies.
