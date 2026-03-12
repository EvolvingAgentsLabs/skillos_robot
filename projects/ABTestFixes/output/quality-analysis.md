# Quality Analysis: Test Regression Risks for A/B Test Fixes

## Files Analyzed

| File | Path | Purpose |
|------|------|---------|
| A/B Test Suite | `__tests__/ab-tests/cognitive-stack-ab.test.ts` | 22 tests: 5 scenarios x baseline/fullstack + dream + strategy + fidelity + cognitive loop + report |
| Dream Simulator Tests | `__tests__/dream/dream-simulator.test.ts` | TextSceneSimulator unit tests + scene description quality checks |
| Dream v2 Tests | `__tests__/dream/dream-v2.test.ts` | Strategy store, trace logger, dream journal tests |
| Bytecode Compiler Tests | `__tests__/cerebellum/bytecode-compiler.test.ts` | Encoding/decoding, compilation modes, tool calls, system prompts |
| Vision Loop Tests | `__tests__/cerebellum/vision-loop.test.ts` | Stuck detection (entropy-based), frame processing, arrival events |
| Source: scenario_runner.ts | `src/3_llmunix_memory/dream_simulator/scenario_runner.ts` | Production stuck detection (lines 196-214) |
| Source: text_scene.ts | `src/3_llmunix_memory/dream_simulator/text_scene.ts` | Scene rendering, two-pass output |
| Source: bytecode_compiler.ts | `src/2_qwen_cerebellum/bytecode_compiler.ts` | TEXT_SCENE_SYSTEM_PROMPT, compilation |

---

## Fix 1: Progress-Aware Stuck Detector

**Proposed change:** Modify stuck detection from "N consecutive identical opcodes" to "N consecutive identical opcodes WITH no spatial progress" (checking target distance delta before declaring stuck).

### Impact on `cognitive-stack-ab.test.ts`

**Classification: Minor Update**

The A/B test has its **own local `runScenario()` function** (lines 275-393) with its own stuck detection logic that is completely independent of `scenario_runner.ts`. The test's stuck detector is at lines 366-376:

```typescript
// Stuck detection
const opcode = decoded?.opcode ?? -1;
if (opcode === lastOpcode && opcode !== Opcode.STOP) {
  consecutiveIdentical++;
} else {
  consecutiveIdentical = 0;
}
lastOpcode = opcode;
if (consecutiveIdentical >= 6) {
  stuckCount++;
  consecutiveIdentical = 0;
}
```

This is a **duplicate** of the production code's logic. If you change the production `scenario_runner.ts` to be progress-aware, the A/B test's local `runScenario()` will NOT be affected -- it will continue using the old stuck detection. This creates a **divergence** between the test and production behavior.

Tests that assert `stuckCount` values:
- "Full Stack has fewer stuck detections" (line 537): `expect(fullStackResult.stuckCount).toBeLessThanOrEqual(baselineResult.stuckCount)` -- **comparative**, so threshold-safe.
- "Cycle 2 should have fewer or equal stuck detections" (line 883): same pattern -- **comparative**, threshold-safe.
- Aggregate report (line 926): `expect(fullStackMetrics.totalStuck).toBeLessThanOrEqual(baselineMetrics.totalStuck)` -- **comparative**, threshold-safe.

**Risk:** The tests will not break, but they will no longer exercise the new progress-aware logic. To get meaningful coverage, you would need to update the A/B test's local `runScenario()` to mirror the new progress-aware stuck detection. This is a code alignment issue, not a test failure issue.

### Impact on `scenario_runner.ts` (production code, lines 196-214)

This is the target of the fix. The `DreamScenarioRunner.runScenario()` method already has access to `currentFrame.targetDistance` and the previous frame's distance through `frameLog`, so adding a distance delta check is mechanically straightforward.

### Impact on `dream-simulator.test.ts`

**Classification: Safe**

These tests exercise `TextSceneSimulator` (scene rendering, kinematics, collisions). They do NOT test stuck detection at all. No changes needed.

### Impact on `vision-loop.test.ts`

**Classification: Safe**

The VisionLoop uses entropy-based stuck detection (`computeOpcodeEntropy()`), which is a completely different mechanism from the scenario runner's consecutive-identical-opcode approach. The VisionLoop tests (lines 241-278) test the entropy-based stuck detection and will not be affected.

### Impact on other test files

13 other test files import from `bytecode_compiler.ts`, but none import from `scenario_runner.ts` directly (only `cognitive-stack-ab.test.ts` reimplements its logic). No other tests will break.

---

## Fix 2: Oscillation Detection

**Proposed change:** Add detection for alternating CW/CCW rotations (net-zero heading change) in both `buildUserMessage()` and the stuck detector in `scenario_runner.ts`.

