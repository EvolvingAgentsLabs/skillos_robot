---
id: strat_3_strategy-persistence-pattern
version: 1
hierarchy_level: 3
title: Strategy Store Persistence and Cross-Session Retrieval
trigger_goals: ["strategy persistence", "save strategy", "load strategy", "cross-session", "strategy store"]
preconditions: ["StrategyStore directory structure exists (level_1_goals/, level_2_routes or level_2_strategy/, level_3_tactical/, level_4_motor or level_4_reactive/, _seeds/)", "Writable filesystem"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["cognitive-stack-ab.test.ts:597-681", "strategy-store.test.ts (core + RoClaw)", "dream_20260311_a7b3"]
deprecated: false
---

# Strategy Store Persistence and Cross-Session Retrieval

## Steps
1. Create StrategyStore instance with a strategies directory path (supports both string path and LevelDirectoryConfig object)
2. Save strategies using store.saveStrategy(strategy) -- each strategy is serialized to a markdown file with YAML frontmatter in the appropriate level directory
3. Save negative constraints using store.saveNegativeConstraint(constraint) -- appended to _negative_constraints.md
4. Destroy the store instance (simulating session end / process restart)
5. Create a new StrategyStore instance with the same directory path
6. Retrieve strategies using store.findStrategies(goal, level) for keyword-based lookup or store.getStrategiesForLevel(level) for full-level scan
7. Verify: all saved strategies, constraints, and journal entries survive the session boundary

## Negative Constraints
- Do not assume strategy files use a fixed directory naming scheme -- Core uses level_2_strategy/level_4_reactive, RoClaw overrides to level_2_routes/level_4_motor
- Do not modify files in _seeds/ directory -- seed strategies are read-only bootstrap knowledge
- Do not create strategies with duplicate IDs -- always check findStrategyById() before creating

## Notes
- StrategyStore supports composite keyword scoring for strategy retrieval (not just exact match)
- Deprecated strategies (deprecated: true in frontmatter) are automatically filtered from query results
- Seed strategies are included in level queries but stored separately in _seeds/
- The reinforceStrategy() method increments success_count and increases confidence by 0.05 (capped at 0.95)
- The decayUnusedStrategies() method reduces confidence of strategies that have not been recently reinforced
