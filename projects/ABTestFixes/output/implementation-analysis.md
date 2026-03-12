# Implementation Analysis: A/B Test Critical Fixes

**Date:** 2026-03-12
**Context:** RoClaw A/B test scored 0/5 goals for both Baseline and Full Stack conditions using `gemini-3.1-flash-lite-preview`. Three root causes identified from trace analysis of real Gemini runs on 2026-03-11 and 2026-03-12.

---

## Issue 1: Stuck Detector Too Aggressive

### Root Cause Analysis

The stuck detector in `scenario_runner.ts` (lines 196-214) counts consecutive identical opcodes. When the count reaches `stuckThreshold` (default: 6), it records a stuck event. After `maxStuckRetries` (default: 3) stuck events, the scenario is aborted.

The fundamental flaw is that **opcode identity is used as a proxy for spatial stagnation**, but these are not equivalent. In the corridor scenario:

- The robot starts at `y=20`, the target is at `y=280` (260cm away).
- The goal threshold is 20cm, so the robot needs to cover ~240cm.
- At speed 128, each `MOVE_FORWARD` frame covers **1.183cm** (computed from 28BYJ-48 kinematics: `(128/255) * 1024 * 0.5 / (4096 / (6 * PI))`).
- The robot needs **203 frames** of `MOVE_FORWARD` to reach the target.
- The stuck detector fires after **6 consecutive identical opcodes** (just 7.1cm of progress), accumulates 3 such events in **18 frames** total (21.3cm), and aborts.

Evidence from traces: Both Baseline and Full Stack corridor runs ended at frame 19 with reason `Stuck: 3 consecutive stuck detections (6 identical opcodes each)`. The robot moved only ~22cm of the 240cm needed. MOVE_FORWARD was objectively the correct action every frame.

The stuck detector also fires in Room Exploration (19-24 frames) and Doorway Navigation (19-23 frames), prematurely killing scenarios where the model does produce repeated-but-correct actions.

### Proposed Solution

Replace the opcode-identity-based stuck detection with a **spatial-progress-based** stuck detection. A robot is only stuck if it is repeating the same opcode AND not making spatial progress (position change below a threshold). Additionally, add a dedicated oscillation detector (see Issue 2).

**File:** `/Users/agustinazwiener/RoClaw/src/3_llmunix_memory/dream_simulator/scenario_runner.ts`

Replace lines 88-95 (constructor fields):

```typescript
// Before
private stuckThreshold: number;
private maxStuckRetries: number;

constructor(config: RunnerConfig) {
  // ...
  this.stuckThreshold = config.stuckThreshold ?? 6;
  this.maxStuckRetries = config.maxStuckRetries ?? 3;
  // ...
}
```

```typescript
// After
private stuckThreshold: number;
private maxStuckRetries: number;
private stuckProgressThresholdCm: number;

constructor(config: RunnerConfig) {
  // ...
  this.stuckThreshold = config.stuckThreshold ?? 8;        // raised from 6 -> 8
  this.maxStuckRetries = config.maxStuckRetries ?? 3;
  this.stuckProgressThresholdCm = config.stuckProgressThresholdCm ?? 2.0;
  // ...
}
```

Add the new config field to `RunnerConfig`:

```typescript
export interface RunnerConfig {
  // ... existing fields ...
  /** Minimum spatial progress (cm) over stuckThreshold frames to NOT be considered stuck */
  stuckProgressThresholdCm?: number;
}
```

Replace the stuck detection block (lines 196-214) with spatial-progress-aware logic:

