---
id: strat_3_shell-dispatcher-bin-wrapper
version: 1
hierarchy_level: 3
title: Shell Dispatcher Pattern for bin/ CLI Wrappers
trigger_goals: ["shell script", "subcommand dispatch", "bin wrapper", "case statement", "CLI implementation", "POSIX script", "command router"]
preconditions: ["Target project has existing scripts or tools to wrap", "POSIX-compatible shell available (bash, zsh, dash)", "Project root directory identifiable relative to script location"]
confidence: 0.55
success_count: 1
failure_count: 0
source_traces: ["dream_20260428_a7f3_cli_rebrand_synthesis"]
deprecated: false
---

# Shell Dispatcher Pattern for bin/ CLI Wrappers

## Steps

1. **Create the script file** at `bin/<name>` with shebang `#!/usr/bin/env bash` and `set -euo pipefail` for strict error handling.

2. **Resolve project root** immediately:
   ```bash
   ROOT="$(cd "$(dirname "$0")/.." && pwd)"
   ```

3. **Extract the subcommand** from `$1` and shift:
   ```bash
   CMD="${1:-help}"
   shift 2>/dev/null || true
   ```

4. **Implement the dispatch table** as a `case` statement. Each case delegates to the real tool:
   ```bash
   case "$CMD" in
       sim)    exec npm run sim:3d --prefix "$ROOT" -- "$@" ;;
       brain)  exec npx tsx "$ROOT/scripts/run_sim3d.ts" --gemini "$@" ;;
       dev)    exec bash "$ROOT/scripts/dev.sh" "$@" ;;
       help)   usage ;;
       status) project_status ;;
       *)      echo "Unknown command: $CMD"; usage; exit 1 ;;
   esac
   ```

5. **Implement `usage()` function** that prints all subcommands with one-line descriptions:
   ```bash
   usage() {
       cat <<EOF
   Usage: $(basename "$0") <command> [args...]

   Commands:
       sim      Start the 3D simulation bridge
       brain    Run the VLM navigation brain
       dream    Run dream consolidation
       status   Show project health
       help     Show this help message

   Examples:
       $(basename "$0") brain --goal "navigate to the red cube"
       $(basename "$0") dev --model ~/models/qwen2.5-0.5b.gguf
   EOF
   }
   ```

6. **Implement `project_status()` function** that checks:
   - Git branch and uncommitted changes count
   - Required tool availability (node, python3, cargo)
   - Required environment variables (API keys)
   - Running processes (llama-server, ESP32 bridge)
   - Last trace timestamp (from traces/ directory)

7. **Use `exec`** for delegation to replace the shell process, avoiding unnecessary parent process overhead and ensuring signals propagate correctly to the child.

8. **Make executable**: `chmod +x bin/<name>`

## Negative Constraints

- Do not use `source` to load the delegate script -- use `exec` or direct invocation. Sourcing pollutes the wrapper's namespace and makes debugging harder.
- Do not implement subcommand-specific argument validation in the wrapper -- delegate that to the underlying script. The wrapper's only job is routing.
- Do not use bash-specific features that break POSIX compatibility if the script might run on minimal systems (e.g., Pi 5 with dash). Stick to `case`, `if`, `[`, and standard builtins.
- Do not forget the `*) ... exit 1` fallback in the case statement -- unknown subcommands must produce a clear error, not silent success.
- Do not omit the default to `help` when no subcommand is given (`CMD="${1:-help}"`) -- bare invocation should show usage, never error.

## Reference Implementation

The pattern is exemplified by `llm_os/scripts/dev.sh` (lines 51-66), which demonstrates proper arg parsing with `case`, `shift 2`, and `--help` handling. The `bin/` wrapper sits above this and adds subcommand routing.

## Per-Project Subcommand Maps

### bin/robot (RoClaw)
| Subcommand | Delegates to | Description |
|------------|-------------|-------------|
| `sim` | `npm run sim:3d` | Start sim bridge (:9090 WS, :4210 UDP, :8081 MJPEG) |
| `scene` | `cd sim && python build_scene.py` | Build and serve MuJoCo scene (:8000) |
| `brain` | `npx tsx scripts/run_sim3d.ts --gemini` | Run VLM navigation brain |
| `dream` | Dream consolidation invocation | Run hippocampus dream cycle |
| `status` | Git + ESP32 + camera + inference check | Project health report |
| `help` | Built-in | Usage guide |

### bin/trade (skillos_mini)
| Subcommand | Delegates to | Description |
|------------|-------------|-------------|
| `run` | `python cartridge_runtime.py` | Run a cartridge |
| `build` | `npm run build` (Capacitor) | Build Android APK |
| `status` | Git + Android SDK + model check | Project health report |
| `help` | Built-in | Usage guide |

### bin/llmos (llm_os)
| Subcommand | Delegates to | Description |
|------------|-------------|-------------|
| `dev` | `bash scripts/dev.sh` | Dev mode (local build + run) |
| `build` | `bash scripts/dev.sh --build-only` | Build only (no run) |
| `validate` | `bash scripts/validate_grammar.sh` | Validate ISA grammar |
| `flash` | `bash image/flash.sh` | Flash SD card image |
| `status` | Git + cargo + llama-server + grammar check | Project health report |
| `help` | Built-in | Usage guide |

## Notes

- The `exec` pattern is critical for signal handling: if the user presses Ctrl-C, the signal goes directly to the child process (llama-server, npm, python) rather than being caught by the wrapper first.
- For projects with long-running daemons (llm_os dev mode), consider adding a `stop` subcommand that finds and kills the background process by PID file.
- The `status` subcommand can also check the last dream journal entry timestamp, showing how recently memory consolidation ran.