### Impact on `cognitive-stack-ab.test.ts`

**Classification: Minor Update (two areas)**

**Area 1 -- Stuck warning in `buildUserMessage()` (lines 309-315):**

The A/B test's local `runScenario()` has its own user message builder at lines 293-336 that mirrors the production `buildUserMessage()`. The stuck warning logic at lines 310-315 only checks for 3 identical actions:

```typescript
if (recentFrames.length >= 3) {
  const last3 = recentFrames.slice(-3);
  if (last3.every(f => f.opcode === last3[0].opcode)) {
    parts.push(`  ** STUCK WARNING: same action "${last3[0].opcode}" repeated 3x. CHANGE STRATEGY. **`);
  }
}
```

If you add oscillation detection to the production `buildUserMessage()`, the A/B test's local copy will not emit oscillation warnings. The mock `makeNavigationDecision()` function (lines 87-253) reacts to the text "stuck warning" and "change strategy" at line 126:

```typescript
if (lower.includes('stuck warning') || lower.includes('change strategy')) {
```

This means the mock inference is already primed to respond to stuck/oscillation warnings via string matching. If you add an oscillation warning with phrasing like "OSCILLATION WARNING" or "CHANGE STRATEGY", the mock inference at line 126 would only catch it if the text includes "change strategy" (case-insensitive). This is critical for the fix to actually work in the A/B test context.

**Area 2 -- Stuck detector (lines 366-376):**

Same situation as Fix 1 -- the A/B test's local stuck detector only counts consecutive identical opcodes. Adding oscillation detection to production code will not be tested by the A/B tests unless the local `runScenario()` is also updated.

**Area 3 -- Mock inference `makeNavigationDecision()` (lines 87-253):**

The mock parses structured scene data including PROGRESS status, target bearing, and forward clearance. It does NOT parse or react to oscillation-specific patterns. The mock would need a new branch to handle oscillation scenarios (e.g., "if last 4 actions alternate CW/CCW, try a forward move instead").

However, since all comparison tests are **relative** (fullStack <= baseline), and the mock has no oscillation-specific handling, both conditions would exhibit the same oscillation behavior. The tests will not fail but will not demonstrate oscillation detection's value.

### Impact on `scenario_runner.ts` (production code)

The production `buildUserMessage()` (lines 338-391) has the same 3-identical-action stuck warning (lines 357-363). Adding oscillation detection here would be a new code path. The `DreamInferenceRouter` processes this user message, so real inference would see the oscillation warning and (hopefully) change behavior. In the A/B tests, the mock inference would need to react to whatever warning text is emitted.

### Impact on `dream-simulator.test.ts`

**Classification: Safe**

No stuck detection or user message construction is tested here. These tests only validate scene rendering output from `TextSceneSimulator`.

### Impact on `bytecode-compiler.test.ts`

**Classification: Safe**

No scene format or stuck detection logic is tested. These tests validate bytecode encoding/decoding and compilation modes.

### Impact on `vision-loop.test.ts`

**Classification: Safe**

The VisionLoop already catches oscillation via entropy-based detection (Shannon entropy < 0.5 on a window of 8 opcodes). An alternating CW/CCW pattern of 8 opcodes (4 CW + 4 CCW) produces entropy = 1.0 bit, which is above the 0.5 threshold -- so the VisionLoop would NOT catch pure 2-opcode oscillation. However, modifying the VisionLoop's stuck detection is not part of the proposed fix scope; the fix targets `scenario_runner.ts` and `buildUserMessage()`. No vision-loop tests are at risk.

**Note:** There is an interesting discrepancy -- the docs claim entropy-based stuck detection "catches oscillation" but with a threshold of 0.5, a strict 2-opcode alternation (entropy = 1.0) would not trigger it. This is a pre-existing issue, not a regression from the proposed fix.

---

## Fix 3: Simplified Prompt Format

**Proposed change:** Restructure `TEXT_SCENE_SYSTEM_PROMPT` in `bytecode_compiler.ts` to be shorter/simpler, or reorder scene output in `text_scene.ts` to put quantitative data before qualitative descriptions.

### Impact on `cognitive-stack-ab.test.ts`

**Classification: Minor Update to Breaking (depending on scope)**

The mock `makeNavigationDecision()` function (lines 87-253) is **tightly coupled** to the scene format. It parses specific patterns:

```typescript
// Parse PROGRESS status
const progressMatch = sceneText.match(/PROGRESS:\s*(approaching|receding|stuck|initial)/);

// Parse target distance and relative bearing from PROGRESS line
const targetInfoMatch = sceneText.match(/target=(\d+)cm at (-?\d+)deg relative/);

// Parse forward clearance
const fwdClearMatch = sceneText.match(/forward:\s*(\d+)cm\s*(clear|BLOCKED)/);
```

