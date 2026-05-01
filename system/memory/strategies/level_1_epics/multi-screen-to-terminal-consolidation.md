---
id: strat_1_multi-screen-to-terminal-consolidation
version: 1
hierarchy_level: 1
title: Multi-Screen to Terminal UI Consolidation on Product Pivot
trigger_goals: ["UI simplification", "terminal interface", "replace multi-screen", "chat interface", "command-driven app", "product pivot UI", "Svelte consolidation", "trade-app interface"]
preconditions: ["Product pivot has narrowed interaction model to single command-driven pattern", "Existing multi-screen app has 3+ screen components with independent state", "Core user interaction is natural language task description, not form-filling", "Cartridge or plugin runtime exists for backend task execution"]
confidence: 0.50
success_count: 1
failure_count: 0
source_traces: ["tr_termshell_epic_refactor", "tr_termshell_arch_simplification", "tr_termshell_component_deletion", "tr_termshell_cartridge_integration"]
deprecated: false
---

# Multi-Screen to Terminal UI Consolidation on Product Pivot

## Overview

When a product pivot narrows the user interaction model from multi-workflow navigation (browse, capture, fill forms, view lists) to a single command-driven pattern (type a task, get step-by-step output), the entire multi-screen architecture becomes dead weight. This strategy formalizes the consolidation: delete all screen components, replace with a single terminal/chat component, and wire the command input directly to the task execution runtime.

The key insight is that multi-screen architectures serve users who need to navigate between independent workflows. When the product thesis simplifies to "describe your task, get guidance," the navigation overhead actively harms UX by adding clicks between the user and the core value.

## Steps

1. **Validate pivot thesis**: Confirm the product interaction has narrowed to a single pattern (command/task input -> streamed output). If multiple independent workflows remain necessary, do not consolidate.
2. **Inventory existing components**: List all screen components, their state management, routing logic, and dependencies. Quantify LOC and complexity.
3. **Design terminal component**: Define the single replacement component with: (a) command input area (text field with prompt indicator), (b) scrolling output log (command history + responses), (c) command parser (extract task type + goal from natural language).
4. **Create terminal component**: Build TerminalShell (or equivalent) with dark terminal aesthetic, monospace font, and minimal chrome. Include command history navigation.
5. **Wire command parser to runtime**: Parse commands as [task_keyword] [goal_description] and route to the appropriate cartridge/plugin runtime. Stream output to the terminal log.
6. **Simplify root component**: Reduce App.svelte (or equivalent) to a single import and render of the terminal component. Remove all routing, tab navigation, and screen state management.
7. **Delete old components**: Remove all replaced screen components (HomeScreen, PhotoCapture, TradeFlowSheet, JobsList, Onboarding, etc.) in a single deletion pass.
8. **Validate**: Run type checker (svelte-check, tsc) to confirm 0 errors. Verify no dangling imports or references to deleted components.
9. **Measure reduction**: Document LOC reduction (e.g., App.svelte 191 -> 20 lines = 89% reduction) as evidence of simplification.

## Negative Constraints

- Do not partially consolidate (keeping some screens alongside the terminal) -- this creates UX confusion about which interaction model is primary
- Do not preserve deleted component code "in case we need it later" -- version control serves this purpose; dead components in the tree create maintenance burden
- Do not add the terminal as a new tab alongside existing screens -- if the terminal replaces the interaction model, commit fully to the replacement
- Do not skip the type-check validation step -- deleting multiple components can leave orphaned type references that compile but fail at runtime

## Notes

- The skillos_mini refactoring reduced App.svelte from 191 lines (5+ screen imports, tab state, conditional rendering) to 20 lines (single TerminalShell import).
- The terminal metaphor is particularly effective for trade-app users (electricista/plomero/pintor) who think in terms of tasks ("instalar tomacorriente") rather than navigation flows.
- This pattern generalizes beyond Svelte: any framework where a product pivot narrows the UX to command-driven interaction benefits from consolidating to a single terminal/chat component.
- Consider adding command autocompletion for known trade keywords and common goals as a fast-follow enhancement.
