---
id: strat_3_test-coverage-system-prompts
version: 1
hierarchy_level: 3
title: Add Comprehensive System Prompt Test Coverage to BytecodeCompiler
trigger_goals: ["test coverage", "system prompt", "getTextSceneSystemPrompt", "compiler tests", "prompt validation"]
preconditions: ["BytecodeCompiler has getSystemPrompt() tests but no getTextSceneSystemPrompt() tests", "TextSceneSimulator defines the two-pass scene format", "A/B tests rely on correct prompt generation"]
confidence: 0.5
success_count: 0
failure_count: 0
source_traces: ["dream_20260312_f4a9"]
deprecated: false
---

# Add Comprehensive System Prompt Test Coverage to BytecodeCompiler

## Problem
**Test Coverage Gap:**
- `__tests__/cerebellum/bytecode-compiler.test.ts` line 477: `describe('getSystemPrompt', ...)` with 2 test cases
  - Tests content includes the goal
  - Tests content includes opcode reference
- **Missing:** No tests for `getTextSceneSystemPrompt()` method
  - Method is called in cognitive-stack-ab.test.ts line 281 and scenario_runner.ts line 135
  - No assertions validate the prompt structure, placeholders, or examples
  - Format changes to the prompt silently break A/B tests without test suite notification

**Why this matters:**
1. **Regression masking:** If someone refactors TEXT_SCENE_SYSTEM_PROMPT and removes the "CURRENT FRAME" section, the test suite passes but A/B tests silently get worse prompts
2. **A/B test validity:** The two-pass scene format (SCENE PERCEPTION + SPATIAL ANALYSIS) is critical to mock inference behavior. No test validates that the prompt actually teaches this format to models.
3. **Version evolution:** Improvements to the prompt (e.g., adding few-shot examples) cannot be validated without tests

## Steps

1. **Add new test section** to `__tests__/cerebellum/bytecode-compiler.test.ts` (after line 487):

   ```typescript
   describe('getTextSceneSystemPrompt', () => {
     test('returns a non-empty string', () => {
       const prompt = compiler.getTextSceneSystemPrompt('navigate to target');
       expect(prompt).toBeTruthy();
       expect(typeof prompt).toBe('string');
       expect(prompt.length).toBeGreaterThan(200); // Ensure it's substantial
     });

     test('includes the goal parameter', () => {
       const goal = 'explore the room and find the doorway';
       const prompt = compiler.getTextSceneSystemPrompt(goal);
       expect(prompt).toContain(goal);
     });

     test('describes the two-pass scene format', () => {
       const prompt = compiler.getTextSceneSystemPrompt('navigate');
       // Should teach about SCENE PERCEPTION section
       expect(prompt).toMatch(/SCENE PERCEPTION|scene perception|perception/i);
       // Should teach about SPATIAL ANALYSIS section
       expect(prompt).toMatch(/SPATIAL ANALYSIS|spatial analysis|analysis/i);
     });

     test('includes PROGRESS status keywords', () => {
       const prompt = compiler.getTextSceneSystemPrompt('navigate');
       expect(prompt).toContain('approaching');
       expect(prompt).toContain('receding');
       expect(prompt).toContain('stuck');
     });

     test('includes structured field names (CLEARANCE, OPTIONS, etc.)', () => {
       const prompt = compiler.getTextSceneSystemPrompt('navigate');
       expect(prompt).toContain('CLEARANCE');
       expect(prompt).toContain('PROGRESS');
       expect(prompt).toContain('OPTIONS');
     });

     test('includes example outputs in TOOLCALL format', () => {
       const prompt = compiler.getTextSceneSystemPrompt('navigate');
       // Should show models how to format TOOLCALL responses
       expect(prompt).toContain('TOOLCALL');
       expect(prompt).toMatch(/move_forward|MOVE_FORWARD|rotate_cw|ROTATE_CW/i);
     });

     test('includes guidance on decision-making with structured fields', () => {
       const prompt = compiler.getTextSceneSystemPrompt('navigate');
       // Should emphasize that CLEARANCE, PROGRESS, OPTIONS are actionable
       expect(prompt).toMatch(/clearance|forward distance|obstacle|distance/i);
     });

     test('does NOT contain old hex bytecode instructions', () => {
       const prompt = compiler.getTextSceneSystemPrompt('navigate');
       // Should never mention "output hex" or "6-byte"
       // (those are for getSystemPrompt, not getTextSceneSystemPrompt)
       expect(prompt).not.toMatch(/output.*hex|6-byte|0xAA|hex.*string/i);
     });

     test('does NOT contain placeholder tokens after replacement', () => {
       const prompt = compiler.getTextSceneSystemPrompt('some goal');
       // Ensure {{GOAL}} was actually replaced
       expect(prompt).not.toContain('{{GOAL}}');
       expect(prompt).toContain('some goal');
     });

     test('consistency: multiple calls with same goal produce identical output', () => {
       const goal = 'navigate to the target';
       const prompt1 = compiler.getTextSceneSystemPrompt(goal);
       const prompt2 = compiler.getTextSceneSystemPrompt(goal);
       expect(prompt1).toBe(prompt2);
     });

     test('consistency: different goals preserve prompt structure, only goal changes', () => {
       const prompt1 = compiler.getTextSceneSystemPrompt('goal A');
       const prompt2 = compiler.getTextSceneSystemPrompt('goal B');
       // Remove the goal text to compare structure
       const struct1 = prompt1.replace(/goal A/g, 'GOAL_PLACEHOLDER');
       const struct2 = prompt2.replace(/goal B/g, 'GOAL_PLACEHOLDER');
       expect(struct1).toBe(struct2);
     });
   });
   ```