```typescript
// Stuck detection — spatial progress aware
if (opcode === lastOpcode && opcode !== Opcode.STOP) {
  consecutiveIdentical++;
} else {
  consecutiveIdentical = 0;
}
lastOpcode = opcode;

if (consecutiveIdentical >= this.stuckThreshold) {
  // Check spatial progress: compare current position to position stuckThreshold frames ago
  const lookbackIndex = frameLog.length - this.stuckThreshold - 1;
  const prevPose = lookbackIndex >= 0 ? frameLog[lookbackIndex].pose : frameLog[0]?.pose;
  const currPose = currentFrame.pose;

  let spatialDelta = 0;
  if (prevPose) {
    const dx = currPose.x - prevPose.x;
    const dy = currPose.y - prevPose.y;
    spatialDelta = Math.sqrt(dx * dx + dy * dy);
  }

  if (spatialDelta < this.stuckProgressThresholdCm) {
    // Truly stuck: same opcode AND no spatial progress
    stuckCount++;
    consecutiveIdentical = 0;
    if (this.config.verbose) {
      console.log(`  [!] Stuck detected (${stuckCount}/${this.maxStuckRetries}) — ` +
        `${this.stuckThreshold} identical opcodes, only ${spatialDelta.toFixed(1)}cm progress`);
    }
    if (stuckCount >= this.maxStuckRetries) {
      abortReason = `Stuck: ${stuckCount} detections (${this.stuckThreshold} identical opcodes, <${this.stuckProgressThresholdCm}cm progress each)`;
      break;
    }
  } else {
    // Same opcode but making spatial progress — not stuck, just consistent
    consecutiveIdentical = 0;
    if (this.config.verbose && consecutiveIdentical === this.stuckThreshold) {
      console.log(`  [i] ${this.stuckThreshold} identical opcodes but ${spatialDelta.toFixed(1)}cm progress — not stuck`);
    }
  }
}
```

The same stuck detection logic should be mirrored in the A/B test runner in `__tests__/ab-tests/cognitive-stack-ab.test.ts` (lines 365-376) for consistency, since that test has its own inline version of the loop.

### Tradeoffs

1. **Risk of not detecting actual stuck states:** A robot pressing against a wall with MOVE_FORWARD will have near-zero spatial progress AND identical opcodes, so it will still be caught. The 2cm threshold is well above the numerical noise floor.
2. **Corridor scenario will now run 200+ frames:** This increases test duration proportionally (at ~1s/frame with real API calls, the corridor scenario would take ~200s instead of ~19s). For local mock tests this is instant.
3. **Threshold tuning:** The `stuckProgressThresholdCm` of 2.0cm may need tuning for different motor speeds. At speed 80, each frame covers 0.74cm, so 8 frames would cover 5.9cm -- well above the threshold.
4. **The stuck warning in `buildUserMessage` (line 358-363) should also be updated** to check spatial progress, not just opcode identity, to avoid giving the model a misleading "CHANGE STRATEGY" prompt when it is doing the right thing.

---

## Issue 2: Model Oscillates CW/CCW Rotations

### Root Cause Analysis

Trace evidence from the Full Stack obstacle-avoidance run (2026-03-12) shows a clear pattern:

```
Frame N:   TOOLCALL:{"name":"rotate_cw","args":{"degrees":90,"speed":100}}
Frame N+1: TOOLCALL:{"name":"rotate_ccw","args":{"degrees":90,"speed":100}}
Frame N+2: TOOLCALL:{"name":"rotate_ccw","args":{"degrees":90,"speed":100}}
...repeats for 200 frames
```

The obstacle avoidance scenario timed out at 200 frames with distance 189-201cm from target. The doorway navigation scenario shows a similar pattern: the model alternates between ROTATE_CCW 90 and occasional TURN_LEFT/TURN_RIGHT, spinning in place for 200 frames.

Two complementary problems:

**Problem A: The stuck detector cannot catch oscillation.** It only counts *consecutive identical* opcodes. When the model alternates CW/CCW, the counter resets every frame because `opcode !== lastOpcode`. The pattern `CW, CCW, CW, CCW...` produces `consecutiveIdentical = 0` every frame.

**Problem B: The user message stuck warning (line 358-363) only checks for 3 identical actions.** It does not detect the alternating pattern, so the model never receives a "CHANGE STRATEGY" signal.

**Problem C: The system prompt's anti-oscillation guidance is buried.** The TEXT_SCENE_SYSTEM_PROMPT (line 561-630) has `CRITICAL CONSTRAINTS` at the very bottom. Flash-lite, being a small/fast model, appears to weight the beginning and middle of the prompt more heavily. The anti-repetition rule ("NEVER repeat the same action 3 times in a row when PROGRESS shows stuck or receding") does not even address oscillation -- it addresses repetition.

### Proposed Solution

