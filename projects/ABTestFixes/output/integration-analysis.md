# Integration Analysis: A/B Test Failures (0/5 Score)

**Date:** 2026-03-12
**Analyzed by:** Integration Agent
**Scope:** Model selection, constraint additions, dream consolidation impact, script improvements

---

## 1. Model Selection Analysis

### Current Configuration

The `DreamInferenceRouter` (`src/3_llmunix_memory/dream_simulator/dream_inference_router.ts`) uses a dual-model architecture:

- **Text model** (`textModel`): Used for text-only dream simulation scenes. Currently hardcoded to `gemini-3.1-flash-lite-preview` in `scripts/ab_test_real.ts` (line 277).
- **Image model** (`geminiModel`): Used for real camera frames. Defaults to `gemini-2.0-flash` or `GEMINI_MODEL` env var, set to `gemini-robotics-er-1.5-preview` in practice.

The router instantiates two separate `GeminiRoboticsInference` backends (lines 78-79) and routes based on whether images are present. All dream simulation scenes are text-only, so the text model handles 100% of A/B test inference.

### Is `gemini-3.1-flash-lite-preview` the Right Model?

**No.** The evidence strongly suggests it is not. Three failure modes point to model capability limitations:

1. **Premature STOP calls:** The baseline traces from 2026-03-11 show that in 4 of 5 scenarios, flash-lite issued `stop()` within 1-2 frames. The corridor-target baseline trace shows: frame 0 = `move_forward` (reasonable), frame 1 = `stop` (incorrect -- target was 229cm away). This is not stuck detection killing the run; the model itself decided to stop. Flash-lite appears unable to maintain multi-step navigation reasoning.

2. **Oscillation (CW/CCW):** The 2026-03-12 fullstack obstacle-avoidance trace is dominated by `rotate_ccw` 90-degree rotations (18 out of 20 sampled frames). The doorway-navigation trace shows `rotate_ccw` 90-degree calls for 16 of 19 sampled frames. Flash-lite is not interpreting the SPATIAL ANALYSIS section correctly. Despite the scene text explicitly providing structured data like `PROGRESS: stuck delta=0.0cm` and `target=201cm at -15deg relative`, the model continues emitting the same rotation instead of switching strategy.

3. **Ignoring structured numerical data:** The two-pass scene description format (SCENE PERCEPTION + SPATIAL ANALYSIS) was designed to provide both natural language and machine-readable numerical context. Flash-lite appears to latch onto a single interpretation and repeat it. This is characteristic of a model with insufficient instruction-following capability for structured input parsing.

### Recommendation: Switch to `gemini-2.0-flash`

| Factor | `gemini-3.1-flash-lite-preview` | `gemini-2.0-flash` |
|--------|-------------------------------|-------------------|
| Tool calling fidelity | Poor -- ignores scene context | Production-proven in motor control loop |
| Structured data parsing | Ignores SPATIAL ANALYSIS numbers | Designed for structured prompts |
| Multi-step reasoning | Fails after 1-2 frames | Handles 150+ frame sequences in mock tests |
| Latency (observed) | ~978ms avg | Expected similar or faster (flash-class) |
| Cost | Lower per token | Higher per token but fewer wasted frames |
| Thinking budget support | May not support thinkingConfig | Full support |

The `gemini-2.0-flash` model is already the default motor control model (`src/2_qwen_cerebellum/gemini_robotics.ts`, line 57: `model: 'gemini-robotics-er-1.5-preview'` for images, but the dream router defaults to `gemini-2.0-flash` at line 65). The current override in `ab_test_real.ts` hardcoding `gemini-3.1-flash-lite-preview` (line 277) bypasses this default. Simply removing the hardcoded override would route text inference to the same model the production stack uses.

**Latency/cost tradeoff:** At ~978ms avg latency for flash-lite across 5 scenarios averaging ~96 frames (baseline) to ~152 frames (fullstack), total inference time was 478-743 seconds. If `gemini-2.0-flash` has similar latency (both are flash-class models), the cost increase is negligible. The real cost savings come from fewer wasted frames -- if the model navigates successfully in 30 frames instead of timing out at 200, total inference calls drop by 85%.

### CLI Model Selection