And also matches qualitative text:
- `lower.includes('target visible')`
- `lower.includes('stuck warning')`
- `lower.includes('collision warning')`
- `lower.includes('very close to a wall')`
- `lower.includes('target is very close')`
- `lower.includes('approaching arrival')`
- `lower.includes('not visible in the current field of view')`
- `lower.includes('doorway')` and `lower.includes('visible')`

**Scenario A -- Only reorder sections (quantitative before qualitative):** If you move the `=== SPATIAL ANALYSIS ===` section before `=== SCENE PERCEPTION ===` in `text_scene.ts describeScene()`, the mock's regex patterns would still match (they search the entire string, not position-dependent). **Classification: Safe.**

**Scenario B -- Rename section headers or change field format:** If you change `PROGRESS:` to something else, or change `target=Ncm at Mdeg relative` to a different format, the mock's regexes (lines 98, 102, 107) would **break**. **Classification: Breaking** -- all 5 scenario pairs (10 tests) would degrade to fallback behavior.

**Scenario C -- Simplify TEXT_SCENE_SYSTEM_PROMPT only (in bytecode_compiler.ts):** The system prompt is consumed by the inference engine, not the mock. The mock ignores the system prompt entirely (the baseline inference function discards `_systemPrompt` at line 65). **Classification: Safe.**

### Impact on `dream-simulator.test.ts`

**Classification: Minor Update (if qualitative text changes)**

These tests check scene text content:
- Line 47: `expect(frame.sceneText).toContain('Long corridor')` -- depends on room label, not format
- Line 55: `expect(frame.sceneText).toContain('TARGET VISIBLE')` -- depends on uppercase marker
- Line 56: `expect(frame.sceneText).toContain('Red Cube')` -- depends on object label
- Line 119: `expect(frame.sceneText).toContain('WARNING')` -- depends on collision warning text
- Line 209: `expect(frame.sceneText).toContain('doorway')` -- depends on doorway description
- Lines 218-221: Check for obstacle objects by name ('box', 'Cardboard', 'crate', 'books')
- Lines 230-235: Check for 'clearance', 'clear', or 'blocked' in lowercase

If `describeScene()` in `text_scene.ts` changes the format of these strings, these assertions would need updating. However, if the change is purely about **reordering** sections or making the prompt shorter, the text content itself stays the same. **Classification: Safe for reordering, Minor Update for text changes.**

### Impact on `bytecode-compiler.test.ts`

**Classification: Safe to Minor Update**

The bytecode compiler tests include two system prompt tests (lines 477-488):

```typescript
test('includes the goal', () => {
  const prompt = compiler.getSystemPrompt('explore the room');
  expect(prompt).toContain('explore the room');
});

test('includes opcode reference', () => {
  const prompt = compiler.getSystemPrompt('test');
  expect(prompt).toContain('AA 01');
  expect(prompt).toContain('Move forward');
});
```

These test `getSystemPrompt()` (the hex/fewshot prompt), NOT `getTextSceneSystemPrompt()`. The `getTextSceneSystemPrompt()` method has **zero dedicated tests** in the bytecode compiler test suite.

If the simplified prompt retains the `{{GOAL}}` placeholder substitution, these tests remain unaffected. **Classification: Safe** unless the hex/fewshot prompt is also modified (which is not proposed).

### Impact on other tests that import from `bytecode_compiler.ts`

13 test files import from `bytecode_compiler.ts`, but they only use `Opcode`, `encodeFrame`, `decodeFrame`, `formatHex`, `OPCODE_NAMES`, `BytecodeCompiler`, and `FRAME_SIZE`. None import or test `TEXT_SCENE_SYSTEM_PROMPT`. **Classification: Safe.**

---

## Summary Table

