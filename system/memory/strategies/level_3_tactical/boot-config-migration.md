---
id: strat_3_boot-config-migration
version: 1
hierarchy_level: 3
title: Entry Point and CLI Migration for Provider Switch
trigger_goals: ["boot config", "entry point update", "CLI migration", "index.ts update", "script update", "provider switch"]
preconditions: ["New backend is validated and routing is complete", "Old provider env vars and CLI flags identified", "All dependent scripts and entry points cataloged"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["tr_007_update_index_boot", "tr_008_update_dream_sim"]
deprecated: false
---

# Entry Point and CLI Migration for Provider Switch

## Steps
1. Catalog all entry points that reference the old provider: main index.ts, CLI scripts (dream_sim.ts, run_sim3d.ts), and any standalone tools
2. For each entry point, update the import to use the new backend class directly (e.g., GeminiRoboticsInference instead of CerebellumInference)
3. Replace old provider config fields (OPENROUTER_API_KEY, QWEN_MODEL) with new ones (GOOGLE_API_KEY, GEMINI_MODEL)
4. Add boot-time validation: if the required API key is missing, log a clear error message and exit(1) immediately -- do not allow the system to start in a degraded state
5. Update logger/console messages to indicate the new provider (e.g., "Powered by Gemini Robotics -- 100% Google AI")
6. For CLI scripts: remove mode selection flags (--mode claude/gemini/dual), remove environment checks for removed providers, simplify help text
7. Update configuration defaults to match the new provider's requirements (e.g., motor control: maxOutputTokens=64, temperature=0.1, thinkingBudget=0, useToolCalling=true)
8. Verify each entry point boots successfully with the new provider config

## Negative Constraints
- Do not allow the system to boot without the required API key -- fail fast and loud rather than silently degrading
- Do not leave references to old provider names in user-facing messages (console output, help text, error messages)
- Do not change config defaults that are provider-agnostic (e.g., ESP32 host/port, camera settings)

## Notes
- index.ts migration was minimal: changed import, updated config fields, added boot validation, updated messages. Total: ~20 minutes.
- dream_sim.ts migration: removed --mode flag, removed DreamInferenceMode import, hardcoded inferenceMode to 'gemini', removed OPENROUTER_API_KEY check. Total: ~15 minutes.
- Both scripts now require only GOOGLE_API_KEY and optionally GEMINI_MODEL from environment.
- The boot-time exit(1) pattern is critical for robotics: a robot that starts without inference is worse than one that refuses to start.
