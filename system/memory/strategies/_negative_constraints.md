# Negative Constraints

## Constraint 1
- **Description:** Do not move forward into detected obstacles at full speed -- always reduce speed when obstacle distance is under 50cm
- **Context:** obstacle avoidance, navigation, proximity control
- **Severity:** high
- **Learned From:** cognitive-stack-ab.test.ts (Baseline vs Full Stack obstacle avoidance comparison), dream_20260311_a7b3
- **Dream ID:** dream_20260311_a7b3

## Constraint 2
- **Description:** Do not charge through doorways at speed exceeding 100 -- always center alignment and reduce speed to 60-80 before entering a doorway
- **Context:** doorway navigation, narrow passage traversal
- **Severity:** high
- **Learned From:** cognitive-stack-ab.test.ts (Doorway Navigation scenario, lines 168-171), dream_20260311_a7b3
- **Dream ID:** dream_20260311_a7b3

## Constraint 3
- **Description:** Do not rely on small rotation angles (under 45 degrees) to clear blocked paths -- use 90-degree systematic scan rotations when path is blocked
- **Context:** stuck recovery, blocked path handling, exploration
- **Severity:** medium
- **Learned From:** cognitive-stack-ab.test.ts (Baseline stuck detection in obstacle course, lines 262-270), dream_20260311_a7b3
- **Dream ID:** dream_20260311_a7b3

## Constraint 4
- **Description:** Do not treat dream-sourced strategies as equivalent to real-world strategies -- always apply fidelity weighting (DREAM_TEXT confidence = base * 0.3, REAL_WORLD = base * 1.0)
- **Context:** dream consolidation, strategy confidence initialization, memory fidelity
- **Severity:** medium
- **Learned From:** dream-engine.test.ts (fidelity weighting tests, lines 410-443), cognitive-stack-ab.test.ts (Memory Fidelity tests), dream_20260311_a7b3
- **Dream ID:** dream_20260311_a7b3

## Constraint 5
- **Description:** Do not skip source tagging on execution traces -- untagged traces default to UNKNOWN_SOURCE with fidelity 0.6, which may be higher than intended for synthetic data
- **Context:** trace logging, source provenance, dream engine input quality
- **Severity:** low
- **Learned From:** dream-engine.test.ts (legacy trace parsing, lines 469-506), dream_20260311_a7b3
- **Dream ID:** dream_20260311_a7b3

## Constraint 6
- **Description:** Do not delete backward-compatible wrapper classes during integration simplification -- if tests mock a class directly (e.g., CerebellumInference), the class must remain even when production routing changes
- **Context:** inference provider migration, test suite compatibility, mock-based testing
- **Severity:** high
- **Learned From:** GeminiCore integration (CerebellumInference preserved for test mocking), dream_20260311_a7f3
- **Dream ID:** dream_20260311_a7f3

## Constraint 7
- **Description:** Do not widen union types for inference modes beyond what is actively used -- dead type branches create untested code paths and confuse consumers
- **Context:** TypeScript type narrowing, DreamInferenceMode, inference routing
- **Severity:** medium
- **Learned From:** GeminiCore integration (DreamInferenceMode narrowed from 'claude'|'gemini'|'dual' to 'gemini'), dream_20260311_a7f3
- **Dream ID:** dream_20260311_a7f3

## Constraint 8
- **Description:** Do not introduce npm SDK dependencies for API integrations that have straightforward REST request/response shapes -- prefer native fetch with manual type assertions
- **Context:** Gemini Robotics inference adapter, npm dependency management, API integration
- **Severity:** medium
- **Learned From:** GeminiCore integration (gemini_robotics.ts uses native fetch, zero new dependencies), dream_20260311_a7f3
- **Dream ID:** dream_20260311_a7f3

## Constraint 9
- **Description:** Do not chain more than two re-export hops for shared types -- import directly from the canonical barrel export rather than intermediate re-exporters
- **Context:** TypeScript module organization, re-export chains, InferenceFunction type
- **Severity:** low
- **Learned From:** GeminiCore integration (InferenceFunction re-exported through 3+ hops), dream_20260311_a7f3
- **Dream ID:** dream_20260311_a7f3

## Constraint 10
- **Description:** Do not enable structured tool calling on an inference backend while using a text-completion-style system prompt -- the system prompt format MUST match the inference mode (tool calling requires function-call-style prompts, not hex bytecode prompts)
- **Context:** inference backend configuration, system prompt design, Gemini tool calling, VisionLoop, motor control
- **Severity:** high
- **Learned From:** tr_004_prompt_mismatch_failure (Gemini repeated TURN_LEFT regardless of input due to hex prompt + tool calling mode), tr_003_route_all_inference
- **Dream ID:** dream_20260311_b9e2

## Constraint 11
- **Description:** Do not assume a model is misbehaving when it produces the same output regardless of input variation -- first check for prompt/mode configuration mismatches before debugging model behavior
- **Context:** inference debugging, model output analysis, configuration validation
- **Severity:** medium
- **Learned From:** tr_004_prompt_mismatch_failure (45 minutes spent debugging what appeared to be model behavior but was a configuration mismatch)
- **Dream ID:** dream_20260311_b9e2

## Constraint 12
- **Description:** Do not detect stuck state based solely on opcode repetition; must include spatial progress validation before firing stuck detection
- **Context:** Stuck detection in navigation loops, especially corridor traversal with monotonic forward motion
- **Severity:** high
- **Learned From:** tr_ab_analysis_20260312 (Corridor scenario: MOVE_FORWARD progresses 1.5cm/frame but stuck detector fires after 6 identical opcodes, causing 3 false detections and premature abort at frame 19)
- **Dream ID:** dream_20260312_f4c7

