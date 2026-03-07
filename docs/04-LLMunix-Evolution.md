# LLMunix Evolution

## Architecture: Core + Adapter

The cognitive architecture is split into two layers:

- **`src/llmunix-core/`** — Generic, domain-agnostic cognitive architecture with zero robotics imports. Provides types, strategy store, trace logger, memory manager, dream engine, and shared utilities. Reusable by any agent that needs hierarchical memory and experience evolution.
- **`src/3_llmunix_memory/`** — RoClaw adapter layer that extends the core with robotics-specific behavior: bytecode entries, motor LLM prompts, hardware/identity sections, and the semantic map.

```
src/llmunix-core/                    # Generic cognitive architecture
├── types.ts              # HierarchyLevel, TraceOutcome, ActionEntry, Strategy, etc.
├── interfaces.ts         # DreamDomainAdapter, MemorySection, InferenceFunction
├── utils.ts              # extractJSON, parseJSONSafe
├── strategy_store.ts     # Configurable store (generic level dirs, YAML frontmatter)
├── trace_logger.ts       # Generic trace logger (appendAction — no Buffer/formatHex)
├── memory_manager.ts     # Section-based memory manager (registerSection pattern)
├── dream_engine.ts       # Adapter-driven 3-phase dream consolidation (DreamEngine class)
└── index.ts              # Barrel export

src/3_llmunix_memory/                # RoClaw adapter layer
├── trace_types.ts        # Re-exports core + BytecodeEntry backward compat
├── trace_logger.ts       # Extends core, adds appendBytecode(Buffer)
├── strategy_store.ts     # Extends core with RoClaw level dirs (routes, motor)
├── memory_manager.ts     # Extends core, registers hardware/identity/skills sections
├── roclaw_dream_adapter.ts # DreamDomainAdapter (bytecode RLE + robot LLM prompts)
├── dream_inference.ts    # LLM inference adapter for Dreaming Engine
├── semantic_map.ts       # VLM-powered topological graph (Navigation CoT)
├── semantic_map_loop.ts  # Async sidecar that feeds camera frames to the map
├── system/
│   ├── hardware.md       # Physical specs (wheel size, motor limits)
│   └── identity.md       # "I am RoClaw"
├── skills/               # Flat skill files (legacy, from Dreaming Engine v1)
├── strategies/           # Hierarchical strategies (from Dreaming Engine v2)
│   ├── level_1_goals/    # Goal decomposition strategies
│   ├── level_2_routes/   # Multi-room navigation strategies
│   ├── level_3_tactical/ # Intra-room movement strategies
│   ├── level_4_motor/    # Motor pattern strategies
│   ├── _seeds/           # Bootstrap strategies (checked into git)
│   ├── _negative_constraints.md  # Anti-patterns from failures
│   └── _dream_journal.md        # Append-only dream session log
└── traces/
    ├── semantic_map.json # Pose→label store (simple observations)
    ├── topo_map.json     # Topological graph (nodes + edges)
    └── trace_*.md        # Execution trace files (v1 + v2 format)
```

No database. No vector store. No embeddings. Just text files and JSON that an LLM can read and write.

## Markdown Memory

## System Memory

The core `CoreMemoryManager` (`src/llmunix-core/memory_manager.ts`) uses a section registration pattern — domains register their memory sections (name, heading, load function, priority) and the manager assembles them into a unified context. RoClaw's `MemoryManager` extends the core and registers three sections:

- **hardware** (priority 10): `system/hardware.md` — Motor specs, chassis dimensions, camera resolution, safety limits
- **identity** (priority 20): `system/identity.md` — Who the robot is, grounding the LLM's self-model
- **skills** (priority 30): Flat skill files (legacy) + hierarchical strategy summaries

Convenience wrappers `getHardwareProfile()`, `getIdentity()`, and `getSkills()` delegate to `getSection(name)`.

## Semantic Map

The **Semantic Map** is the robot's topological memory — a graph where nodes are locations (identified by VLM-extracted visual features) and edges are navigation paths between them. It powers the [Navigation Chain of Thought](../README.md#navigation-chain-of-thought).

Two layers:
- **PoseMap** (`semantic_map.json`): Simple pose→label store. Records observations as the robot drives.
- **SemanticMap** (`topo_map.json`): VLM-powered topological graph. Each node stores a location label, description, visual features, and navigation hints. Edges record how the robot traversed between locations.