Three changes: (a) add oscillation detection to the scenario runner, (b) add an oscillation warning to the user message, and (c) add an explicit anti-oscillation rule to the system prompt.

#### Change A: Oscillation detection in the scenario runner

**File:** `/Users/agustinazwiener/RoClaw/src/3_llmunix_memory/dream_simulator/scenario_runner.ts`

Add oscillation tracking variables after the existing stuck detection variables (around line 129):

```typescript
let consecutiveIdentical = 0;
let lastOpcode = -1;
let oscillationCount = 0;       // NEW
let lastTwoOpcodes: number[] = []; // NEW: sliding window of [prev, prevprev]
```

Add oscillation detection after the stuck detection block (after line 214):

```typescript
// Oscillation detection — catches CW/CCW or FORWARD/BACKWARD alternation
if (frameLog.length >= 4) {
  const recent4 = frameLog.slice(-4);
  const opcodes4 = recent4.map(f => {
    // Map opcode names back to check for alternation patterns
    const opcodeMap: Record<string, number> = {
      'ROTATE_CW': 0x05, 'ROTATE_CCW': 0x06,
      'MOVE_FORWARD': 0x01, 'MOVE_BACKWARD': 0x02,
      'TURN_LEFT': 0x03, 'TURN_RIGHT': 0x04,
    };
    return opcodeMap[f.opcodeName] ?? -1;
  });

  // Check A-B-A-B pattern (4-frame oscillation)
  const isOscillating =
    opcodes4[0] === opcodes4[2] && opcodes4[1] === opcodes4[3] &&
    opcodes4[0] !== opcodes4[1] &&
    // Only flag rotation/movement oscillations, not unrelated opcode pairs
    this.isComplementaryPair(opcodes4[0], opcodes4[1]);

  if (isOscillating) {
    oscillationCount++;
    if (this.config.verbose) {
      console.log(`  [!] Oscillation detected (${oscillationCount}): ` +
        `${recent4[0].opcodeName} <-> ${recent4[1].opcodeName}`);
    }
    if (oscillationCount >= 3) {
      // After 3 oscillation detections (= at least 12 wasted frames),
      // signal to the model via the next user message
      // (handled in buildUserMessage below)
    }
    if (oscillationCount >= 8) {
      abortReason = `Oscillation: ${recent4[0].opcodeName}/${recent4[1].opcodeName} pattern repeated ${oscillationCount} times`;
      break;
    }
  } else {
    // Only reset if the last 4 frames don't form the pattern at all
    if (oscillationCount > 0 && frameLog.length >= 6) {
      const recent6 = frameLog.slice(-6);
      const anyOscillation = [0, 1, 2].some(i => {
        const slice = recent6.slice(i, i + 4);
        const ops = slice.map(f => {
          const opcodeMap: Record<string, number> = {
            'ROTATE_CW': 0x05, 'ROTATE_CCW': 0x06,
            'MOVE_FORWARD': 0x01, 'MOVE_BACKWARD': 0x02,
            'TURN_LEFT': 0x03, 'TURN_RIGHT': 0x04,
          };
          return opcodeMap[f.opcodeName] ?? -1;
        });
        return ops[0] === ops[2] && ops[1] === ops[3] && ops[0] !== ops[1];
      });
      if (!anyOscillation) oscillationCount = 0;
    }
  }
}
```

Add the helper method to the class:

```typescript
private isComplementaryPair(a: number, b: number): boolean {
  const pairs = new Set([
    `${0x05},${0x06}`, `${0x06},${0x05}`, // ROTATE_CW <-> ROTATE_CCW
    `${0x01},${0x02}`, `${0x02},${0x01}`, // FORWARD <-> BACKWARD
    `${0x03},${0x04}`, `${0x04},${0x03}`, // TURN_LEFT <-> TURN_RIGHT
  ]);
  return pairs.has(`${a},${b}`);
}
```

Store `oscillationCount` in `ScenarioResult` and `FrameLogEntry` for downstream trace analysis.

#### Change B: Oscillation warning in user message

**File:** `/Users/agustinazwiener/RoClaw/src/3_llmunix_memory/dream_simulator/scenario_runner.ts`