2. **Add prompt content helper** in BytecodeCompiler class (if helpful for assertions):
   ```typescript
   // For test diagnostics
   public getTextSceneSystemPromptStructure(): {
     hasScenePerceptionSection: boolean;
     hasSpatialAnalysisSection: boolean;
     hasClearanceField: boolean;
     hasProgressField: boolean;
     hasExamples: boolean;
   } {
     const prompt = this.getTextSceneSystemPrompt('dummy');
     return {
       hasScenePerceptionSection: /SCENE PERCEPTION/i.test(prompt),
       hasSpatialAnalysisSection: /SPATIAL ANALYSIS/i.test(prompt),
       hasClearanceField: /CLEARANCE/i.test(prompt),
       hasProgressField: /PROGRESS/i.test(prompt),
       hasExamples: /TOOLCALL/i.test(prompt),
     };
   }
   ```

3. **Integration with regression testing:**
   - These tests automatically validate that changes to TEXT_SCENE_SYSTEM_PROMPT don't break the expected structure
   - If prompt evolution adds new sections (e.g., RECOMMENDATIONS), new test cases capture the change
   - Enables safe prompt refactoring for model performance

4. **Documentation in prompt constant:**
   - Add JSDoc comment above TEXT_SCENE_SYSTEM_PROMPT explaining the two-pass format
   - Document expected usage: `compiler.getTextSceneSystemPrompt(goal)` for text-based navigation
   - Compare with `getSystemPrompt()` for hex-based navigation (documents when to use which)

## Negative Constraints
- Do not add tests that are too prescriptive about prompt wording (e.g., exact phrase matching)
- Do not test model behavior (e.g., "assert that models follow the prompt") — test the prompt structure only
- Do not create separate prompt tests for every compilation mode; focus on getTextSceneSystemPrompt specifically

## Notes
- This strategy unblocks prompt evolution: developers can safely improve the prompt's pedagogical value with test-validated assertions
- Pairs well with strat_3_mock-inference-structured-parsing: once scene parser validates format, the prompt test validates format teaching
- Expected test count: ~12 new assertions, all deterministic (no API calls)
- Estimated lines: +80 lines in test file (mostly test cases with clear setup/assertions)
