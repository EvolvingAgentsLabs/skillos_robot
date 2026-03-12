---
id: strat_3_prompt-mode-alignment
version: 1
hierarchy_level: 3
title: Prompt-Mode Alignment -- Match System Prompt to Inference Configuration
trigger_goals: ["prompt mismatch", "tool calling", "system prompt", "inference mode", "prompt alignment", "debug inference"]
preconditions: ["Inference backend supports multiple output modes (text completion vs tool calling)", "System prompt is configurable per inference mode", "Observable symptom: model produces same output regardless of input"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["tr_003_route_all_inference", "tr_004_prompt_mismatch_failure"]
deprecated: false
---

# Prompt-Mode Alignment -- Match System Prompt to Inference Configuration

## Steps
1. When integrating a new inference mode (e.g., enabling useToolCalling: true), identify ALL places where the system prompt is constructed
2. Create a dedicated system prompt for each inference mode: text-completion prompts describe output as raw text/hex, tool-calling prompts describe output as function calls with named parameters
3. Add a mode selector at the prompt construction site (e.g., useToolCallingPrompt config flag on VisionLoop) that selects the correct prompt variant
4. Validate that the selected prompt matches the backend configuration BEFORE the first inference call -- if useToolCalling is true, the prompt must NOT mention hex bytecodes or raw text output
5. Test with input variation: provide 3+ distinct inputs and verify the model produces distinct outputs. If all outputs are identical, suspect a prompt/mode mismatch

## Negative Constraints
- Do not reuse a text-completion system prompt when tool calling is enabled -- the model will ignore the structured output format and produce degenerate responses
- Do not debug model behavior before verifying configuration -- repeated identical outputs almost always indicate a config mismatch, not a model limitation
- Do not assume a model that works in text-completion mode will automatically work in tool-calling mode with the same prompt

## Notes
- This pattern was discovered when Gemini Robotics was configured with useToolCalling: true but received the hex bytecode system prompt ("output a 6-byte hex string"). The model repeated TURN_LEFT on every frame regardless of camera input.
- The fix was straightforward: create a dedicated tool-calling system prompt that describes navigation using function names (MOVE_FORWARD, TURN_LEFT, etc.) and wire it via the useToolCallingPrompt flag.
- Debugging took 45 minutes because the initial assumption was that the model was misbehaving, when the root cause was configuration.
- Time-saving heuristic: if a model produces the same output for 3+ varied inputs, check prompt/mode alignment before investigating model behavior.