In `buildUserMessage()`, after the existing stuck warning (line 358-363), add oscillation detection:

```typescript
// Oscillation warning: alternating between two actions
if (recentFrames.length >= 4) {
  const last4 = recentFrames.slice(-4);
  const names = last4.map(f => f.opcodeName);
  if (names[0] === names[2] && names[1] === names[3] && names[0] !== names[1]) {
    parts.push(`  ** OSCILLATION WARNING: alternating "${names[0]}" and "${names[1]}". ` +
      `You are NOT making progress. Try move_forward or a DIFFERENT rotation angle. **`);
  }
}
```

#### Change C: Anti-oscillation rules in system prompt

**File:** `/Users/agustinazwiener/RoClaw/src/2_qwen_cerebellum/bytecode_compiler.ts`

Move the critical constraints section higher in the prompt (right after DECISION PROCESS, before the few-shot examples), and add explicit anti-oscillation rules. Replace the `CRITICAL CONSTRAINTS` section:

```typescript
// In TEXT_SCENE_SYSTEM_PROMPT, move constraints BEFORE few-shot examples and add:

CRITICAL RULES (read these FIRST):
1. NEVER alternate between rotate_cw and rotate_ccw. If you rotated CW last frame, do NOT rotate CCW this frame. Instead: move_forward, or rotate CW by a DIFFERENT angle.
2. NEVER repeat the same action 3+ times when PROGRESS shows "stuck" or "receding". Try a completely different action type.
3. NEVER call stop() unless target distance < 20cm.
4. NEVER move_forward when forward clearance < 15cm. Rotate instead.
5. When COLLISION WARNING appears, call move_backward first, then rotate.
6. If you see OSCILLATION WARNING, you MUST call move_forward (even at low speed like 60,60) to break the pattern.
```

The key change is:
- Moving constraints from the END of the prompt to BEFORE the few-shot examples
- Adding rule 1 (anti-oscillation) and rule 6 (forced forward on oscillation warning) which are new
- Using imperative, numbered format instead of bullet points (flash-lite responds better to numbered instructions)

### Tradeoffs

1. **False positive oscillation detection:** Legitimate navigation could produce A-B-A-B patterns (e.g., turn_left, move_forward, turn_left, move_forward). The `isComplementaryPair()` guard limits detection to genuinely opposing actions (CW/CCW, FWD/BWD, LEFT/RIGHT), reducing false positives.
2. **Prompt length increase:** Adding rules at the top of the prompt increases token count. However, flash-lite's attention is biased toward early tokens, so this is a net positive for compliance.
3. **Oscillation abort threshold (8 detections):** This allows 32+ wasted frames before aborting. This is deliberately generous to give the oscillation WARNING mechanism time to correct the model's behavior before hard-aborting.
4. **The `buildUserMessage` oscillation warning tells the model to "try move_forward":** This is a heuristic. In some rare situations, moving forward might collide with an obstacle. The prompt says "even at low speed like 60,60" to mitigate this.

---

## Issue 3: Flash-Lite Ignores Structured Numerical Data

### Root Cause Analysis

The A/B test report from 2026-03-12 shows the Wall Following scenario (Full Stack condition) generated **133 collisions** from repeated `MOVE_BACKWARD` commands. The trace data confirms:

```
TOOLCALL:{"name":"move_backward","args":{"speed_l":60,"speed_r":60}}  -- repeated 10+ times
TOOLCALL:{"name":"rotate_cw","args":{"degrees":90,"speed":80}}
TOOLCALL:{"name":"move_backward","args":{"speed_l":60,"speed_r":60}}  -- repeated 5+ times
```

The model was issuing MOVE_BACKWARD despite the SPATIAL ANALYSIS section clearly showing:
- `CLEARANCE forward: XXXcm clear` (open corridor ahead)
- `PROGRESS: receding` (moving away from target)
- `OPTIONS: FORWARD clear for XXXcm [TARGET is FORWARD]`

Why the model ignores this data:

1. **Prompt structure problem:** The TEXT_SCENE_SYSTEM_PROMPT is 70 lines (approximately 2000 tokens). Flash-lite has a limited "attention budget" -- it follows instructions from the beginning of the prompt more reliably than from the end. The SPATIAL ANALYSIS data appears in the *user message*, not the system prompt, and is buried after the qualitative SCENE PERCEPTION section.

