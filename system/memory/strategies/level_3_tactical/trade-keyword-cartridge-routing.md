---
id: strat_3_trade-keyword-cartridge-routing
version: 1
hierarchy_level: 3
title: Trade-Keyword Cartridge Routing via Terminal Command Parsing
trigger_goals: ["cartridge routing", "trade command parsing", "electricista plomero pintor", "keyword cartridge mapping", "terminal command dispatch", "natural language routing"]
preconditions: ["Terminal/chat interface with text command input", "Multiple cartridges registered for different trade domains", "Cartridge runtime accepts natural language goal strings"]
confidence: 0.50
success_count: 1
failure_count: 0
source_traces: ["tr_termshell_cartridge_integration"]
deprecated: false
---

# Trade-Keyword Cartridge Routing via Terminal Command Parsing

## Overview

Parse terminal commands as `[trade_keyword] [goal_description]` to route to the appropriate cartridge runtime. The first token identifies the trade domain (electricista -> electrical cartridge, plomero -> plumbing cartridge, pintor -> painting cartridge). The remaining text is passed as a natural language goal to the cartridge. This creates a zero-friction interface between user intent and cartridge execution.

## Steps

1. **Define keyword-to-cartridge mapping**: Create a lookup table mapping trade keywords to cartridge IDs:
   - "electricista" -> electrical cartridge
   - "plomero" -> plumbing cartridge
   - "pintor" -> painting cartridge
   - Additional mappings as cartridges are added
2. **Parse command string**: Split on first whitespace. Token[0] = keyword (lowercase, trimmed). Token[1..] = goal (joined, trimmed).
3. **Look up cartridge**: Match keyword against the mapping. If no match, display available commands (help text).
4. **Handle edge cases**:
   - Empty input: display help text showing available trade keywords and example commands
   - Keyword only (no goal): prompt user for goal description
   - Unknown keyword: suggest closest match or list available keywords
   - "help" / "ayuda": display full command reference
5. **Invoke cartridge runtime**: Pass cartridge ID and goal string to the runtime. Stream output to terminal log.
6. **Format output**: Prefix cartridge output lines with the trade emoji or identifier for visual distinction. Show execution status (running, complete, error).
7. **Support aliases**: Allow common misspellings or abbreviations (e.g., "elec" -> "electricista", "plom" -> "plomero").

## Negative Constraints

- Do not require users to remember exact cartridge IDs or technical identifiers -- use natural trade keywords in the user's language
- Do not add subcommand syntax (flags, options) -- keep the interface as simple as [keyword] [what you want to do]
- Do not silently fail on unknown keywords -- always provide feedback about what went wrong and what commands are available
- Do not hardcode the mapping -- use a registry or config that can be extended as new cartridges are added

## Notes

- The Spanish trade keywords (electricista, plomero, pintor) are deliberate: the target users are Spanish-speaking tradespeople in Latin America. The interface language should match the user's language, not the developer's.
- This pattern generalizes: any domain-specific cartridge system (cooking, construction, automotive) can use the same [domain_keyword] [goal] parsing pattern.
- Consider adding a "historial" command to show previous command history and results.
- The keyword extraction is intentionally simple (first token) because natural language goals are free-form and should not be constrained by complex parsing.
