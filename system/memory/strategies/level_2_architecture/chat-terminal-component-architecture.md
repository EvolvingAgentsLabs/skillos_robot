---
id: strat_2_chat-terminal-component-architecture
version: 1
hierarchy_level: 2
title: Chat-Terminal Single Component Architecture for Command-Driven Apps
trigger_goals: ["terminal component", "chat interface architecture", "single component app", "command prompt UI", "scrolling output", "replace screen routing"]
preconditions: ["Application interaction model is command-input -> streamed-output", "No need for independent parallel workflows (tabs, modals, split views)", "Backend execution runtime (cartridge, plugin, API) accepts natural language goals"]
confidence: 0.50
success_count: 1
failure_count: 0
source_traces: ["tr_termshell_arch_simplification", "tr_termshell_cartridge_integration"]
deprecated: false
---

# Chat-Terminal Single Component Architecture for Command-Driven Apps

## Overview

A chat-terminal architecture replaces multi-screen navigation with a single component containing three elements: (1) a command input with prompt indicator, (2) a scrolling output log showing command history and responses, (3) a command parser that extracts intent and routes to the execution backend. This architecture eliminates routing logic, screen state management, and tab navigation -- reducing the app shell to a single import.

The architectural insight: when the user's mental model is "type what I need, read the guidance," multi-screen navigation adds friction without value. The terminal model directly mirrors the user's intent-to-result flow.

## Steps

1. **Define component anatomy**: The terminal component has exactly three sections:
   - **Input**: Single text field with prompt indicator (e.g., ">"), submit on Enter
   - **Output**: Scrollable div showing chronological log of commands and responses, newest at bottom, auto-scroll on new content
   - **Parser**: Function that takes raw command string, extracts intent (task type) and payload (goal description), and returns a structured command object
2. **Implement visual design**: Dark background (#0a0a0a or similar), monospace font (JetBrains Mono, Fira Code, or system monospace), high-contrast text (green, white, or amber on dark), minimal padding, no decorative chrome
3. **Implement command parser**: Parse input as `[keyword] [freeform goal]`. First token identifies the task domain; remainder is the goal. Handle edge cases: empty input (show help), unknown keyword (show available commands), keyword-only (prompt for goal)
4. **Implement output rendering**: Each entry in the log has: timestamp (optional), command echo (prefixed with ">"), response lines (prefixed with "  " or styled differently). Support streaming output (append lines as they arrive from runtime)
5. **Wire to execution backend**: Pass parsed command to cartridge runtime / API / plugin system. Stream response lines to output log. Handle errors gracefully (display in output, do not crash)
6. **Replace root component**: App root imports only the terminal component. Remove all routing, navigation, and screen management code. Root component becomes 15-25 lines.
7. **Add command history**: Store previous commands in memory or localStorage. Allow up/down arrow navigation through history in the input field.

## Negative Constraints

- Do not add tabbed sub-views inside the terminal component -- this recreates the multi-screen problem inside a single component
- Do not parse commands with complex grammar (flags, nested arguments) -- keep the interface as [keyword] [natural language goal]
- Do not suppress error output -- display all errors in the terminal log so the user sees what happened
- Do not auto-focus the terminal on mobile without user interaction -- this triggers keyboard popup which can be disorienting

## Notes

- The TerminalShell.svelte implementation for skillos_mini proved that 20 lines in App.svelte is sufficient when the terminal component handles all interaction.
- For mobile (Capacitor/Cordova), consider adjusting the terminal height to account for virtual keyboard appearance.
- Command history stored in localStorage survives app restarts and provides implicit "recently used" functionality.
- The terminal aesthetic (dark mode, monospace) signals "tool for professionals" -- appropriate for trade-app users who value efficiency over visual design.
