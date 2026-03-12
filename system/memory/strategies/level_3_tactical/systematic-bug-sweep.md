---
id: strat_3_systematic-bug-sweep
version: 1
hierarchy_level: 3
title: Systematic Mechanism Bug Sweep After Major Integration
trigger_goals: ["bug sweep", "mechanism bugs", "post-integration fixes", "cognitive stack analysis", "fix bugs", "quality sweep"]
preconditions: ["Major integration or migration just completed", "Test suite passes (bugs are behavioral, not crash-level)", "Access to cognitive stack analysis or code review findings"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["tr_009_mechanism_bugs"]
deprecated: false
---

# Systematic Mechanism Bug Sweep After Major Integration

## Steps
1. After completing a major integration, conduct a systematic review of the affected components -- examine each module's core logic for subtle behavioral bugs
2. Categorize bugs by type: data round-trip failures (serialization/deserialization), timing issues (heartbeat intervals, timeouts), logic bugs (wrong outcome assignment), redundant computation (duplicate calls), detection algorithm flaws (exact-match vs entropy-based), code duplication across modules, missing deduplication
3. Fix bugs in priority order: data correctness first, then logic bugs, then performance, then code quality
4. For each fix, verify the fix is isolated -- do not bundle feature changes with bug fixes
5. Run the full test suite after each fix category to catch regressions early
6. Document all fixes in a single commit with per-bug descriptions for auditability

## Negative Constraints
- Do not combine bug fixes with feature additions -- pure fixes only
- Do not assume the test suite catches all behavioral bugs -- many mechanism bugs are about suboptimal behavior, not crashes
- Do not fix timing issues by adding arbitrary safety margins -- understand the root cause (e.g., heartbeat at 1500ms with 1000ms target leaves insufficient margin)

## Notes
- The Gemini migration bug sweep found 8 bugs across 7 files in a single session:
  1. strategy_store: spatialRules not surviving serialize/deserialize round-trip
  2. vision_loop: heartbeat 1500ms too close to 1000ms target (reduced to 1000ms)
  3. dream_engine: last-group outcome always UNKNOWN (now checks SUCCESS)
  4. roclaw_tools: duplicate VLM scene inference in advanceToNextStep
  5. vision_loop: exact-repeat stuck detection replaced with entropy-based approach
  6. dream_engine: SWS pruning not actually removing low-value sequences from REM input
  7. planner/semantic_map: parseJSONSafe duplicated across modules (consolidated to core)
  8. strategy_store: negative constraints not deduplicated before append
- The most impactful bugs were #3 (dream engine outcome) and #6 (SWS pruning) -- both corrupted the dream consolidation pipeline.
- Bugs like #7 (code duplication) are quality issues that compound over time -- catching them during a sweep prevents future divergence.