The SemanticMap runs as an async background sidecar (`SemanticMapLoop`) alongside the Cerebellum's vision loop. It captures the latest camera frame, asks the VLM to describe the scene, then analyzes the description to build and update the graph. Both `analyzeScene()` and `processScene()` accept optional images for direct vision analysis.

Scene analysis uses a dedicated inference configuration (`mapInfer`) with higher limits than the bytecode inference path — 512 tokens and 30s timeout (vs 64 tokens / 5s for bytecode generation). This is necessary because VLM scene analysis returns rich JSON with location labels, features, and navigation hints, while bytecode output is a single 6-byte command.

In `handleGoTo()`, the SemanticMapLoop is started and an immediate `analyzeNow()` call seeds the topo map with at least one node **before** `planNavigation()` runs. This ensures the navigation planner has topological context from the first frame rather than planning against an empty map.

The `parseJSONSafe()` utility includes truncated JSON recovery — if the VLM output is cut off mid-JSON (e.g., due to token limits), it attempts to salvage the response by trimming trailing incomplete values and closing unclosed brackets.

Navigation planning now accepts optional `strategyHint` and `constraints` parameters, which inject strategy knowledge into the VLM prompt for more informed motor decisions.

The full pipeline is validated with E2E tests using real indoor photographs — see `__tests__/navigation/semantic-map-vision.e2e.test.ts`.

## Hierarchical Strategies

The core `StrategyStore` (`src/llmunix-core/strategy_store.ts`) supports configurable level directory names via `LevelDirectoryConfig`. The defaults are generic (`level_2_strategy`, `level_4_reactive`), and RoClaw overrides two of them:

| Level | Core Default | RoClaw Override |
|-------|-------------|-----------------|
| 2 (Strategy) | `level_2_strategy` | `level_2_routes` |
| 4 (Reactive) | `level_4_reactive` | `level_4_motor` |

The `strategies/` directory stores learned behaviors organized by the 4-tier cognitive hierarchy:

| Level | Directory | Purpose | Example |
|-------|-----------|---------|---------|
| 1 (Goal) | `level_1_goals/` | High-level goal decomposition | "Fetch pattern: go to X, find Y, return" |
| 2 (Strategy) | `level_2_routes/` | Multi-room navigation routes | "Room exploration: systematic sweep pattern" |
| 3 (Tactical) | `level_3_tactical/` | Intra-room movement patterns | "Doorway approach: slow down, center, proceed" |
| 4 (Reactive) | `level_4_motor/` | Motor control patterns | "Obstacle avoidance: stop, scan, turn away" |

Each strategy is a markdown file with YAML-like frontmatter:

```markdown
---
id: strat_4_obstacle-avoidance
version: 1
hierarchy_level: 4
title: Basic Obstacle Avoidance
confidence: 0.3
success_count: 0
failure_count: 0
trigger_goals:
  - explore
  - avoid obstacles
  - navigate
preconditions:
  - Camera feed available
  - Motors operational
source_traces: []
deprecated: false
---

# Basic Obstacle Avoidance

## Steps
1. When obstacle detected within ~20cm, issue STOP
2. Scan left and right by rotating in place
3. Turn toward the direction with more open space
4. Resume forward movement at reduced speed

## Negative Constraints
- Never accelerate toward a detected obstacle
- Never ignore persistent obstacles hoping they will move
```

### Seed Strategies

The `_seeds/` directory contains 6 bootstrap strategies with `confidence: 0.3` (theoretical, never tested). These provide useful defaults before the robot has accumulated any real traces:

- `seed_4_obstacle-avoidance.md` — Stop and turn when obstacle detected
- `seed_4_wall-following.md` — Hug wall using differential speed
- `seed_3_doorway-approach.md` — Slow down, center, proceed through doors
- `seed_2_room-exploration.md` — Systematic room sweep pattern
- `seed_2_target-seek.md` — Rotate to scan, then track and approach a visually identifiable target
- `seed_1_fetch-pattern.md` — Go to X, find Y, return

As the Dreaming Engine processes real traces, it either reinforces seeds (increasing confidence) or deprecates them.

### Strategy Selection (Composite Scoring)

When the planner queries `findStrategies(goal, level)`, strategies are scored using a weighted composite:

