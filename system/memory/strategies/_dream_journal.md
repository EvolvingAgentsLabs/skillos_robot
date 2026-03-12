# Dream Journal

## 2026-03-11T19:00:00.000Z
**Dream ID:** dream_20260311_a7b3
**Mode:** goal-focused
**Filter:** A/B tests, cognitive stack, mock inference, scenario runner, realistic scenarios
- Traces processed: 8 (synthesized from test suite analysis -- 22 A/B test assertions, 5 scenarios, dream engine tests, strategy store tests, fidelity weighting tests, cognitive loop test)
- Sequences analyzed: 7 (2 architecture-level, 4 tactical-level, 1 reactive-level)
- Strategies created: 7
- Strategies updated: 0
- Strategies deprecated: 0
- Constraints learned: 5
- Traces pruned: 0 (goal-focused mode -- no pruning)

This dream session consolidated the A/B testing framework patterns established across 459 passing tests in 26 suites. Key learnings: (1) The Baseline vs Full Stack comparison methodology with mock inference is a reusable architecture-level strategy for validating cognitive stack contributions. (2) Five specific negative constraints were extracted from failure analysis -- most critically, the anti-pattern of moving at full speed near obstacles and using small rotation angles for stuck recovery. (3) Memory fidelity weighting (REAL_WORLD=1.0 down to DREAM_TEXT=0.3) is the foundational mechanism preventing dream-derived strategies from overriding real experience, and this understanding was codified as both a strategy and a constraint.

---

## 2026-03-11T19:30:00.000Z
**Dream ID:** dream_20260311_a7f3
**Mode:** goal-focused
**Filter:** type-check, test suite, backward compatibility, existing tests, project structure
- Traces processed: 6 (synthesized from GeminiCore integration project execution)
- Sequences analyzed: 4 (1 epic-level, 1 architecture-level, 2 tactical-level)
- Strategies created: 4
- Strategies updated: 0
- Strategies deprecated: 0
- Constraints learned: 4
- Traces pruned: 0 (goal-focused mode -- no pruning)

This dream session consolidated the GeminiCore integration project that simplified the inference stack from multi-provider (Claude/Gemini/dual) to Gemini-only. The integration achieved zero test breakage across 26 suites (459 tests, 2 skipped for API keys) with clean tsc --noEmit type-checking, no npm dependency changes, and full project structure preservation. Four reusable strategies were extracted: (1) L1 Zero-Breakage Inference Provider Migration -- the end-to-end migration playbook with type-first verification. (2) L2 InferenceFunction Adapter Pattern -- the architectural abstraction that enabled drop-in provider replacement. (3) L3 Type Narrowing for Dead Code Elimination -- using tsc as a verification tool by narrowing types and letting the compiler surface downstream impacts. (4) L3 Backward-Compatible Wrapper Preservation -- the discipline of keeping test-mocked classes even when production routing changes. Four negative constraints were learned covering wrapper class deletion risk, union type over-widening, unnecessary SDK dependencies, and re-export chain depth limits.

---

## 2026-03-11T20:00:00-03:00
**Dream ID:** dream_20260311_b9e2
**Mode:** goal-focused
**Filter:** gemini migration, inference simplification, dream_inference, dream_inference_router, index.ts
- Traces processed: 9
- Sequences analyzed: 2 (1 epic sequence with 8 child traces, 1 standalone failure trace)
- Strategies created: 4
- Strategies updated: 1
- Strategies deprecated: 0
- Constraints learned: 2
- Traces pruned: 0 (goal-focused mode -- no pruning)

This dream session processed the complete Gemini migration execution trace -- a 7-day effort that moved all RoClaw inference paths from multi-provider (Qwen/OpenRouter/Claude) to Gemini Robotics exclusively. The most valuable new learning was the prompt-mode alignment pattern (strat_3_prompt-mode-alignment): when switching a model from text-completion to tool-calling mode, the system prompt MUST be rewritten to match, or the model produces degenerate repeated outputs. This was discovered when Gemini repeated TURN_LEFT on every frame regardless of camera input because it received a hex bytecode prompt while configured for structured tool calling. The existing L1 migration strategy (strat_1_inference-provider-migration) was updated to v2 with 4 additional steps covering additive backend integration, config simplification, entry point updates, and CLI cleanup. Four new strategies were created: L2 Additive Backend Integration (add new provider alongside existing before routing changes), L3 Prompt-Mode Alignment (match system prompt format to inference mode), L3 Dead Code Removal (safe removal of dead provider paths achieving 61% line reduction), and L3 Systematic Bug Sweep (post-integration mechanism audit that found 8 bugs across 7 files). Two new negative constraints were extracted from the prompt mismatch failure: always match prompt format to inference mode, and check configuration before debugging model behavior.