## Constraint 13
- **Description:** Do not fire stuck detection after exactly 6 identical consecutive opcodes without checking if spatial position advanced between detections
- **Context:** Vision loop stuck detection using opcode counts
- **Severity:** high
- **Learned From:** tr_ab_analysis_20260312 (Each 6-opcode threshold triggers abort without querying robot position delta)
- **Dream ID:** dream_20260312_f4c7

## Constraint 14
- **Description:** Do not ignore oscillation patterns where opcodes alternate (e.g., ROTATE_CW / ROTATE_CCW pairs) causing zero net progress over extended periods
- **Context:** Stuck detection for alternating rotation sequences
- **Severity:** high
- **Learned From:** tr_ab_analysis_20260312 (Obstacle Avoidance + Doorway Navigation: model alternates ROTATE_CW 90° / ROTATE_CCW 90° for 200 frames, net heading change = 0°, entropy-based detector misses it because opcodes never repeat identically)
- **Dream ID:** dream_20260312_f4c7

## Constraint 15
- **Description:** Do not rely solely on entropy-based or opcode-count detection for stuck states; must track directional reversals (rotation sign changes) and net heading changes
- **Context:** Vision loop stuck detection for complex oscillation patterns
- **Severity:** high
- **Learned From:** tr_ab_analysis_20260312 (Oscillation pattern persists 200 frames because stuck detector counts opcode frequency, not directional accumulation)
- **Dream ID:** dream_20260312_f4c7

## Constraint 16
- **Description:** Do not interleave SCENE PERCEPTION (qualitative descriptive text) with CLEARANCE/PROGRESS/OPTIONS (quantitative numerical values) in the same markdown block
- **Context:** System prompt structure for Flash-Lite robot model; scene description formatting
- **Severity:** high
- **Learned From:** tr_ab_analysis_20260312 (Wall Following Full Stack: model treats numerical CLEARANCE/PROGRESS sections as noise when embedded in perception text, falls back to qualitative pattern matching, issues 133 MOVE_BACKWARD commands driving out of bounds)
- **Dream ID:** dream_20260312_f4c7

## Constraint 17
- **Description:** Do not expect Flash-Lite to prioritize numerical guidance (CLEARANCE values, distance metrics) when embedded within descriptive perception text
- **Context:** Scene format design for Gemini Flash-Lite robot navigation
- **Severity:** medium
- **Learned From:** tr_ab_analysis_20260312 (Flash-Lite model default behavior is qualitative pattern matching; numerical fields must be separated and emphasized structurally)
- **Dream ID:** dream_20260312_f4c7

## Constraint 18
- **Description:** Do not allow code duplication between A/B test scenario runner and production dream simulator -- extract shared runScenario() and makeNavigationDecision() logic to reusable service modules
- **Context:** Test regression, mock inference, A/B testing framework
- **Severity:** high
- **Learned From:** dream_20260312_f4a9 (cognitive-stack-ab.test.ts lines 87-252 and dream_simulator/scenario_runner.ts lines 113-244 contain identical runScenario implementation with 80% opcode-parsing and stuck-detection logic duplication; duplicated code obfuscates regression sources)
- **Dream ID:** dream_20260312_f4a9

## Constraint 19
- **Description:** Do not use regex-coupled mock inference that relies on brittle string pattern matching for scene parsing -- prefer structured decision logic based on parsed fields from a well-defined scene format
- **Context:** Mock inference pattern, scene format parsing, test determinism
- **Severity:** medium
- **Learned From:** dream_20260312_f4a9 (makeNavigationDecision in cognitive-stack-ab.test.ts lines 98-109 uses regex matches for PROGRESS, target distance, forward clearance; if regex doesn't match, falls back to legacy pattern matching on line 113, creating fragile decision logic)
- **Dream ID:** dream_20260312_f4a9

## Constraint 20
- **Description:** Do not leave getTextSceneSystemPrompt() untested in core compiler tests -- ensure system prompt generation methods have explicit test coverage with assertions on content structure and placeholders
- **Context:** BytecodeCompiler test coverage, system prompt validation
- **Severity:** medium
- **Learned From:** dream_20260312_f4a9 (bytecode-compiler.test.ts line 477 has tests for getSystemPrompt() but no dedicated tests for getTextSceneSystemPrompt(); test coverage gap masks prompt formatting issues)
- **Dream ID:** dream_20260312_f4a9

## Constraint 21
- **Description:** Do not use gemini-2.0-flash as default model for navigation tasks requiring numerical reasoning over structured guidance (CLEARANCE, PROGRESS, OPTIONS fields) -- flash-lite defaults to qualitative pattern matching and will ignore quantitative fields. For structured decision-making, use gemini-2.0-flash-exp or later model tiers that prioritize numerical fields
- **Context:** model selection, A/B testing, inference provider defaults, navigation system prompts
- **Severity:** high
- **Learned From:** tr_ab_analysis_20260312 (Real-world A/B test: gemini-2.0-flash Wall Following scenario produced 133 MOVE_BACKWARD commands, ignoring CLEARANCE/PROGRESS sections, driving robot out of bounds. Root cause: flash-lite model defaults to qualitative matching, treats numerical sections as noise when embedded in perception text)
- **Dream ID:** dream_20260312_7f4c
