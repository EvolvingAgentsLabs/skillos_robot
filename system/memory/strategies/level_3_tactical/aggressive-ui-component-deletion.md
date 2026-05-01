---
id: strat_3_aggressive-ui-component-deletion
version: 1
hierarchy_level: 3
title: Aggressive UI Component Deletion on Product Pivot
trigger_goals: ["delete screen components", "remove unused UI", "component cleanup", "UI dead code", "product pivot cleanup", "Svelte component deletion"]
preconditions: ["Product pivot has made multiple screen components obsolete", "Replacement component is built and type-checked", "Version control preserves deleted code history"]
confidence: 0.55
success_count: 1
failure_count: 0
source_traces: ["tr_termshell_component_deletion"]
deprecated: false
---

# Aggressive UI Component Deletion on Product Pivot

## Overview

When a product pivot obsoletes multiple UI components simultaneously (e.g., replacing 5 screens with 1 terminal), delete them all in a single coordinated pass rather than gradually deprecating. Gradual deprecation leaves dead imports, unused props, and zombie components that inflate bundle size and confuse developers.

## Steps

1. **List all components to delete**: Enumerate every .svelte/.tsx/.vue file that the new component replaces. Include supporting files (stores, utils, types used only by deleted components).
2. **Verify replacement is complete**: Confirm the new component (e.g., TerminalShell.svelte) covers all critical user flows previously handled by the deleted components. Non-critical flows (onboarding, settings) may be intentionally dropped.
3. **Remove imports first**: In the root component (App.svelte), remove all import statements for components being deleted. Remove routing/navigation logic that references them.
4. **Delete component files**: Remove the .svelte/.tsx/.vue files from the filesystem. Delete associated test files, story files, and snapshot files.
5. **Clean up shared dependencies**: Check for stores, utility functions, types, and CSS modules that were only used by deleted components. Delete those too.
6. **Run type checker**: Execute `svelte-check` / `tsc --noEmit` / equivalent. Expect 0 errors. Any error indicates a missed reference.
7. **Measure impact**: Document LOC reduction across all affected files. Track bundle size reduction if applicable.
8. **Verify no dangling references**: Grep the codebase for deleted component names, file paths, and route identifiers. Clean up any remaining references in docs, comments, or config.

## Negative Constraints

- Do not leave deleted component files "commented out" or "hidden" in the tree -- delete them completely
- Do not preserve compatibility shims for deleted components -- if the component is gone, its interface is gone
- Do not combine deletion with feature additions in the same commit -- pure deletion is easier to review and revert
- Do not skip the dangling reference grep (Step 8) -- this is where phantom errors hide (see Constraints 29-36 about reference cleanup)

## Notes

- The skillos_mini refactoring deleted HomeScreen.svelte, PhotoCapture.svelte, TradeFlowSheet.svelte, JobsList.svelte, and Onboarding.svelte in a single pass.
- svelte-check with 0 errors after deletion confirms no type-level regressions.
- This strategy pairs with strat_3_dead-code-removal (which handles backend code path removal) -- this strategy handles frontend component removal specifically.
- Product pivots are the strongest trigger for aggressive deletion because the old components represent the OLD product thesis, not the new one.