---

## 2026-03-12T14:30:00.000Z
**Dream ID:** dream_20260312_f4c7
**Mode:** goal-focused
**Filter:** stuck detector, spatial progress, corridor navigation, false positive, consecutive opcodes, oscillation, scene format restructuring
- Traces processed: 1 (tr_ab_analysis_20260312 from real-world A/B test failure analysis)
- Sequences analyzed: 2 (Sequence 1: Stuck Detector Issues with 2 sub-patterns; Sequence 2: Scene Format Mismatch)
- Strategies created: 3
- Strategies updated: 0
- Strategies deprecated: 0
- Constraints learned: 6
- Traces pruned: 0 (goal-focused mode -- no pruning)

This dream session processed post-implementation analysis from real-world A/B testing that revealed three critical gaps in the current system: (1) Stuck detector false positives in corridor navigation, (2) Oscillation detection blind spot for alternating CW/CCW rotations, and (3) Flash-Lite model ignoring structured scene data. The first gap (strat_3_progress-aware-stuck-detection) identifies that opcode-identity-only detection fired after 6 identical MOVE_FORWARD commands despite the robot making steady 1.5cm/frame progress, causing 3 false detections and premature abort at frame 19. Solution: validate spatial position delta before firing stuck detection, allowing unlimited forward repetition when progress is confirmed. The second gap (strat_3_oscillation-detection) reveals that entropy-based detection from earlier bug sweeps misses alternating rotation patterns where ROTATE_CW and ROTATE_CCW cancel each other over extended periods (200 frames observed in obstacle avoidance scenario). Solution: track cumulative heading change in a sliding window rather than opcode frequency. The third gap (strat_3_structured-scene-format-flash-lite) shows that Flash-Lite model defaults to qualitative pattern matching when numerical guidance (CLEARANCE, PROGRESS, OPTIONS) is interleaved with descriptive narrative, causing the Wall Following scenario to issue 133 out-of-bounds MOVE_BACKWARD commands. Solution: structurally separate quantitative decision guidance from narrative scene perception, placing DECISIONS REQUIRED (with ranked OPTIONS) before and visually distinct from SCENE PERCEPTION narrative. Six high-to-medium severity negative constraints were learned, establishing that stuck detection must validate spatial progress, oscillation detection must track heading accumulation, and scene format must segregate numerical from narrative content for Flash-Lite processing.

---

## 2026-03-12T09:32:59.000Z
**Dream ID:** dream_20260312_7f4c
**Mode:** goal-focused
**Filter:** model selection, flash-lite, gemini-2.0-flash, negative constraints, dream consolidation, trace tagging
- Traces processed: 2 (tr_ab_analysis_20260312 from real-world A/B test analysis, tr_001_gemini_migration_epic for context)
- Sequences analyzed: 2 (1 failure sequence: real A/B test exposing model selection limits; 1 success sequence: migration epic matched by new goal keywords)
- Strategies created: 1 (L2 Architecture: Model Selection by Reasoning Type)
- Strategies updated: 1 (L1 Epic: Inference-Provider-Migration v2->v3 with model selection keywords)
- Strategies deprecated: 0
- Constraints learned: 1 (Constraint 21: Flash-Lite limitations for numerical reasoning)
- Traces pruned: 0 (goal-focused mode -- no pruning)

This goal-focused dream consolidation targeted integration analysis findings around model selection strategy, trace tagging rigor, and PARTIAL vs FAILURE misclassification. Critical integration insight: tr_ab_analysis_20260312, though marked "Outcome: SUCCESS", documents 3 real execution failures (Corridor 0/5, Obstacle 0/5, Doorway 0/5, Wall Following with 133 out-of-bounds commands). This trace tagging precision issue (SUCCESS analysis outcome vs FAILURE execution outcomes) signals the importance of distinguishing between "analysis succeeded" and "task succeeded". Real-world evidence shows gemini-2.0-flash (flash-lite) fundamentally defaults to qualitative pattern-matching over numerical reasoning. When CLEARANCE/PROGRESS/OPTIONS sections are embedded in descriptive SCENE PERCEPTION text, the model treats structured fields as noise and optimizes for learned qualitative patterns, resulting in 133 MOVE_BACKWARD commands that violate spatial constraints. A new L2 Architecture strategy (strat_2_model-selection-by-reasoning-type) was created to codify the decision tree: use flash-lite for pure pattern-matching tasks, reserve flash+ tiers (flash-exp, future flash-next) for tasks requiring numerical field prioritization. The L1 migration strategy was updated to v3 (confidence 0.55→0.60, success_count 2→3) with new trigger goals including "model selection" and "gemini-2.0-flash", adding tr_ab_analysis_20260312 to source_traces. One high-severity constraint (Constraint 21) was extracted formalizing the flash-lite limitation boundary. Concurrent dream sessions (f4c7, f4a9) had already analyzed overlapping failure patterns, resulting in constraints 12-20 covering stuck detection and scenario runner improvements. This session complements the incident analysis by establishing model selection as a discrete strategy at the architecture level.

