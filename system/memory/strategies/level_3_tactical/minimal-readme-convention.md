---
id: strat_3_minimal-readme-convention
version: 1
hierarchy_level: 3
title: Minimal README Convention -- Terminal-First Quickstart Card
trigger_goals: ["README template", "documentation convention", "quickstart card", "project README", "developer onboarding", "ecosystem branding", "what+how format"]
preconditions: ["Project has a distinct CLI entry point (documented or implemented)", "Project has an ARCHITECTURE.md or equivalent for technical depth", "Project belongs to a multi-repo ecosystem (optional, but strengthens branding)"]
confidence: 0.65
success_count: 3
failure_count: 0
source_traces: ["dream_20260428_c4e7_ux_unification"]
deprecated: false
---

# Minimal README Convention -- Terminal-First Quickstart Card

## Rationale

A README is a quickstart card, not a reference manual. When a developer opens a repo, they need three things in under 60 seconds: what is this, how do I install it, how do I use it. Everything else (architecture, internals, roadmap) belongs in linked documents. This convention was validated across 3 repos (RoClaw, skillos_mini, llm_os) on 2026-04-28, producing READMEs of 72-78 lines each that provide complete quickstart coverage.

## Steps

1. **Title line** -- Use the CLI command name as the H1 heading, not the repo name. One word, lowercase. Examples: `# robot`, `# trade`, `# llmos`. This anchors the developer's mental model to what they will actually type in the terminal.

2. **Pitch paragraph** -- 1-2 sentences immediately below the title. Explain what the project does in plain language. No badges, no SVG banners, no Mermaid diagrams. Example: "Navigate a real or simulated robot with vision language models."

3. **Ecosystem link** -- One line connecting the project to its parent portfolio. Format: `Part of the [Ecosystem Name](URL) ecosystem.` This creates cross-repo discoverability without cluttering the README.

4. **Install section** -- 3-5 lines maximum. `git clone` + `cd` + one install command. Include prerequisites inline if they are non-obvious (e.g., "Prerequisites: Rust >= 1.75, llama.cpp"). Do not list optional dependencies here.

5. **Use section** -- 10-20 lines of annotated shell examples. Show the primary workflow first, then secondary commands. Use comments (`#`) for one-line descriptions of each command. Group related commands with blank lines. This is the heart of the README -- a developer should be able to copy-paste any example and get a result.

6. **How it works section** -- 5-10 lines of prose explaining the core mechanism. One paragraph, no diagrams. Use an ASCII comparison table if the concept maps cleanly to a well-known metaphor (e.g., POSIX vs LLM-OS). Mention the inference backends or execution modes.

7. **Architecture section** -- 3-5 lines of links only. Link to ARCHITECTURE.md (full technical depth), USAGE.md (operator guide), TUTORIAL.md (getting started tutorial), NEXT_STEPS.md (roadmap). Do not duplicate architecture content here. The README is the pitch; ARCHITECTURE.md is the map.

8. **License section** -- 1-2 lines. Just the license name, no preamble.

9. **Validate line count** -- The final README should be 60-80 lines. If it exceeds 80, move content to a linked document. If it is under 50, the Use section probably needs more examples.

## Template

```markdown
# <cli-name>

<One-sentence description of what this project does.>
<Optional second sentence about differentiation or approach.>

Part of the [Ecosystem Name](URL) ecosystem.

## Install

\`\`\`bash
git clone <repo-url>
cd <dir> && <install-command>
\`\`\`

## Use

\`\`\`bash
# Primary workflow
<cli-name> <primary-subcommand> "<example-goal>"

# Secondary commands
<cli-name> <subcommand-2> --flag "example"
<cli-name> <subcommand-3>
\`\`\`

## How it works

<1 paragraph explaining the core mechanism. No diagrams.>

## Architecture

Full stack, internals, and roadmap:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

Operator guide: [docs/USAGE.md](docs/USAGE.md)
Tutorial: [docs/TUTORIAL.md](docs/TUTORIAL.md)
Roadmap: [docs/NEXT_STEPS.md](docs/NEXT_STEPS.md)

## License

Apache 2.0
```

## Negative Constraints

- Do not add badges, shields, or SVG banners. They create visual noise and do not help a developer who opened the repo to understand what it does. (Constraint 44)
- Do not include Mermaid diagrams or architecture flowcharts. They belong in ARCHITECTURE.md. (Constraint 44)
- Do not exceed 80 lines. If the README is growing, content is leaking in from ARCHITECTURE.md. (Constraint 45)
- Do not list optional dependencies in the Install section. Only mandatory prerequisites go here.
- Do not duplicate the How it works section across README and ARCHITECTURE.md. The README gets a 1-paragraph summary; ARCHITECTURE.md gets the full treatment.

## Validation Evidence

| Repo | CLI name | Lines | Install lines | Use examples | Doc links |
|------|----------|-------|---------------|-------------|-----------|
| RoClaw | robot | 78 | 4 | 8 commands | 4 docs |
| skillos_mini | trade | 76 | 4 | 5 commands | 4 docs |
| llm_os | llmos | 72 | 5 | 8 commands | 4 docs |

All three READMEs were rewritten on 2026-04-28 and validated with per-repo compiler checks (tsc, svelte-check, cargo) and CLI entry point testing.

## Notes

- The "CLI name as H1" pattern creates a strong identity anchor. When a developer sees `# robot` instead of `# RoClaw`, they immediately know what to type in the terminal.
- The ecosystem link line is small but important for discoverability. A developer reading one project's README can click through to find sibling projects.
- The four-doc architecture link pattern (ARCHITECTURE.md, USAGE.md, TUTORIAL.md, NEXT_STEPS.md) provides complete coverage without cluttering the README. Not all docs need to exist on day one -- the links serve as slots that get filled as the project matures.
