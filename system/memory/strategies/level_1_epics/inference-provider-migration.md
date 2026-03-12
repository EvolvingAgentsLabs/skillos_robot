---
id: strat_1_inference-provider-migration
version: 3
hierarchy_level: 1
title: Zero-Breakage Inference Provider Migration
trigger_goals: ["migration", "provider replacement", "inference simplification", "backend consolidation", "type-check", "gemini migration", "model selection", "gemini-2.0-flash"]
preconditions: ["InferenceFunction interface exists as abstraction layer", "Test suite has comprehensive coverage (400+ tests)", "All inference backends implement the same InferenceFunction signature", "New backend already validated with integration tests"]
confidence: 0.60
success_count: 3
failure_count: 0
source_traces: ["dream_20260311_a7f3_geminicore_integration", "tr_001_gemini_migration_epic", "tr_005_simplify_dream_inference", "tr_006_simplify_dream_router", "tr_007_update_index_boot", "tr_008_update_dream_sim", "tr_ab_analysis_20260312"]
deprecated: false
---

# Zero-Breakage Inference Provider Migration

## Steps
1. Verify the target state: confirm which inference backends will remain active and which will be removed from production routing (not from codebase)
2. Run the full test suite before any changes to establish a passing baseline -- record the exact count (e.g., 26 suites, 459 tests)
3. Add the new backend additively first (e.g., GeminiRoboticsInference alongside CerebellumInference) with feature flag or env var activation -- validate with integration tests before proceeding
4. Narrow type unions first: change type definitions (e.g., DreamInferenceMode from 'claude'|'gemini'|'dual' to 'gemini') and run tsc --noEmit to surface all downstream type errors
5. Fix downstream type errors iteratively, never suppressing with `any` -- each fix must be type-safe
6. Preserve backward-compatible wrapper classes that tests depend on (e.g., CerebellumInference) -- do NOT delete them even if production no longer routes through them
7. Update routing logic to use only the surviving backend (e.g., DreamInferenceRouter constructor uses only GeminiRoboticsInference)
8. Simplify configuration interfaces: remove fields for dead backends (apiBaseUrl, openRouterApiKey, claudeModel) and update error messages to reference the new required config (GOOGLE_API_KEY)
9. Update all entry points (index.ts, CLI scripts) to boot with the new backend directly -- add boot-time validation for required config (exit(1) if missing)
10. Simplify CLI scripts: remove mode flags (--mode claude/gemini/dual) and environment checks for removed providers
11. Verify no npm dependency changes are needed -- the migration should be code-only if the abstraction layer was well-designed
12. Run the full test suite again and confirm identical pass count (26 suites, 459 tests, same skipped count)
13. Run tsc --noEmit one final time to confirm clean type-check

## Negative Constraints
- Do not delete classes that tests mock directly -- they serve as test infrastructure even if unused in production
- Do not widen type unions "just in case" -- narrow to exactly what is used
- Do not add new npm dependencies during a simplification migration
- Do not suppress type errors with `any` or `@ts-ignore` -- fix them properly or the migration is incomplete
- Do not enable structured tool calling with a text-completion-style prompt -- system prompt format MUST match inference mode
- Do not change the default model identifier during migration without verifying all callers can handle it (e.g., gemini-robotics-er-1.5-preview to gemini-2.0-flash)

## Notes
- This strategy was validated across two consolidation cycles: the initial GeminiCore integration (where Claude and dual inference modes were removed) and the full migration trace analysis.
- The key enabler was the InferenceFunction interface abstraction in llmunix-core/interfaces.ts -- all backends implement `(systemPrompt, userMessage, images?) => Promise<string>`, making them interchangeable.
- The project structure was fully preserved: no files deleted, no directories restructured.
- Migration spanned 5 files: dream_inference.ts (70 to 59 lines), dream_inference_router.ts (294 to 115 lines), index.ts, dream_sim.ts, and supporting type definitions.
- A prompt/mode mismatch bug (tr_004) was discovered during migration: Gemini tool calling + hex prompt = repeated TURN_LEFT. This was fixed by creating a dedicated tool-calling system prompt. Always verify prompt format matches inference mode.
