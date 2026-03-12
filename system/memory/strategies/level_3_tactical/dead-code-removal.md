---
id: strat_3_dead-code-removal
version: 1
hierarchy_level: 3
title: Safe Dead Code Path Removal After Provider Migration
trigger_goals: ["simplify", "remove dead code", "dead code removal", "reduce complexity", "provider cleanup", "code reduction"]
preconditions: ["Provider migration is complete (new backend is the sole active path)", "All callers have been updated to use the new backend", "Test suite passes with the new backend"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["tr_005_simplify_dream_inference", "tr_006_simplify_dream_router"]
deprecated: false
---

# Safe Dead Code Path Removal After Provider Migration

## Steps
1. Identify all files with multi-provider branching logic (if/else on provider type, env var checks for old providers, config fields for removed backends)
2. For each file, catalog what will be removed: imports, config interface fields, env var checks, code paths, type union members
3. Narrow type unions FIRST (e.g., DreamInferenceMode from 'claude'|'gemini'|'dual' to just 'gemini') -- this causes tsc to flag all downstream references
4. Remove dead imports (e.g., CerebellumInference when only GeminiRoboticsInference is used)
5. Remove dead config fields (e.g., apiBaseUrl, openRouterApiKey, claudeModel)
6. Remove dead code paths (e.g., OpenRouter/Qwen fallback, Claude simulator prompt, dual-mode execution)
7. Remove dead interfaces and types (e.g., DualInferenceResult)
8. Update error messages to reference the surviving provider's requirements (e.g., "requires GOOGLE_API_KEY")
9. Verify line count reduction matches expectations (e.g., dream_inference_router.ts: 294 to 115 lines = 61% reduction)
10. Run full test suite to confirm zero breakage

## Negative Constraints
- Do not delete backward-compatible wrapper classes that tests import -- keep them even if production does not use them
- Do not remove env var handling for the surviving provider's config
- Do not combine this step with any feature additions -- pure removal only
- Do not remove code in a single large commit -- work file by file so each change is reviewable

## Notes
- The Gemini migration achieved: dream_inference.ts reduced from ~70 lines of branching to 59 clean lines; dream_inference_router.ts reduced from 294 to 115 lines (61% reduction).
- The 61% reduction in dream_inference_router.ts came primarily from removing: Claude simulator system prompt (50+ lines), CerebellumInference import and initialization, dual-mode Promise.allSettled parallel execution, agreement/disagreement tracking statistics.
- Surviving code was cleaner: single constructor path, direct inference call, no routing logic.
- CerebellumInference class was preserved in inference.ts because tests mock it directly -- even though production no longer routes through it.