The `ab_test_real.ts` script should support model selection via CLI arguments. Currently the script accepts `--scenario` and `--verbose` (lines 42-75). The proposed additions:

```
--text-model <model>    Text inference model (default: gemini-2.0-flash)
--image-model <model>   Image inference model (default: from GEMINI_MODEL env)
--stuck-threshold <n>   Consecutive identical opcodes before stuck (default: 6)
```

This would allow rapid model comparison without code changes:
```bash
npm run ab:test -- --text-model gemini-2.0-flash
npm run ab:test -- --text-model gemini-3.1-flash-lite-preview --scenario corridor-target
```

---

## 2. New Negative Constraints for Strategy Store

### Existing Constraint Landscape

The current `_negative_constraints.md` has 11 constraints organized across several categories:
- Motor control safety (Constraints 1-3): obstacle speed, doorway speed, rotation angles
- Memory fidelity (Constraints 4-5): trace source weighting
- Code architecture (Constraints 6-9): backward compat, type narrowing, dependencies, re-exports
- Configuration integrity (Constraints 10-11): prompt-mode alignment, debugging assumptions

The real A/B test exposed three issues that are NOT covered by existing constraints, even though Constraint 10 (prompt-mode alignment) is tangentially related.

### Proposed New Constraints

#### Constraint 12 (HIGH): Stuck Detector False Positives on Valid Straight-Line Navigation

```markdown
## Constraint 12
- **Description:** Do not use the same stuck-detection threshold for all opcode types -- repeated MOVE_FORWARD with decreasing target distance is valid corridor navigation, not a stuck condition. The stuck detector must consider whether the repeated action is making progress (distance delta < 0) before triggering.
- **Context:** stuck detection, corridor navigation, scenario runner, straight-line approach
- **Severity:** high
- **Learned From:** ab-test-report-2026-03-11 (Corridor Target Seek: 3 stuck detections in 19 frames during correct straight-line navigation), ab-test-report-2026-03-12 (same pattern)
```

**Rationale:** The corridor-target scenario is a straight line from (0,20) to (0,280). The correct behavior is repeated `move_forward` at constant speed. The current `stuckThreshold` of 6 (in `scenario_runner.ts`, line 94) counts 6 consecutive identical opcodes as stuck, regardless of whether the robot is making progress. After 3 stuck detections (`maxStuckRetries=3`), the scenario aborts. This means the robot is killed for doing exactly the right thing. The existing Constraint 3 addresses rotation angles for stuck recovery, but not the false-positive triggering of stuck detection itself.

#### Constraint 13 (HIGH): Net-Zero Heading Change from Oscillating Rotations

```markdown
## Constraint 13
- **Description:** Do not allow alternating CW/CCW rotations of the same magnitude to persist for more than 2 cycles -- if the net heading change over 4 rotation commands is less than 10 degrees, force a forward movement or a unidirectional rotation commit. Oscillating rotations indicate the model is not converging on a direction.
- **Context:** rotation oscillation, heading change tracking, motor control loop, obstacle avoidance
- **Severity:** high
- **Learned From:** ab-test-report-2026-03-12 (Obstacle Avoidance: rotate_cw 90 then 18x rotate_ccw 90 with timeout at 200 frames; Doorway Navigation: 16x rotate_ccw 90 with timeout)
```

**Rationale:** The traces from 2026-03-12 show a clear pattern: one `rotate_cw` 90 degrees followed by many `rotate_ccw` 90 degrees. The stuck detector (which counts consecutive *identical* opcodes) does catch some of this, but the CW-to-CCW alternation resets the counter. The net heading change over a full CW+CCW cycle is zero degrees -- the robot spins in place forever. This is distinct from single-direction stuck (Constraint 3) because it evades the current detector. Existing Constraint 3 only addresses insufficient rotation magnitude, not oscillation patterns.

#### Constraint 14 (MEDIUM): Model Capability Validation Before Deployment