| Fix | File | Classification | Details |
|-----|------|---------------|---------|
| **1. Progress-aware stuck** | `cognitive-stack-ab.test.ts` | **Minor Update** | Local `runScenario()` has its own stuck detector (line 373: `consecutiveIdentical >= 6`) that won't be updated. Tests won't break but won't exercise new logic. Need to update local copy to mirror production behavior. |
| **1. Progress-aware stuck** | `dream-simulator.test.ts` | **Safe** | No stuck detection tested |
| **1. Progress-aware stuck** | `bytecode-compiler.test.ts` | **Safe** | No stuck detection tested |
| **1. Progress-aware stuck** | `vision-loop.test.ts` | **Safe** | Uses entropy-based detection, different mechanism |
| **2. Oscillation detection** | `cognitive-stack-ab.test.ts` | **Minor Update** | Local `buildUserMessage()` (lines 309-315) only warns on 3 identical actions, not oscillation. Mock inference reacts to "stuck warning" / "change strategy" text. Need to (a) update local stuck warning to also detect oscillation, and (b) ensure oscillation warning text includes "CHANGE STRATEGY" for mock to react. |
| **2. Oscillation detection** | `dream-simulator.test.ts` | **Safe** | No message construction tested |
| **2. Oscillation detection** | `bytecode-compiler.test.ts` | **Safe** | No scene format tested |
| **2. Oscillation detection** | `vision-loop.test.ts` | **Safe** | Separate entropy mechanism, not modified |
| **3. Simplified prompt** | `cognitive-stack-ab.test.ts` | **Safe** (reorder) / **Breaking** (rename fields) | Mock `makeNavigationDecision()` has 3 regexes parsing PROGRESS, target info, and clearance lines. Reordering is safe; renaming fields breaks all 5 scenario pairs. |
| **3. Simplified prompt** | `dream-simulator.test.ts` | **Safe** (reorder) / **Minor Update** (text changes) | 7 assertions check scene text content by string containment |
| **3. Simplified prompt** | `bytecode-compiler.test.ts` | **Safe** | Tests only cover `getSystemPrompt()`, not `getTextSceneSystemPrompt()` |

---

## Critical Observations

### 1. Code Duplication Between Test and Production

The A/B test's `runScenario()` (lines 275-393) is a **near-copy** of `DreamScenarioRunner.runScenario()` from `scenario_runner.ts`. Both implement:
- The same perception-action loop structure
- The same stuck detection algorithm (consecutive identical opcodes, threshold = 6)
- The same `buildUserMessage()` logic with stuck warning at 3 identical actions
- The same progress tracking with distance deltas

This duplication means **any fix to `scenario_runner.ts` will not automatically apply to the A/B tests**. The A/B tests must be updated in parallel, or refactored to use the production `DreamScenarioRunner` class instead of a local reimplementation.

### 2. All Comparison Assertions Are Relative

Every test that compares baseline vs. fullstack uses relative comparisons (`toBeLessThanOrEqual`), not absolute thresholds. This means changes that affect both conditions equally will not cause failures. The exception is the efficiency test (line 495):

```typescript
expect(fullStackResult.framesUsed).toBeLessThanOrEqual(baselineResult.framesUsed + 5);
```

This has a hardcoded tolerance of +5 frames, which could theoretically be affected if stuck detection changes cause one condition to run significantly more frames.

### 3. Mock Inference Is Regex-Coupled to Scene Format

The mock `makeNavigationDecision()` uses 3 specific regexes to parse the scene text. Any change to the PROGRESS line format, target info format, or clearance format will break the mock's ability to make informed decisions. Without structured data parsing, the mock would fall through to legacy fallback patterns (lines 200-228) or the final fallback (line 252: `move_forward` at 150/150), which would make both conditions behave identically, and comparative tests would trivially pass but provide no signal.

### 4. Missing Test Coverage for `getTextSceneSystemPrompt()`

There are **zero tests** that validate `getTextSceneSystemPrompt()` output. The A/B test calls it at line 281 but never asserts on its content. If the prompt is simplified in ways that remove critical instructions (e.g., the "NEVER repeat same action 3 times" constraint), there would be no test to catch the regression.

### 5. VisionLoop Oscillation Detection Gap

The VisionLoop's entropy threshold (0.5) does not catch 2-opcode oscillation patterns (entropy = 1.0 bit). This is documented as working in `docs/09-Memory-Fidelity-And-Dream-Simulation.md` line 139, but the math does not support the claim. The proposed Fix 2 (oscillation detection in scenario_runner) would address this gap for dream simulation but not for the real-time VisionLoop.

---

## Recommendations

1. **Before implementing Fix 1 or Fix 2:** Refactor the A/B test to import and use `DreamScenarioRunner` from `scenario_runner.ts` instead of maintaining a local copy of `runScenario()`. This eliminates the duplication problem and ensures fixes are automatically tested.

2. **For Fix 3 (prompt simplification):** Keep the PROGRESS, target info, and clearance field names/formats identical to current output. Only modify the ordering of sections and the verbosity of the system prompt. This keeps all existing tests green.

3. **Add a test for `getTextSceneSystemPrompt()`:** Add at least one test in `bytecode-compiler.test.ts` that validates the text-scene system prompt contains key sections (GOAL substitution, AVAILABLE ACTIONS, DECISION RULES).

4. **For Fix 2 (oscillation detection):** Ensure the oscillation warning text includes the phrase "CHANGE STRATEGY" so the A/B test's mock inference (line 126) can react to it without code changes to the mock.
