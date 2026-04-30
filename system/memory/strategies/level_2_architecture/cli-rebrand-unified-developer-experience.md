---
id: strat_2_cli-rebrand-unified-developer-experience
version: 1
hierarchy_level: 2
title: CLI Rebrand -- Unified Developer Experience via bin/ Wrappers
trigger_goals: ["CLI wrapper", "bin script", "developer experience", "terminal interface", "command rebrand", "unified CLI", "subcommand dispatcher"]
preconditions: ["Multiple projects with existing scripts/tools (npm, Python, Rust)", "Each project has a distinct entry point (npm run, python script, cargo/bash)", "Need for consistent developer-facing command interface across portfolio"]
confidence: 0.55
success_count: 1
failure_count: 0
source_traces: ["dream_20260428_a7f3_cli_rebrand_synthesis"]
deprecated: false
---

# CLI Rebrand -- Unified Developer Experience via bin/ Wrappers

## Rationale

When a portfolio has 3+ projects with different tech stacks (Node/TypeScript, Python, Rust), developers must remember project-specific invocation patterns (`npm run sim:3d`, `python cartridge_runtime.py`, `bash scripts/dev.sh --model ...`). A `bin/` wrapper per project provides a Claude Code-style terminal interface where every project feels the same: `<name> <subcommand> [args]`.

This is an architecture-level decision because it affects how developers (and CI) interact with every project in the portfolio. It also establishes a precedent: new projects get a `bin/` entry point from day one.

## Steps

1. **Identify the canonical name** for each project. Choose short, memorable, lowercase names that reflect the project's role (e.g., `robot` for RoClaw, `trade` for skillos_mini, `llmos` for llm_os). The name becomes both the CLI command and the project identity.

2. **Create `bin/<name>`** as a POSIX shell script (`#!/usr/bin/env bash`). This is the single entry point. It must be executable (`chmod +x`).

3. **Implement subcommand dispatch** via a `case` statement that maps each subcommand to the existing underlying tool:
   - `bin/robot sim` maps to `npm run sim:3d`
   - `bin/robot brain` maps to `npx tsx scripts/run_sim3d.ts --gemini`
   - `bin/trade run` maps to `python cartridge_runtime.py`
   - `bin/llmos dev` maps to `bash scripts/dev.sh`

4. **Include two mandatory built-in subcommands** in every wrapper:
   - `help` -- prints usage with all available subcommands and examples
   - `status` -- prints project health (git status, dependency state, running processes)

5. **Root the script** relative to its own location (`ROOT="$(cd "$(dirname "$0")/.." && pwd)"`) so it works from any working directory.

6. **Forward unknown args** to the underlying tool transparently. The wrapper should not eat arguments it does not understand -- pass them through to the delegate script.

7. **Add the `bin/` directory to the user's PATH** (document in README or provide `eval $(bin/robot env)` pattern). Alternatively, symlink into `/usr/local/bin` for system-wide access.

8. **Validate prerequisites** before dispatching: check that required tools exist (node, python3, cargo), required env vars are set (API keys), and required services are running. Fail fast with a clear message if prerequisites are missing.

## Negative Constraints

- Do not duplicate logic from the underlying scripts into the wrapper -- the wrapper is a DISPATCHER, not a reimplementation. If `scripts/dev.sh` handles model validation, the wrapper should not re-validate.
- Do not hardcode absolute paths to tools or models -- use `$ROOT`-relative paths and environment variables.
- Do not create project-specific argument parsing in the wrapper beyond subcommand routing -- complex arg parsing belongs in the delegate script.
- Do not skip the `help` and `status` subcommands -- they are the minimum viable developer experience.

## Notes

- The pattern mirrors how `git` works: a single command (`git`) dispatches to subcommands (`git status`, `git commit`), each of which may be a separate program.
- `scripts/dev.sh` in llm_os is already a strong exemplar of the underlying script pattern (POSIX, `set -euo pipefail`, structured arg parsing, step numbering). The `bin/llmos` wrapper sits above it and adds discoverability.
- For RoClaw, the wrapper unifies 4 disparate entry points: `npm run sim:3d` (bridge), `npx tsx scripts/run_sim3d.ts` (VLM brain), `cd sim && python build_scene.py` (scene), and dream consolidation. One command, multiple modes.
- The `status` subcommand is especially valuable for robotics: it can check ESP32 connectivity, camera availability (addressing Constraint 39), and inference endpoint health in a single command.