```markdown
## Constraint 14
- **Description:** Do not deploy a new inference model in the A/B test pipeline without first running a single-scenario smoke test to verify the model can (a) parse the two-pass scene format, (b) emit valid tool calls that vary based on scene context, and (c) sustain navigation for at least 10 frames without premature STOP. A model that issues STOP on frame 1 in 4 of 5 scenarios should be rejected before running the full suite.
- **Context:** model selection, inference model validation, A/B test pipeline, scene format compatibility
- **Severity:** medium
- **Learned From:** ab-test-report-2026-03-11 (flash-lite issued STOP on frame 1 in obstacle-avoidance, wall-following, doorway-navigation; on frame 2 in room-exploration -- all baselines), ab-test-report-2026-03-12 (same pattern in baseline)
```

**Rationale:** Both the 2026-03-11 and 2026-03-12 runs burned significant API budget (143-743 seconds of inference time) only to score 0/5. A 30-second smoke test with the corridor-target scenario would have revealed flash-lite's incompatibility immediately. This is a process constraint, not a motor control constraint, but it directly prevents wasted integration test cycles. Existing Constraint 11 (about debugging assumptions) is adjacent but does not specifically address pre-deployment validation.

#### Constraint 15 (MEDIUM): Constraint Injection Relevance Filtering

```markdown
## Constraint 15
- **Description:** Do not inject all negative constraints into the inference system prompt regardless of their domain relevance -- constraints about code architecture (backward compat, type narrowing, re-export hops) should NOT be injected into motor control prompts. Filter constraints to only include those with navigation-relevant context (obstacle, wall, corridor, doorway, speed, rotation, stuck, collision).
- **Context:** constraint injection, system prompt construction, A/B test Full Stack condition, prompt length optimization
- **Severity:** medium
- **Learned From:** ab-test-report-2026-03-12 (Full Stack condition injected 11 constraints including 6 code-architecture constraints irrelevant to motor control, possibly confusing the inference model with noise)
```

**Rationale:** The Full Stack condition in both reports injected ALL 11 constraints, including constraints about npm dependencies, TypeScript re-exports, and backward-compatible wrapper classes. These are meaningless to a motor control model and consume prompt budget. The `loadFullStackConfig()` function in `ab_test_real.ts` (lines 88-149) already filters strategies by navigation-relevant trigger goals (line 98-99), but does not filter constraints at all -- it loads every constraint from `getNegativeConstraints()` (line 109). With flash-lite's limited context parsing, injecting 6 irrelevant constraints (Constraints 6-9, plus parts of 4-5) likely diluted the signal of the 5 relevant ones.

---

## 3. Dream Consolidation Impact

### How Traces Feed Into Dream Consolidation

The `DreamEngine` (`src/llmunix-core/dream_engine.ts`) processes traces through three phases:

1. **Phase 1 (Slow Wave Sleep):** Parses trace files from the `tracesDir`, groups them into `TraceSequence` objects, and scores them. Failure sequences are analyzed by the LLM to extract `NegativeConstraint` objects. Low-value sequences (score < 0.1) are pruned.

2. **Phase 2 (REM Sleep):** Successful/unknown sequences are abstracted into strategies or merged with existing ones. The fidelity weight from the trace source multiplies into both the scoring formula and the confidence initialization.

3. **Phase 3 (Consolidation):** Strategies and constraints are persisted to disk, a dream journal entry is appended, and old trace files are pruned.

### Current Trace State from 0/5 Runs

The trace files in `src/3_llmunix_memory/traces/ab-baseline/` and `ab-fullstack/` contain the raw execution data from both runs. Examining the traces reveals:

**2026-03-11 baseline traces:**
- 5 traces, all `PARTIAL` outcome (the runner used `Ended at frame N` reason instead of explicit FAILURE for premature STOP)
- All tagged as `DREAM_TEXT` source with 0.3 confidence
- Corridor-target: 2 frames (move_forward then stop)
- Room-exploration: 2 frames (rotate_cw then stop)
- Obstacle-avoidance: 1 frame (stop immediately)
- Wall-following: 1 frame (stop immediately)
- Doorway-navigation: 1 frame (stop immediately)

**2026-03-12 fullstack traces:**
- 3 traces visible (obstacle-avoidance, wall-following, doorway-navigation), all `FAILURE` outcome
- All show rotation oscillation patterns
- Obstacle-avoidance: 200 frames, 18/20 sampled frames are `rotate_ccw`
- Wall-following: 200 frames, mix of `rotate_cw`, `move_backward`, and `rotate_cw`
- Doorway-navigation: 200 frames, 16/19 sampled frames are `rotate_ccw`