2. **The COLLISION WARNING dominance:** When the robot is near a wall (the Full Stack constraint says "If collision warning, move backward at speed 60"), the qualitative COLLISION WARNING in SCENE PERCEPTION overrides the quantitative CLEARANCE data. Flash-lite latches onto the most salient text ("COLLISION WARNING") and responds with MOVE_BACKWARD, ignoring that forward clearance is large.

3. **Full Stack constraints are counterproductive for wall-following:** The injected constraint `"If collision warning, move backward at speed 60 before attempting rotation"` is too aggressive for the wall-following scenario. In a narrow corridor, the robot is *always* near a wall -- the collision warning fires every frame, and the constraint tells it to move backward every time.

4. **Two-pass format redundancy:** Both SCENE PERCEPTION and SPATIAL ANALYSIS describe the same information. Flash-lite appears to read SCENE PERCEPTION (the qualitative text) and form its decision before reaching SPATIAL ANALYSIS (the quantitative data).

### Proposed Solution

Three changes: (a) restructure the scene output to put decision-critical data first, (b) simplify the system prompt for flash-lite, and (c) add a collision context qualifier.

#### Change A: Restructure scene output -- decision data FIRST

**File:** `/Users/agustinazwiener/RoClaw/src/3_llmunix_memory/dream_simulator/text_scene.ts`

In the `describeScene()` method, reverse the order of the two passes so SPATIAL ANALYSIS comes first:

```typescript
private describeScene(
  currentRoom: Room | null,
  collision: boolean,
  targetDist: number | null,
): string {
  const parts: string[] = [];

  // =========== DECISION DATA (formerly PASS 2) ===========
  // Put quantitative data FIRST so flash-lite reads it before qualitative text
  parts.push('=== DECISION DATA ===');

  // Target status -- most critical info first
  if (this.targetId && targetDist !== null) {
    const target = this.world.objects.find(o => o.id === this.targetId);
    if (target) {
      const bearing = this.getBearing(target.position);
      const relAngle = this.normalizeDeg(bearing - this.state.heading + 180) - 180;

      let progressStatus: string;
      if (this.previousTargetDistance !== null) {
        const delta = targetDist - this.previousTargetDistance;
        if (delta < -0.5) progressStatus = `approaching delta=${delta.toFixed(1)}cm`;
        else if (delta > 0.5) progressStatus = `receding delta=+${delta.toFixed(1)}cm -- CHANGE ACTION`;
        else progressStatus = `stuck delta=${delta.toFixed(1)}cm -- CHANGE ACTION`;
      } else {
        progressStatus = 'initial';
      }

      parts.push(`TARGET: ${Math.round(targetDist)}cm away, ${Math.round(relAngle)}deg relative`);
      parts.push(`PROGRESS: ${progressStatus}`);
      this.previousTargetDistance = targetDist;
    }
  }

  // Clearance -- second most critical
  const clearance = this.getSixDirectionClearance();
  const fwd = clearance.forward;
  parts.push(`FORWARD: ${fwd.distanceCm}cm ${fwd.blockedBy ? `BLOCKED by ${fwd.blockedBy}` : 'CLEAR'}`);
  parts.push(`LEFT: ${clearance.left.distanceCm}cm | RIGHT: ${clearance.right.distanceCm}cm | BACK: ${clearance.backward.distanceCm}cm`);

  // Recommendation
  if (this.targetId && targetDist !== null) {
    const target = this.world.objects.find(o => o.id === this.targetId);
    if (target) {
      const bearing = this.getBearing(target.position);
      const relAngle = this.normalizeDeg(bearing - this.state.heading + 180) - 180;
      const absAngle = Math.abs(relAngle);

      let rec: string;
      if (targetDist < this.goalThresholdCm) rec = 'STOP -- target reached';
      else if (absAngle < 10 && !fwd.blockedBy) rec = 'MOVE FORWARD';
      else if (relAngle > 10) rec = 'ROTATE RIGHT to face target';
      else if (relAngle < -10) rec = 'ROTATE LEFT to face target';
      else rec = 'MOVE FORWARD';
      parts.push(`RECOMMENDED: ${rec}`);
    }
  }

  // Collision -- contextual, not dominant
  if (collision) {
    // Differentiate between side-wall proximity and frontal collision
    const fwdClear = clearance.forward.distanceCm;
    if (fwdClear < 15) {
      parts.push('COLLISION: Obstacle directly ahead. Rotate before moving forward.');
    } else {
      parts.push('WALL NEARBY: Side wall close but forward path is CLEAR. Continue forward.');
    }
  }

  parts.push('');

  // =========== SCENE CONTEXT (formerly PASS 1) ===========
  parts.push('=== SCENE CONTEXT ===');

  if (currentRoom) {
    parts.push(`Location: ${currentRoom.label}.`);
  }

  // Pose (less critical, at bottom)
  parts.push(
    `Pose: x=${this.state.x.toFixed(0)} y=${this.state.y.toFixed(0)} heading=${this.state.heading.toFixed(0)}deg`
  );

  return parts.join('\n');
}
```

