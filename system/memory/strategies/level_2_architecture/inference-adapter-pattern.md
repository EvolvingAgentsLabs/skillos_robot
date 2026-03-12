---
id: strat_2_inference-adapter-pattern
version: 1
hierarchy_level: 2
title: InferenceFunction Adapter Pattern for Drop-in Provider Replacement
trigger_goals: ["inference adapter", "provider abstraction", "drop-in replacement", "backward compatibility", "InferenceFunction"]
preconditions: ["TypeScript codebase with interface-based abstraction", "Multiple inference consumers (vision loop, dream engine, dream simulator)", "Need to support provider switching without consumer changes"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["dream_20260311_a7f3_geminicore_integration"]
deprecated: false
---

# InferenceFunction Adapter Pattern for Drop-in Provider Replacement

## Steps
1. Define a single canonical InferenceFunction type in the core module: `(systemPrompt: string, userMessage: string, images?: string[]) => Promise<string>`
2. Each inference backend (CerebellumInference, GeminiRoboticsInference) implements a `createInferenceFunction()` method that returns this signature
3. Consumers (vision loop, dream engine, dream simulator) accept InferenceFunction as a constructor parameter -- they never import a specific backend
4. Factory functions (createCerebellumInference, createGeminiInference, createDreamInference) handle backend-specific configuration and return the generic InferenceFunction
5. Config differences between use cases (motor control: maxTokens=64, temp=0.1 vs dream analysis: maxTokens=2048, temp=0.3, thinkingBudget=1024) are encapsulated in the factory, not the consumer
6. Re-export the canonical type through the barrel export (llmunix-core/index.ts) -- consumers import from there

## Negative Constraints
- Do not let consumers import backend-specific classes -- they should only see InferenceFunction
- Do not put use-case-specific config (thinkingBudget, maxTokens) in the consumer -- encapsulate in factory functions
- Do not create separate InferenceFunction types per backend -- there is one canonical definition in llmunix-core/interfaces.ts

## Notes
- This pattern enabled the GeminiCore migration: production routing was changed from CerebellumInference to GeminiRoboticsInference without touching any consumer code.
- The GeminiRoboticsInference class explicitly documents "Same signature as CerebellumInference -- drop-in replacement" (gemini_robotics.ts line 180).
- Different use cases configure the same backend differently through factory functions: createDreamInference() sets thinkingBudget=1024 and maxTokens=2048 for deep analysis, while the dream simulator's DreamInferenceRouter sets thinkingBudget=0 and maxTokens=128 for fast motor control.
- The InferenceStats type is shared between backends via import (GeminiRoboticsInference imports InferenceStats from inference.ts), demonstrating that even internal types can be shared without coupling.