### Should These Be Tagged as FAILURE Traces?

**Yes, unambiguously.** The 2026-03-11 traces are currently tagged as `PARTIAL` because the scenario runner assigns `PARTIAL` when the run ends without hitting the goal *and* without being explicitly aborted by stuck detection. However, these are functional failures:
- A robot that stops on frame 1 has not partially completed a 200-frame navigation task
- The `PARTIAL` tag gives them an outcome weight of 0.6 in scoring (line 393 of dream_engine.ts: `PARTIAL ? 0.6`), which is higher than `FAILURE` (0.8 -- note that failure weight is high because failures are *valuable* for learning)

The 2026-03-12 traces are correctly tagged as `FAILURE` because they hit the 200-frame timeout.

**Recommendation:** The scenario runner should classify any outcome with `finalTargetDistance > goalThresholdCm * 3` as `FAILURE`, not `PARTIAL`. A robot that is 229cm from a target at 20cm threshold has not partially succeeded.

### Impact on Strategy Confidence When Dreamed On

The current fidelity weighting system applies `DREAM_TEXT = 0.3` to these traces. Walking through the math:

For a FAILURE sequence from the 0/5 run:
- `avgConfidence` = 0.3 (from the trace's `**Confidence:** 0.3`)
- `outcomeWeight` = 0.8 (FAILURE)
- `recencyBonus` = ~1.0 (within 1 day)
- `fidelityWeight` = 0.3 (DREAM_TEXT)
- `durationPenalty` = max(1, totalDuration / 10000) = ~19.0 for a 190-second run

`score = (0.3 * 0.8 * 1.0 * 0.3) / 19.0 = 0.0038`

This score is well below the pruning threshold (0.1), so these failure sequences would be **pruned in Phase 1** rather than analyzed, *unless* they are FAILURE sequences specifically. The code at line 447 shows: `const failures = sequences.filter(s => s.outcome === TraceOutcome.FAILURE)` -- failures are analyzed regardless of score. And at line 476: `const toPrune = sequences.filter(s => s.score < 0.1 && s.outcome !== TraceOutcome.FAILURE)` -- failures are explicitly excluded from pruning.

This means:
- The 2026-03-12 FAILURE traces **will** be analyzed in Phase 1, producing negative constraints about oscillation and timeout
- The 2026-03-11 PARTIAL traces **will be pruned** because score < 0.1 and outcome is not FAILURE
- This is a problem: the premature-STOP failures from 2026-03-11 carry important signal that would be lost

### Should We Add Issue-Category Metadata?

**Yes.** The current trace format supports arbitrary metadata through the `**Reason:**` field, but it lacks structured categorization. Three proposed categories:

1. **`issue:stuck-detector-false-positive`** -- Applied when the scenario was aborted by stuck detection but target distance was decreasing. This differentiates "actually stuck" from "correctly repeating a working action."

2. **`issue:oscillation`** -- Applied when net heading change over N frames is near zero despite active rotation commands. Detectable by summing CW degrees as positive and CCW degrees as negative.

3. **`issue:model-limitation`** -- Applied when the model issues premature STOP or produces outputs that do not respond to scene context variation. This requires comparing scene text deltas to output deltas.

These categories could be stored as a new trace field:
```
**Issue Category:** oscillation
```

The `ParsedTrace` type in `dream_engine.ts` would need a new optional field `issueCategory: string | null`, and the regex parser would need a new match pattern. The `DreamDomainAdapter` failure analysis prompt could then include the category as context, leading to more specific negative constraints.

---

## 4. A/B Test Script Improvements

### Current Script Architecture

`scripts/ab_test_real.ts` runs a clean two-condition comparison:
1. Loads strategies and constraints from `system/memory/strategies/`
2. Runs all 5 scenarios in Baseline (no strategies/constraints) then Full Stack
3. Generates a markdown report to `projects/GeminiCore/output/`
4. Writes traces to `src/3_llmunix_memory/traces/ab-baseline/` and `ab-fullstack/`

### Proposed Improvements

#### 4.1. Compare Against Mock A/B Test Baseline

**Yes, this is valuable.** The mock A/B test in `__tests__/ab-tests/cognitive-stack-ab.test.ts` uses deterministic inference and passes all 22 tests. This establishes a performance ceiling for what the cognitive stack *should* achieve with perfect inference. Comparing real model results against the mock baseline answers the question: "Is the model inference quality the bottleneck, or is the cognitive stack itself broken?"

Implementation approach:
- Run the 5 mock scenarios with `createBaselineInference()` at test start (fast, no API needed)
- Store mock baseline metrics (frames to goal, collisions, stuck counts)
- Add a "Mock Baseline" column to the report table
- Calculate a "Model Fidelity Score" = (real success rate) / (mock success rate)

For the current 0/5 run, mock vs real comparison would show:
- Mock baseline: ~5/5 goals reached (deterministic mock always navigates correctly)
- Real baseline: 0/5 goals reached
- Model Fidelity Score: 0.0

This immediately confirms the issue is model capability, not cognitive stack design.

#### 4.2. Save Per-Frame Logs

**Yes.** The `ScenarioResult.frameLog` array contains detailed per-frame data (scene text, VLM output, bytecode, pose, distance, collision) but this is only used for the summary report. The raw frame logs should be persisted for post-hoc analysis.

Proposed implementation:
- When `--verbose` is passed, or with a new `--save-frames` flag, write frame logs as JSON
- File path: `projects/GeminiCore/output/frames/ab-{condition}-{scenario}-{date}.json`
- Each entry includes the full scene text, raw VLM output, compiled bytecode, pose, target distance, and collision state
- This enables analysis like "at which frame did oscillation begin?" and "what was the scene text when the model first issued STOP?"

The frame logs from the 0/5 run are particularly valuable for diagnosing the flash-lite failure mode. Without them, we can only see the sampled frames in the trace files (sampled to 20 frames from up to 200), which loses temporal detail about when behavior transitions occur.

#### 4.3. Tag Trace Files with Model Name

**Yes, strongly recommended.** Currently, trace files are written to `ab-baseline/trace_2026-03-11.md` and `ab-fullstack/trace_2026-03-11.md`. These filenames carry no information about which model generated them. When comparing runs across models, the traces become ambiguous.

Proposed naming convention:
```
trace_{date}_{textModel}_{imageModel}.md
```

Example:
```
trace_2026-03-12_gemini-3.1-flash-lite-preview_gemini-robotics-er-1.5-preview.md
trace_2026-03-12_gemini-2.0-flash_gemini-robotics-er-1.5-preview.md
```

The model names should also be recorded inside the trace metadata:
```
**Text Model:** gemini-3.1-flash-lite-preview
**Image Model:** gemini-robotics-er-1.5-preview
```

This requires changes to:
- `DreamScenarioRunner.writeTraces()` in `scenario_runner.ts` (line 397): Accept model names in config and include them in filenames and trace headers
- `DreamEngine.parseTraceFiles()` in `dream_engine.ts` (line 160): Add regex for the new model metadata fields (backward-compatible -- old traces without these fields remain parseable)

#### 4.4. Additional Script Improvements

**Smoke test mode:**
```
npm run ab:test -- --smoke --scenario corridor-target
```
Runs only the baseline condition on a single scenario with `maxFrames=15`. If the model issues STOP within 3 frames, abort early with a diagnostic message:
```
SMOKE TEST FAILED: Model issued STOP on frame 1. The selected text model
(gemini-3.1-flash-lite-preview) does not appear to sustain multi-frame
navigation reasoning. Consider switching to gemini-2.0-flash.
```
This addresses Proposed Constraint 14 programmatically.

**Oscillation detector in the runner:**
After each frame, track net heading change over the last 4 rotation frames. If `|net_heading_change| < 10` over 4 rotation commands, inject an explicit directive into the next user message:
```
** WARNING: You have been oscillating CW/CCW with net-zero heading change.
COMMIT to a single rotation direction and then MOVE FORWARD. **
```
This is analogous to the existing `STUCK WARNING` message (scenario_runner.ts lines 358-363) but targets a different failure mode.

**Output directory parameterization:**
Currently hardcoded to `projects/GeminiCore/output/` (line 271). Should be configurable or at least model-aware:
```
projects/GeminiCore/output/{text-model}/ab-test-report-{date}.md
```

---

## Summary of Recommendations (Priority Order)

| Priority | Action | Impact | Effort |
|----------|--------|--------|--------|
| P0 | Switch text model from `flash-lite` to `gemini-2.0-flash` | Unblocks all 5 scenarios | 1 line change |
| P0 | Add CLI `--text-model` flag | Enables rapid model comparison | ~20 lines |
| P1 | Add progress-aware stuck detection (Constraint 12) | Prevents false-positive kills on straight-line nav | ~15 lines in runner |
| P1 | Add oscillation detector (Constraint 13) | Prevents net-zero rotation loops | ~20 lines in runner |
| P1 | Filter constraints by domain relevance (Constraint 15) | Reduces prompt noise | ~10 lines in `loadFullStackConfig` |
| P2 | Re-classify PARTIAL as FAILURE when far from goal | Ensures dream engine analyzes all failures | ~5 lines in runner |
| P2 | Add issue-category metadata to traces | Better dream consolidation | ~30 lines across runner + engine |
| P2 | Save per-frame JSON logs | Enables detailed post-hoc analysis | ~20 lines |
| P2 | Tag traces with model names | Disambiguates multi-model trace history | ~15 lines |
| P3 | Add smoke test mode | Prevents wasted API budget | ~25 lines |
| P3 | Compare against mock baseline in report | Isolates model vs stack issues | ~40 lines |
| P3 | Add model validation constraint (Constraint 14) | Process guard | Strategy store only |

---

## Key Files Referenced

| File | Role |
|------|------|
| `/Users/agustinazwiener/RoClaw/scripts/ab_test_real.ts` | A/B test runner script (hardcodes flash-lite on line 277) |
| `/Users/agustinazwiener/RoClaw/src/3_llmunix_memory/dream_simulator/dream_inference_router.ts` | Dual-model routing (text vs image) |
| `/Users/agustinazwiener/RoClaw/src/3_llmunix_memory/dream_simulator/scenario_runner.ts` | Scenario execution with stuck detection (threshold=6, maxRetries=3) |
| `/Users/agustinazwiener/RoClaw/src/3_llmunix_memory/dream_simulator/text_scene.ts` | Two-pass scene renderer (SCENE PERCEPTION + SPATIAL ANALYSIS) |
| `/Users/agustinazwiener/RoClaw/src/2_qwen_cerebellum/gemini_robotics.ts` | Gemini API adapter (default model: gemini-robotics-er-1.5-preview) |
| `/Users/agustinazwiener/RoClaw/src/llmunix-core/dream_engine.ts` | Three-phase dream consolidation with fidelity weighting |
| `/Users/agustinazwiener/RoClaw/src/llmunix-core/types.ts` | TraceSource enum, TRACE_FIDELITY_WEIGHTS, NegativeConstraint type |
| `/Users/agustinazwiener/RoClaw/src/3_llmunix_memory/roclaw_dream_adapter.ts` | Domain adapter for dream engine (bytecode RLE, LLM prompts) |
| `/Users/agustinazwiener/RoClaw/system/memory/strategies/_negative_constraints.md` | Current 11 negative constraints |
| `/Users/agustinazwiener/RoClaw/__tests__/ab-tests/cognitive-stack-ab.test.ts` | Mock A/B test (22 tests, deterministic, all passing) |
| `/Users/agustinazwiener/RoClaw/projects/GeminiCore/output/ab-test-report-2026-03-12.md` | Most recent real A/B test report (0/5) |
| `/Users/agustinazwiener/RoClaw/projects/GeminiCore/output/ab-test-report-2026-03-11.md` | First real A/B test report (0/5) |
| `/Users/agustinazwiener/RoClaw/src/3_llmunix_memory/traces/ab-baseline/trace_2026-03-11.md` | Baseline traces (premature STOP pattern) |
| `/Users/agustinazwiener/RoClaw/src/3_llmunix_memory/traces/ab-fullstack/trace_2026-03-12.md` | Fullstack traces (oscillation pattern) |