Key changes:
- DECISION DATA section comes first with TARGET, PROGRESS, FORWARD clearance, and RECOMMENDED action
- Collision is contextualized: side-wall proximity (forward clear) says "Continue forward" instead of generic "COLLISION WARNING"
- Qualitative scene description moved to the end as SCENE CONTEXT
- Removed redundant visible-wall, visible-object, and visible-doorway prose (this information is already captured in CLEARANCE and TARGET)
- Total output is roughly halved in token count

#### Change B: Simplify system prompt for flash-lite

**File:** `/Users/agustinazwiener/RoClaw/src/2_qwen_cerebellum/bytecode_compiler.ts`

Replace `TEXT_SCENE_SYSTEM_PROMPT` with a shorter, more directive version:

```typescript
const TEXT_SCENE_SYSTEM_PROMPT = `You are a robot motor controller. You navigate by reading DECISION DATA and calling one tool function.

GOAL: {{GOAL}}

RULES (follow in order):
1. If TARGET distance < 20cm: call stop().
2. If OSCILLATION WARNING in the message: call move_forward(60, 60).
3. If RECOMMENDED says MOVE FORWARD and FORWARD is CLEAR: call move_forward(speed, speed). Use speed 180 if >100cm clear, 120 if 50-100cm, 80 if <50cm.
4. If RECOMMENDED says ROTATE RIGHT: call rotate_cw(45, 100).
5. If RECOMMENDED says ROTATE LEFT: call rotate_ccw(45, 100).
6. If FORWARD is BLOCKED: call rotate_cw(90, 100).
7. If COLLISION and FORWARD < 15cm: call move_backward(60, 60) then next frame rotate.
8. If WALL NEARBY but FORWARD is CLEAR: call move_forward(100, 100). Do NOT move backward.
9. NEVER alternate rotate_cw and rotate_ccw. Pick one direction and commit.

AVAILABLE TOOLS:
- move_forward(speed_l, speed_r) -- speed 0-255
- move_backward(speed_l, speed_r)
- rotate_cw(degrees, speed) -- degrees 0-180
- rotate_ccw(degrees, speed)
- stop() -- only when target < 20cm

Call exactly ONE tool function.`;
```

