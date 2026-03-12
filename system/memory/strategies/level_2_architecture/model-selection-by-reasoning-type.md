---
id: strat_2_model-selection-by-reasoning-type
version: 1
hierarchy_level: 2
title: Model Selection by Reasoning Type -- Flash-Lite vs Flash+ for Navigation
trigger_goals: ["model selection", "inference provider", "gemini-2.0-flash", "flash-lite", "qualitative reasoning", "numerical reasoning", "structured decision-making"]
preconditions: ["Multiple model tiers available in Gemini family (flash-lite, flash, flash-exp)", "Navigation system prompt uses mixed qualitative and quantitative guidance", "Real-world A/B testing infrastructure to validate behavior differences"]
confidence: 0.50
success_count: 1
failure_count: 1
source_traces: ["tr_ab_analysis_20260312"]
deprecated: false
---

# Model Selection by Reasoning Type — Flash-Lite vs Flash+ for Navigation

## Overview
Gemini models exhibit tier-based reasoning specialization. Flash-lite (gemini-2.0-flash) excels at qualitative pattern matching but deprioritizes numerical fields when mixed with descriptive text. Flash+ tiers (gemini-2.0-flash-exp, future flash-next) show stronger structured data reasoning. This strategy guides model selection based on the reasoning type required by the navigation task.

## Steps
1. Analyze the navigation task's decision-making requirements: Is it primarily qualitative (pattern-matching on scene descriptions) or quantitative (numerical comparisons on distance, clearance, progress metrics)?
2. If the system prompt includes CLEARANCE, PROGRESS, OPTIONS sections with numerical guidance, mark as "structured reasoning required"
3. For structured reasoning (quantitative): use gemini-2.0-flash-exp or later model tier, NOT flash-lite
4. For pure pattern-matching (qualitative): flash-lite (gemini-2.0-flash) is acceptable and lower-cost
5. When mixing both styles in a single prompt, separate them into distinct sections with explicit routing instructions (e.g., "For quantitative decisions use PROGRESS field; for qualitative fallback use SCENE PERCEPTION")
6. Run A/B tests comparing model tiers on the same task before selecting default model in production
7. Document the decision rationale in the boot configuration (index.ts GEMINI_MODEL comment)

## Negative Constraints
- Do not assume all Gemini tiers reason equally on numerical vs qualitative data -- they have measurable differences in structured reasoning priority
- Do not embed CLEARANCE/PROGRESS numerical sections inside descriptive perception text -- models will treat them as noise
- Do not use flash-lite as the universal default for all navigation tasks -- it will fail on structured decision-making tasks
- Do not mix prompting styles without explicit routing -- models will optimize for whichever style appears first/most
- Do not skip A/B testing when changing model tiers -- qualitative behavior differences are real and task-dependent

## Notes
- Evidence: Real-world A/B test (tr_ab_analysis_20260312) showed gemini-2.0-flash (flash-lite) producing 133 MOVE_BACKWARD commands in Wall Following scenario while ignoring CLEARANCE/PROGRESS sections. Model was pattern-matching on "wall on left" from SCENE PERCEPTION and executing learned behavior (move backward when wall detected), rather than following numerical guidance.
- Flash-lite failure modes: (1) Ignores numerical fields in mixed prompts, (2) Oscillates between learned patterns rather than reasoning numerically, (3) Executes 6-frame repetitions without checking spatial progress
- Flash+ expected improvements: Better numerical field extraction, more robust parsing of separated structured sections, explicit numerical reasoning over learned patterns
- Cost implication: Flash-lite is cheaper (lower token cost); use for pure pattern-matching tasks. Flash+ is higher cost; justify with A/B test evidence showing necessity for structured reasoning
- Model tier list (as of 2026-03): gemini-2.0-flash (lite) → gemini-2.0-flash-exp (enhanced) → future flash-next (planned)
