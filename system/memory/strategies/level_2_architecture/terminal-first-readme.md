---
id: strat_2_terminal-first-readme
version: 1
hierarchy_level: 2
title: Terminal-First README Pattern
trigger_goals: ["README", "simplification", "terminal-first", "documentation", "quickstart", "what-how", "CLI card", "README rewrite"]
preconditions: ["Project has a working CLI or command-line interface", "An ARCHITECTURE.md exists (or will be created) to receive technical detail", "The project's core value proposition can be stated in 1-2 sentences"]
confidence: 0.75
success_count: 3
failure_count: 0
source_traces: ["2026-04-28_readme_simplification_roclaw", "2026-04-28_readme_simplification_skillos_mini", "2026-04-28_readme_simplification_llm_os"]
deprecated: false
---

# Terminal-First README Pattern

## Overview

A README structure that treats the file as a CLI quickstart card, not a landing page or architecture reference. The README answers exactly two questions: what is this, and how do I use it right now. All technical depth, diagrams, and architecture rationale live in companion docs (ARCHITECTURE.md, USAGE.md, TUTORIAL.md).

The guiding principle: the README is the pitch; ARCHITECTURE.md is the map.

## Steps

1. **Choose a lowercase noun title.** Use a single word that describes what the project IS, not the repository name. Examples: `robot` (not RoClaw), `trade` (not skillos_mini), `llmos` (not llm_os). This sets the tone as utilitarian, not branded.

2. **Write a 1-2 sentence pitch.** State what the project does in plain language. No jargon, no acronyms, no "framework for." Example: "Navigate a real or simulated robot with vision language models." The pitch should be understandable to someone who has never seen the project.

3. **Add ecosystem context line.** One line linking to the parent organization or ecosystem. Example: "Part of the [Evolving Agents](https://github.com/EvolvingAgentsLabs) ecosystem."

4. **Write the Install section.** Exactly the commands needed to get the project on disk and dependencies installed. Three lines maximum: clone, cd, install. Add a prerequisites line only if non-obvious runtime dependencies are required (e.g., Rust, llama.cpp, GGUF model).

5. **Write the Use section.** Show the 5-7 most important CLI commands with inline comments. Use a project-specific verb as the command prefix (robot, trade, llmos) -- not generic tool names (npm run, python, cargo). Group commands logically: primary workflow first, then secondary modes, then diagnostics. Add prerequisite subsections only if multi-terminal setup is required.

6. **Write the How it works section.** One paragraph (3-5 sentences) explaining the core mechanism. Optionally include ONE small visual aid -- a comparison table (like the POSIX-vs-LLM-OS analogy table) or a directory tree (like the cartridge structure) -- but never a Mermaid diagram or flowchart. The visual must fit in 10 lines or fewer.

7. **Write the Architecture section.** A single link to ARCHITECTURE.md with a brief description of what it covers. Follow with 2-4 links to other docs (USAGE.md, TUTORIAL.md, NEXT_STEPS.md). Do not repeat any content from those docs.

8. **Write the License section.** One line. Example: "Apache 2.0"

9. **Verify line count.** The completed README should be 60-80 lines. If it exceeds 80, content is leaking in from ARCHITECTURE.md and must be moved back.

10. **Cross-check ARCHITECTURE.md companion.** Ensure ARCHITECTURE.md begins with a note establishing the separation: "The README is the pitch (what it is and how to run it). This doc is the map (every layer, every data path, every invariant)." This prevents future contributors from re-merging the two documents.

## Negative Constraints

- Do not add SVG banners, badges, shields.io indicators, or decorative HTML to the README
- Do not embed Mermaid diagrams, flowcharts, or sequence diagrams -- those belong in ARCHITECTURE.md
- Do not include detailed architecture explanations, tier tables, or component inventories
- Do not use the repository name as the H1 title -- use a lowercase noun describing the thing itself
- Do not exceed 80 lines -- if growing beyond that, content is leaking from architecture docs
- Do not duplicate content between README and ARCHITECTURE.md -- single source of truth for each concern
- Do not use marketing language ("powerful", "cutting-edge", "blazing fast") -- let the CLI examples speak

## Notes

**Validated on 3 projects (2026-04-28):**

| Project | Before | After | Pattern |
|---------|--------|-------|---------|
| RoClaw | ~300 lines, SVG banners, Mermaid diagrams | 78 lines, `# robot` | Full rewrite |
| skillos_mini | ~300 lines, Tron-aesthetic | 76 lines, `# trade` | Full rewrite |
| llm_os | ~300 lines, detailed ISA spec | 72 lines, `# llmos` | Full rewrite |

**Companion strategy:** `strat_2_research-backed-architecture-documentation` defines how to write the ARCHITECTURE.md that receives the technical detail removed from the README. These two strategies work as a pair: the README strategy defines what to CUT from the README; the architecture documentation strategy defines how to ORGANIZE what was cut.

**The "man page" test:** A well-structured terminal-first README should feel like a man page: title, synopsis (pitch), description (how it works), examples (use), and see-also (architecture links). If the README fails this test, it has drifted toward a landing page.

**Why lowercase title matters:** Using `# robot` instead of `# RoClaw` signals that this is a tool, not a brand. It sets reader expectations correctly: this is documentation for operators, not marketing for evaluators. The lowercase convention also creates visual consistency across a multi-project ecosystem.