| Factor | Weight | Description |
|--------|--------|-------------|
| Trigger match quality | 50% | Exact match (1.0) > substring (0.7) > word overlap (0.4) |
| Confidence | 30% | The strategy's `confidence` field (0-1), updated by reinforcement and decay |
| Success rate | 20% | `successCount / (successCount + failureCount)`, defaults to 0.5 for untested strategies |

Strategies with a composite score below 0.2 are filtered out. The planner matches strategies **per step** — each step in a multi-step plan finds the best strategy for its own description rather than reusing a single strategy for all steps.

### Negative Constraints

The `_negative_constraints.md` file accumulates anti-patterns extracted from failure traces — things the robot learned NOT to do. These are injected into the VisionLoop's system prompt alongside strategy hints.

Example:
```markdown
- **WARNING**: Do not accelerate when obstacle is within 15cm (context: indoor navigation)
- **CRITICAL**: Do not attempt tight turns in narrow hallways (context: hallway navigation)
```

## Execution Traces

Traces accumulate during operation in `traces/trace_YYYY-MM-DD.md`. The system supports two formats:

### v1 Format (legacy)

```markdown
### Time: 2026-02-22T14:23:00.000Z
**Goal:** explore and avoid obstacles
**VLM Reasoning:** I see a clear hallway ahead with no obstacles...
**Compiled Bytecode:** `AA 01 64 64 01 FF`
---
```

### v2 Format (hierarchical)

```markdown
### Time: 2026-03-01T10:15:30.000Z
**Trace ID:** tr_abc123_xyz
**Level:** 3
**Parent:** tr_parent456_def
**Goal:** navigate through doorway
**Source:** SIM_3D
**VLM Reasoning:** Doorway detected ahead, centering...
**Compiled Bytecode:** `AA 01 3C 3C 3D FF`
---
```

v2 traces add optional fields that v1 parsers skip — full backward compatibility is maintained. The `**Source:**` field is only written for non-UNKNOWN sources; legacy traces without this field default to `UNKNOWN_SOURCE` (fidelity 0.6) during dream processing.

### REACTIVE Traces (Level 4)

The VisionLoop automatically generates Level 4 REACTIVE traces by wrapping every 10 bytecodes in a windowed trace parented to the active higher-level trace. These give the Dreaming Engine motor-sequence-level data for pattern learning:

