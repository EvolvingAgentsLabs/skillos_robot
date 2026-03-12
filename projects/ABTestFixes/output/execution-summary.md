# Execution Summary — A/B Test Failure Analysis

**Goal:** Analyze solutions to 3 critical issues detected in real Gemini A/B test (0/5 goals both conditions)
**Status:** SUCCESS
**Traces:** 1 GOAL-level trace logged
**Agents Deployed:** 3 (Implementation, Quality, Integration) + 3 Dream cycles

## Deliverables

| File | Description |
|------|-------------|
| `projects/ABTestFixes/output/implementation-analysis.md` | Concrete code fixes for all 3 issues with exact snippets |
| `projects/ABTestFixes/output/quality-analysis.md` | Test regression risk matrix (Safe/Minor/Breaking per fix) |
| `projects/ABTestFixes/output/integration-analysis.md` | Model selection, new constraints, dream consolidation impact |
| `system/memory/traces/trace_2026-03-12.md` | Execution trace with issue descriptions |

## Prioritized Fix Plan

### P0 — Immediate (unblock all scenarios)

| # | Fix | File(s) | Impact |
|---|-----|---------|--------|
| 1 | **Switch text model** from `gemini-3.1-flash-lite-preview` to `gemini-2.0-flash` | `scripts/ab_test_real.ts` line 277 | 1-line change, unblocks all 5 scenarios |
| 2 | **Add `--text-model` CLI flag** | `scripts/ab_test_real.ts` | ~20 lines, enables rapid model comparison |

### P1 — Core Fixes (mechanism bugs)

| # | Fix | File(s) | Impact | Regression Risk |
|---|-----|---------|--------|----------------|
| 3 | **Progress-aware stuck detector** — only trigger stuck when same opcode AND < 2cm spatial progress | `scenario_runner.ts` lines 196-214, A/B test lines 366-376 | Prevents false kills on straight-line corridor navigation | Minor Update (A/B test local `runScenario()` must mirror) |
| 4 | **Oscillation detector** — detect A-B-A-B complementary opcode patterns (CW/CCW, FWD/BWD) | `scenario_runner.ts` (new block after stuck detection) | Catches net-zero heading oscillation that current detector misses | Minor Update (A/B test needs parallel update) |
| 5 | **Oscillation warning in user message** — emit `OSCILLATION WARNING ... CHANGE STRATEGY` when last 4 actions alternate | `scenario_runner.ts` `buildUserMessage()` | Gives model a signal to break the pattern | Safe (if text includes "CHANGE STRATEGY" for mock) |
| 6 | **Filter constraints by domain** — don't inject code-architecture constraints (6-9) into motor control prompts | `scripts/ab_test_real.ts` `loadFullStackConfig()` | Reduces prompt noise from 11 to 5 relevant constraints | Safe |

### P2 — Format & Dream Fixes

| # | Fix | File(s) | Impact | Regression Risk |
|---|-----|---------|--------|----------------|
| 7 | **Restructure scene: DECISION DATA first** — put TARGET/PROGRESS/CLEARANCE before qualitative prose | `text_scene.ts` `describeScene()` | Flash-lite reads early tokens more reliably | Safe if field names preserved |
| 8 | **Contextual collision** — differentiate frontal vs lateral wall proximity | `text_scene.ts` `describeScene()` | Prevents MOVE_BACKWARD reflex when forward is clear | Minor Update (dream-simulator tests) |
| 9 | **Simplify TEXT_SCENE_SYSTEM_PROMPT** — numbered rules, half the token count | `bytecode_compiler.ts` | Better flash-lite compliance, ~500 vs ~2000 tokens | Safe (prompt consumed by inference, not tests) |
| 10 | **Reclassify PARTIAL as FAILURE** when `finalDist > threshold * 3` | `scenario_runner.ts` | Ensures dream engine analyzes premature-STOP traces | Safe |
| 11 | **Add issue-category metadata** to traces | `scenario_runner.ts`, `dream_engine.ts` | Better dream consolidation targeting | Safe |

### P3 — Tooling

| # | Fix | Description |
|---|-----|-------------|
| 12 | Smoke test mode (`--smoke`) | Single-scenario canary before full suite |
| 13 | Mock baseline comparison in report | Isolates model vs stack issues |
| 14 | Per-frame JSON log export | Post-hoc temporal analysis |
| 15 | Model-tagged trace filenames | Disambiguates multi-model trace history |

## New Negative Constraints Identified

| # | Description | Severity |
|---|-------------|----------|
| 12 | Stuck detector must check spatial progress before triggering — repeated MOVE_FORWARD with decreasing target distance is correct navigation | HIGH |
| 13 | Alternating CW/CCW rotations with net-zero heading change must be detected and broken after 2 cycles | HIGH |
| 14 | New inference models must pass a smoke test (10+ frames without premature STOP) before full A/B deployment | MEDIUM |
| 15 | Code-architecture constraints must NOT be injected into motor control prompts — filter by navigation-relevant context | MEDIUM |

## Key Insight: Code Duplication

The A/B test's `runScenario()` (lines 275-393 in `cognitive-stack-ab.test.ts`) is a **near-complete copy** of `DreamScenarioRunner.runScenario()`. Any fix to `scenario_runner.ts` must be manually mirrored in the test, or the test should be refactored to use the production class. This is the primary regression risk for all P1 fixes.

## Dream Consolidation

- Mode: per-agent parallel dreams (3 DreamEngine sessions)
- Implementation Agent dream: stuck detection, oscillation, scene restructuring
- Quality Agent dream: test regression, code duplication, mock coupling
- Integration Agent dream: model selection, constraint filtering, trace classification
- Status: Running in background

## Learnings

1. **Model capability is the bottleneck, not the cognitive stack.** The mock A/B tests pass 22/22 with deterministic inference, proving the stack architecture is sound. Flash-lite lacks the instruction-following capability to parse structured scene data and sustain multi-frame navigation.

2. **Stuck detection needs two dimensions.** Opcode identity alone is a poor proxy for stagnation. A robot correctly repeating MOVE_FORWARD in a corridor is not stuck — it's doing exactly the right thing. Spatial progress (position delta) is the true signal.

3. **Oscillation evades single-opcode detectors.** The CW/CCW alternation pattern resets the consecutive-identical counter every frame. Both entropy-based (VisionLoop, threshold 0.5 vs oscillation entropy 1.0) and consecutive-count-based (scenario runner) detectors have this blind spot.