Key changes:
- Reduced from ~70 lines to ~25 lines (roughly 500 tokens vs 2000)
- Rules are numbered and ordered by priority -- flash-lite can scan top-down and execute the first matching rule
- Removed DECISION PROCESS section (the model doesn't need to think step-by-step; that's what the DECISION DATA pre-computes)
- Removed few-shot examples (they add tokens but flash-lite doesn't use them effectively)
- Added explicit "Do NOT move backward" instruction for WALL NEARBY context
- Anti-oscillation rule (9) is included inline

#### Change C: Collision context qualifier in text_scene.ts

This is already included in Change A above. The key insight is replacing:

```
COLLISION WARNING: Very close to a wall or obstacle. Risk of collision.
```

with context-aware variants:

```
COLLISION: Obstacle directly ahead. Rotate before moving forward.
```
or
```
WALL NEARBY: Side wall close but forward path is CLEAR. Continue forward.
```

This prevents flash-lite from treating every near-wall situation as a frontal collision requiring retreat.

### Tradeoffs

1. **Loss of qualitative scene information:** Removing the visible-wall, visible-object, and visible-doorway prose means the model has less environmental context. For flash-lite this is a net positive (less noise), but if the system later uses a more capable model (e.g., gemini-2.5-pro), the richer format might help. **Mitigation:** Keep the full `describeScene()` as a method variant (e.g., `describeSceneFull()`) and use the compact version only for text-scene simulation.

2. **Rule-based prompt replaces chain-of-thought:** The simplified prompt is essentially a lookup table, not a reasoning prompt. This works well for flash-lite but removes the model's ability to handle novel situations not covered by the numbered rules. **Mitigation:** Rule 6 (FORWARD BLOCKED -> rotate 90) is a reasonable catch-all. More capable models should use the original prompt.

3. **Collision context splitting requires forward clearance check:** The `describeScene()` method must check forward clearance to distinguish frontal vs. lateral collisions. This is already computed by `getSixDirectionClearance()` so there is no performance cost, but the logic adds a branch that must be tested.

4. **Prompt simplification may hurt Full Stack condition:** The Full Stack condition injects strategies and constraints at the end of the system prompt. With the shorter prompt, these injections will be a larger fraction of the total prompt, which could improve or worsen compliance depending on how flash-lite handles the balance. The strategies and constraints themselves should also be reviewed for the wall-following scenario (the "move backward on collision warning" strategy is actively harmful in corridors).

5. **Backward compatibility:** The `getTextSceneSystemPrompt()` method is called by both the real A/B test runner and the unit test suite. Changing the prompt may cause deterministic mock-inference tests to break because the mock parses scene text patterns that have changed. The A/B test's `makeNavigationDecision()` function parses patterns like `PROGRESS:\s*(approaching|receding|stuck|initial)` which must still appear in the new DECISION DATA format.

---

## Cross-Cutting Concerns

### Interaction Between Fixes

The three fixes are complementary and should be applied together:

1. **Issue 1 (stuck detector) + Issue 2 (oscillation):** If only the stuck detector is fixed, oscillation will cause scenarios to time out at maxFrames instead of being detected. Both must be implemented.

2. **Issue 3 (prompt/scene restructure) + Issue 2 (oscillation warning):** The oscillation warning in the user message relies on the model reading it. The restructured prompt must include a rule for handling OSCILLATION WARNING (rule 2 in the simplified prompt).

3. **Issue 1 (spatial progress) + Issue 3 (scene restructure):** The spatial progress check in the stuck detector uses `frameLog[i].pose`. The restructured scene does not change the TextFrame output format (pose is computed from kinematics, not from the scene text), so there is no interaction.

### Testing Strategy

1. **Unit tests:** The existing A/B test in `__tests__/ab-tests/cognitive-stack-ab.test.ts` uses mock inference and should be updated to verify:
   - Corridor scenario completes (no false stuck abort)
   - Oscillation pattern is detected and warned
   - Mock inference responds to OSCILLATION WARNING

2. **Integration tests:** Re-run `npm run ab:test` with real Gemini after applying all three fixes. Expected improvements:
   - Corridor: robot reaches target (203 frames at speed 128)
   - Obstacle avoidance: oscillation detected and broken by frame 12-16
   - Wall following: MOVE_BACKWARD collisions eliminated by contextual collision handling
   - Doorway navigation: oscillation warning steers model toward forward movement

3. **Regression risk:** The `describeScene()` change affects all scenarios. Any test that parses the scene text format (e.g., `SCENE PERCEPTION`, `SPATIAL ANALYSIS` section headers) will need updating. The mock inference in the A/B test parses `PROGRESS:`, `CLEARANCE forward:`, `TARGET VISIBLE:` patterns -- these must be preserved or the mock must be updated.

### Recommended Implementation Order

1. **Issue 1** (stuck detector) -- lowest risk, highest certainty of impact
2. **Issue 2** (oscillation detection) -- medium risk, depends on Issue 1 not masking the problem
3. **Issue 3** (prompt/scene restructure) -- highest risk due to broad format changes, but highest potential impact

Each fix should be validated independently before combining.