---

## 2026-03-12T15:15:00Z
**Dream ID:** dream_20260312_f4a9
**Mode:** goal-focused
**Filter:** test regression, mock inference, A/B test, makeNavigationDecision, runScenario duplication, scene format parsing, code duplication, regex-coupled inference, getTextSceneSystemPrompt coverage
- Traces processed: 9 (tr_ab_analysis_20260312 + 8 prior A/B/dream traces from 2026-03-11)
- Sequences analyzed: 3 (1 failure analysis: test quality regression findings; 2 success sequences: prior A/B frameworks and dream learnings)
- Strategies created: 4
- Strategies updated: 3 (v1→v2 iterations of existing strategies)
- Strategies deprecated: 0
- Constraints learned: 6
- Traces pruned: 0 (goal-focused mode -- no pruning)

This goal-focused dream session analyzed code quality and test regression findings from the A/B test quality analysis, complementing concurrent sessions (f4c7, 7f4c) that focused on stuck detection mechanisms and model selection. The unique focus of f4a9: software engineering regression vectors where code duplication, fragile test infrastructure, and missing test coverage enable silent behavioral divergence between A/B tests and production dream simulator.

**Key finding: 160-line code duplication.** The `runScenario()` function appears in two places with identical implementation: cognitive-stack-ab.test.ts (lines 275-393, 119 LOC) and dream_simulator/scenario_runner.ts (lines 113-244, 132 LOC). Both parse TextSceneSimulator frames, compile VLM output, log frames identically, and detect stuck via 6+ consecutive opcodes. This duplication creates three regression vectors: (1) bug fixes in one path don't propagate (2) behavioral divergence—A/B test may not represent real execution (3) test maintenance requires synchronized updates across two files. Solution: **strat_3_shared-scenario-runner** extracts a shared `runScenarioBase()` service module that both A/B test and dream simulator call, eliminating the duplication and aligning regression analysis.

**Key finding: Fragile regex-coupled mock inference.** The `makeNavigationDecision()` function (lines 87-252) uses brittle regex patterns for scene parsing: `/PROGRESS:\s*(approaching|..)/`, `/target=(\d+)cm at (-?\d+)deg/`, `/forward:\s*(\d+)cm\s*(clear|BLOCKED)/`. If TextSceneSimulator evolves format or keywords, all patterns fail silently and fall back to legacy parsing (line 112), creating behavioral divergence. Solution: **strat_3_mock-inference-structured-parsing** (v2) introduces TextSceneParser class with validation—returns `isComplete=false` if any critical field unparsed, forcing test failure rather than silent fallback.

**Key finding: Missing test coverage for getTextSceneSystemPrompt().** BytecodeCompiler tests (line 477) cover `getSystemPrompt()` but have zero tests for `getTextSceneSystemPrompt()`. Changes to the prompt structure (e.g., removing SPATIAL ANALYSIS section) pass the test suite but break A/B tests silently. Solution: **strat_3_test-coverage-system-prompts** adds 12+ test assertions validating prompt structure, two-pass format teaching, field names, examples, and placeholder replacement.

Three existing strategies updated to v2: strat_3_mock-inference-pattern (confidence 0.5→0.6, success_count 1→2), strat_3_scenario-runner-pattern (confidence 0.5→0.6, success_count 1→2), and strat_3_prompt-mode-alignment (cross-referenced by new shared-runner strategy). Six new constraints (18-23 mapped to implementation PR as 18-20, 21 pre-existing from 7f4c, 22-23 from f4c7) capture the regression vectors: do not duplicate scenario runner code, do not use regex-coupled parsing, add getTextSceneSystemPrompt tests, separate narrative from numerical scene data, and avoid flash-lite for numerical reasoning. This session's analysis addresses the meta-level quality regression—the test infrastructure itself had diverged from production behavior, requiring code consolidation and test rigor improvements to restore confidence in A/B testing validity.
