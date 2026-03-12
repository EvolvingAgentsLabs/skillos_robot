---
id: strat_3_mock-inference-structured-parsing
version: 2
hierarchy_level: 3
title: Improve Mock Inference Robustness with Structured Scene Parsing
trigger_goals: ["mock inference", "scene parsing", "structured format", "test reliability", "regex-coupled"]
preconditions: ["TextSceneSimulator provides consistent two-pass scene format", "BytecodeCompiler defines scene structure", "makeNavigationDecision() uses regex matching for parsing"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["cognitive-stack-ab.test.ts", "dream_20260312_f4a9"]
deprecated: false
---

# Improve Mock Inference Robustness with Structured Scene Parsing

## Problem (Version 1 → Version 2)
The makeNavigationDecision() function in cognitive-stack-ab.test.ts relies on brittle regex patterns to extract scene information:

```typescript
// Lines 98-109: Regex-coupled parsing
const progressMatch = sceneText.match(/PROGRESS:\s*(approaching|receding|stuck|initial)/);
const targetInfoMatch = sceneText.match(/target=(\d+)cm at (-?\d+)deg relative/);
const fwdClearMatch = sceneText.match(/forward:\s*(\d+)cm\s*(clear|BLOCKED)/);
```

**Risks:**
1. If TextSceneSimulator changes PROGRESS format or uses different keywords, all three regex patterns break simultaneously
2. Fallback logic on line 112-115 reintroduces ambiguity and behavioral divergence from production
3. Missing fields (null matches) silently cascade to legacy parsing, masking format evolution
4. No type safety or validation that parsed values are reasonable (e.g., distance < 500cm)

**Version 1 iteration:** Current strat_3_mock-inference-pattern (confidence 0.5) only documents the existing regex-based approach.

**Version 2 improvement:** Extract structured parsing into a dedicated scene parser with schema validation.

## Steps

1. **Create scene parser interface** `src/3_llmunix_memory/dream_simulator/scene_parser.ts`:
   ```typescript
   export interface ParsedScene {
     progressStatus: 'approaching' | 'receding' | 'stuck' | 'initial' | null;
     targetDistance: number | null;
     targetBearing: number | null;
     forwardClearance: number | null;
     forwardBlocked: boolean;
     // Validation flag: true if all critical fields parsed successfully
     isComplete: boolean;
   }

   export class TextSceneParser {
     parse(sceneText: string): ParsedScene {
       // Structured extraction with null-coalescing defaults
       // Returns ParsedScene with isComplete=true only if all fields found
     }

     // Diagnostic: helps test writers understand when format changes break parsing
     getParsingIssues(sceneText: string): string[] {
       // Returns list of missing or malformed fields
     }
   }
   ```

2. **Update makeNavigationDecision()** to use the parser:
   ```typescript
   function makeNavigationDecision(
     sceneText: string,
     constraints: string[],
     strategies?: string[],
   ): string {
     const scene = parser.parse(sceneText);

     // Fail fast if scene parsing is incomplete
     if (!scene.isComplete) {
       console.warn('Scene parsing incomplete:', parser.getParsingIssues(sceneText));
       return 'TOOLCALL:{"name":"stop","args":{}}'; // Safe fallback
     }

     const hasConstraint = (keyword: string) => constraints.some(c => c.toLowerCase().includes(keyword));
     const hasStrategy = (keyword: string) => strategies?.some(s => s.toLowerCase().includes(keyword)) ?? false;

     // Now all scene.* fields are guaranteed non-null
     if (scene.targetDistance < 20) return 'TOOLCALL:{"name":"stop","args":{}}';
     // ... rest of decision logic
   }
   ```

3. **Add comprehensive parser tests** in new `__tests__/llmunix-core/scene_parser.test.ts`:
   - Test case: Valid complete scene with all fields → isComplete=true
   - Test case: Missing PROGRESS section → isComplete=false, getParsingIssues lists "missing PROGRESS status"
   - Test case: Malformed target distance (not a number) → isComplete=false
   - Test case: Target distance out of reasonable range (>5000cm) → warning logged
   - Test case: Each of 7 scene variants from TextSceneSimulator → all parse correctly

4. **Update TextSceneSimulator** to document scene format invariants:
   - Add JSDoc comment listing exact PROGRESS keywords and format
   - Add JSDoc for CLEARANCE format with expected units (cm, not mm)
   - Add JSDoc for OPTIONS/RECOMMENDATIONS structure
   - This becomes the spec that both TextSceneSimulator and scene_parser validate against

5. **Defensive programming in scene_parser**:
   - Use optional chaining and null coalescing: `const dist = match?.[1] ? parseInt(...) : null`
   - Validate parsed numbers are within reasonable ranges: `0 <= distance <= 5000`
   - Log warnings if any parsed field is outside expected range
   - Maintain backward compatibility: if new format field is missing, parser gracefully uses null

6. **Integration with shared-scenario-runner**:
   - Both A/B test and dream simulator use same parser
   - Eliminates divergence in scene interpretation
   - Makes it safe to change TextSceneSimulator format (parser catches incompatibility immediately)

## Negative Constraints
- Do not allow silent fallback to legacy parsing -- if parser returns isComplete=false, a test should fail or log a warning
- Do not hardcode expected ranges (e.g., max 500cm) in the parser; parameterize them
- Do not duplicate scene parsing logic across mock inference implementations

## Notes
- **Version 1 → Version 2 improvement:**
  - v1 (confidence 0.5): Documents current regex-based approach, acknowledges it's pattern-matched
  - v2 (confidence 0.7): Adds structured parsing with validation, enables safe format evolution
  - Migration: Update cognitive-stack-ab.test.ts to use parser, add tests covering parser edge cases
  - Expected success_count after migration: 2 (A/B tests + dream simulator both validated)

- **Enables safe format changes:** If TextSceneSimulator's PROGRESS format evolves, the parser test will immediately fail with a clear message ("PROGRESS keyword not recognized: 'status'"), enabling rapid diagnosis

- **Reduces regression vectors:** No longer need three separate regex patterns; one parser validates the entire scene

- **Estimated lines:**
  - scene_parser.ts: ~120 lines
  - scene_parser.test.ts: ~180 lines
  - makeNavigationDecision() updates: ~20 lines
  - Total: +320 lines added, ~100 lines regex code simplified