- **On arrival** — the reactive trace closes as SUCCESS (the motor sequence achieved its sub-goal)
- **On stuck/timeout** — the reactive trace closes as FAILURE (the motor sequence didn't work)
- **On window complete** — the reactive trace closes as UNKNOWN and a new window opens

This ensures the Dreaming Engine's REM phase has Level 4 traces with outcome data, enabling it to abstract successful motor patterns into reusable reactive strategies and extract negative constraints from failures.

### Trace Lifecycle

The `HierarchicalTraceLogger` class manages trace lifecycle:

1. `startTrace(level, goal)` — Open a new trace with a unique ID
2. `appendAction(traceId, reasoning, actionPayload)` — Record each inference cycle (core generic API)
3. `appendBytecode(traceId, vlmOutput, bytecode)` — RoClaw-specific: converts Buffer to hex then calls `appendAction`
4. `endTrace(traceId, outcome, reason?)` — Close the trace with SUCCESS/FAILURE/PARTIAL

The core logger (`src/llmunix-core/trace_logger.ts`) uses generic `ActionEntry` (reasoning + actionPayload). The RoClaw logger extends it with `appendBytecode()` which calls `formatHex(bytecode)` and delegates to `appendAction()`.

## The Dreaming Engine

Between active operation periods, RoClaw "dreams" — reviewing traces, extracting patterns, and consolidating them into reusable strategies.

### v2: LLM-Powered Consolidation

The Dreaming Engine v2 uses the `DreamEngine` class from `src/llmunix-core/dream_engine.ts` — a generic, adapter-driven consolidation engine. RoClaw provides a `DreamDomainAdapter` (`src/3_llmunix_memory/roclaw_dream_adapter.ts`) that supplies bytecode RLE compression and robot-specific LLM prompts. The `scripts/dream.ts` entry point instantiates the engine with the RoClaw adapter.

The algorithm is modeled on biological sleep phases:

**Phase 1 — Slow Wave Sleep (Replay & Pruning):**
1. Read all `trace_*.md` files, parse both v1 and v2 formats
2. Check `_dream_journal.md` for last dream timestamp, filter to new traces only
3. Group traces into sequences by `parentTraceId` links or goal + time proximity (30s window)
4. Compute dominant source for each group (highest-fidelity source in the traces)
5. Score each sequence: `(avgConfidence × outcomeWeight × recencyBonus × fidelityWeight) / durationPenalty`
6. For FAILURE sequences: call LLM to extract negative constraints (with deduplication)
7. **Actively prune** low-value sequences (score < 0.1, non-failure) — these are removed from the pipeline and never reach REM phase

**Phase 2 — REM Sleep (Strategy Abstraction):**
1. Group successful/unknown traces by hierarchy level (pruned sequences already removed)
2. Summarize each sequence compactly (~200 tokens, with RLE-compressed bytecodes, including source/fidelity info)
3. Check for existing matching strategies (fuzzy `triggerGoal` overlap)
4. If match exists: call LLM to merge new evidence, boost confidence by `+0.05 × fidelityWeight`
5. If no match: call LLM to abstract into a new strategy, initial confidence = `0.5 × fidelityWeight`
6. Deprecate strategies with high failure rates (failureCount > 3 && failures > 2× successes)

**Phase 3 — Consolidation:**
1. Write new strategies to `strategies/level_N_*/strat_N_<slug>.md` (including `spatialRules` section)
2. Reinforce existing strategies confirmed by new traces
3. Write negative constraints to `_negative_constraints.md` (with deduplication check)
4. Generate and append a dream journal entry to `_dream_journal.md`
5. Delete processed trace files older than retention period (default 7 days)
6. Clear memory manager cache

### Usage

```bash
npm run dream      # v2: LLM-powered 3-phase consolidation
npm run dream:sim  # Text-based dream simulator (generates DREAM_TEXT traces)
npm run dream:v1   # v1: Statistical 3-opcode sliding-window patterns
```

Dream consolidation also runs automatically on shutdown when using `run_sim3d.ts` in `go_to` mode (default). Use `--no-dream` to disable:

```bash
npx tsx scripts/run_sim3d.ts --goal "the red cube"            # dream runs on shutdown (default)
npx tsx scripts/run_sim3d.ts --goal "the red cube" --no-dream # skip dream
npx tsx scripts/run_sim3d.ts --explore --dream                # opt-in for explore mode
```

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `DREAM_MODEL` | (uses QWEN_MODEL) | Model for dream inference |
| `DREAM_MAX_TOKENS` | 2048 | Max tokens per dream LLM call |
| `DREAM_TEMPERATURE` | 0.3 | Temperature for dream inference |
| `DREAM_BATCH_SIZE` | 10 | Max trace sequences per LLM call |
| `DREAM_WINDOW_DAYS` | 7 | Only process traces from last N days |
| `DREAM_RETENTION_DAYS` | 7 | Delete processed traces older than N days |

### DreamDomainAdapter

The `DreamDomainAdapter` interface (defined in `src/llmunix-core/interfaces.ts`) decouples the dream algorithm from domain-specific concerns. Any domain can plug into the DreamEngine by implementing 8 members:

| Member | Purpose |
|--------|---------|
| `compressActions(actions)` | Summarize actions for LLM (RoClaw: opcode RLE) |
| `failureAnalysisSystemPrompt` | System prompt for failure analysis |
| `strategyAbstractionSystemPrompt` | System prompt for strategy creation |
| `strategyMergeSystemPrompt` | System prompt for strategy update |
| `dreamSummarySystemPrompt` | System prompt for journal entry |
| `buildFailurePrompt(summary)` | User prompt for failure analysis |
| `buildAbstractionPrompt(summary, level)` | User prompt for strategy creation |
| `buildMergePrompt(existing, evidence)` | User prompt for strategy merge |

RoClaw's adapter (`roClawDreamAdapter` in `roclaw_dream_adapter.ts`) implements these with bytecode-specific RLE compression and robot-focused LLM prompts.

### Cold Start

When no API key is configured or no traces exist, the dream engine installs seed strategies from `_seeds/` and exits. This ensures the robot has useful baseline behaviors from the first run.

### v1: Statistical Pattern Extraction (Legacy)

The original Dreaming Engine (`scripts/dream_v1.ts`) uses a simpler statistical approach:

1. Parse trace files into structured entries (timestamp, goal, bytecode)
2. Extract opcode sequences grouped by goal
3. Find 3-command sliding-window patterns that appear 3+ times
4. Generate skill markdown files in `src/3_llmunix_memory/skills/`

This is preserved for environments where LLM API access is unavailable.

## Memory Fidelity Weighting

Not all experiences are equal. The system implements an **epistemological hierarchy** via `TraceSource` — each trace carries its origin, and the dream engine scales strategy confidence accordingly:

| Source | Fidelity Weight | Use Case |
|--------|----------------|----------|
| `REAL_WORLD` | 1.0 | Physical robot with real sensors |
| `SIM_3D` | 0.8 | MuJoCo physics with rendered frames |
| `SIM_2D` | 0.5 | Simplified 2D physics |
| `DREAM_TEXT` | 0.3 | Text-based dream simulation |
| `UNKNOWN_SOURCE` | 0.6 | Legacy traces without source tagging |

**How it flows through the system:**

1. **Trace creation**: `traceSource` is set on the `ToolContext` (e.g., `SIM_3D` in `run_sim3d.ts`, `REAL_WORLD` by default)
2. **Planner propagation**: `HierarchicalPlanner` passes `this.traceSource` to every `startTrace()` call
3. **Trace serialization**: Written as `**Source:** SIM_3D` in the trace markdown
4. **Dream parsing**: `parseTraceFiles()` reads the `**Source:**` field, defaults to `UNKNOWN_SOURCE` for legacy traces
5. **Sequence grouping**: `dominantSource()` selects the highest-fidelity source in each trace group
6. **Scoring**: `score = (avgConfidence × outcomeWeight × recencyBonus × fidelityWeight) / durationPenalty`
7. **Strategy creation**: Initial confidence = `0.5 × fidelityWeight`; reinforcement boost = `+0.05 × fidelityWeight`

This enables rapid hypothesis generation via dream simulation (many low-confidence strategies) that get validated and fast-tracked through real-world experience.

See [09-Memory-Fidelity-And-Dream-Simulation.md](09-Memory-Fidelity-And-Dream-Simulation.md) for the full design.

## Dream Simulator

The dream simulator (`npm run dream:sim`) generates synthetic traces without hardware or physics:

```bash
npm run dream:sim -- --scenario kitchen_exploration --provider gemini
```

Generated traces are tagged as `DREAM_TEXT` (fidelity 0.3) and feed into the standard Dreaming Engine pipeline. The simulator supports dual-mode inference (Claude or Gemini). Strategies from dream simulation start at confidence 0.15 and require ~7 real-world successes to reach 0.50.

See `src/3_llmunix_memory/dream_simulator/` for implementation.

## Simulation-Driven Evolution

The evolution loop can run at multiple fidelity levels, from pure text simulation to full physics:

| Level | Command | Source Tag | Fidelity | Speed |
|-------|---------|-----------|----------|-------|
| Text dream | `npm run dream:sim` | `DREAM_TEXT` | 0.3 | ~100 traces/min |
| 3D physics | `scripts/run_sim3d.ts` | `SIM_3D` | 0.8 | Real-time |
| Real hardware | `npm run dev` | `REAL_WORLD` | 1.0 | Real-time |

The 3D physics simulator (MuJoCo WASM + Three.js) provides:

- **First-person camera frames** from the robot's `eyes` camera (65° FOV, 320x240), rendered to an offscreen `WebGLRenderTarget` and streamed as MJPEG
- **Physics-accurate motor response** via MuJoCo velocity actuators, translating bytecodes to wheel angular velocities
- **Pose feedback** for trace logging and semantic map building

Traces from all levels feed the same Dreaming Engine — the fidelity weights ensure strategies converge on real-world truth regardless of how they were initially discovered.

## The Evolution Loop

The complete evolution cycle:

1. **Hypothesize** — Dream simulator generates text-based traces (DREAM_TEXT, confidence 0.15)
2. **Simulate** — MuJoCo 3D simulation validates hypotheses with physics (SIM_3D, confidence 0.40)
3. **Operate** — Real hardware confirms strategies with ground truth (REAL_WORLD, confidence 0.50)
4. **Dream** — LLM-powered consolidation: failures → constraints, successes → strategies
5. **Remember** — Strategies + constraints stored in `strategies/` directory with fidelity-weighted confidence
6. **Evolve** — Planner queries strategies for next operation, VisionLoop uses constraints
7. **Repeat** — Each cycle refines strategies with progressively higher-fidelity evidence
