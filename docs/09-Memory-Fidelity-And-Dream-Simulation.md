# Memory Fidelity & Dream Simulation

**Date:** March 7, 2026

## The Core Insight: Not All Experiences Are Equal

A robot that bumps into a wall learns something different from a robot that imagines bumping into a wall. The physical experience has ground truth — real sensor data, real motor response, real consequences. A text-based dream simulation is useful for generating hypotheses, but its lessons should carry less weight until validated in the real world.

RoClaw implements this intuition as **Memory Fidelity Weighting** — an epistemological hierarchy that tags every experience with its source and scales its influence on strategy formation accordingly.

## The Epistemological Hierarchy

Every trace in the system carries a `TraceSource` enum:

```typescript
enum TraceSource {
  REAL_WORLD    = 'REAL_WORLD',    // Physical robot with real sensors
  SIM_3D        = 'SIM_3D',        // MuJoCo physics with rendered frames
  SIM_2D        = 'SIM_2D',        // Simplified 2D physics
  DREAM_TEXT    = 'DREAM_TEXT',    // Pure text simulation, no visual grounding
  UNKNOWN_SOURCE = 'UNKNOWN_SOURCE', // Legacy traces without source tagging
}
```

Each source maps to a fidelity weight:

| Source | Weight | Rationale |
|--------|--------|-----------|
| `REAL_WORLD` | **1.0** | Ground truth. Real physics, real sensors, real consequences. |
| `SIM_3D` | **0.8** | High-fidelity physics (MuJoCo) with rendered camera frames. Close to reality but lacks sensor noise, lighting variation, and physical wear. |
| `SIM_2D` | **0.5** | Approximate physics without rendered visuals. Useful for testing navigation logic but missing perceptual grounding. |
| `DREAM_TEXT` | **0.3** | Pure text descriptions. No physics, no vision. Good for generating hypotheses but unreliable for strategy confidence. |
| `UNKNOWN_SOURCE` | **0.6** | Legacy traces from before source tagging. Given benefit of the doubt. |

## How Fidelity Flows Through the System

### 1. Trace Tagging

When a trace is created, the source is set based on where the system is running:

- `scripts/run_sim3d.ts` sets `traceSource: TraceSource.SIM_3D` on the ToolContext
- `roclaw_tools.ts` passes `ctx.traceSource` to the planner and trace logger
- The planner passes it through to `startTrace()` for every hierarchical trace
- Dream simulator scripts set `TraceSource.DREAM_TEXT`
- Default (real hardware via `npm run dev`) uses `TraceSource.REAL_WORLD`

### 2. Trace Serialization

The trace logger writes the source to the markdown trace file:

```markdown
### Time: 2026-03-07T14:30:00.000Z
**Trace ID:** tr_abc123
**Level:** 2
**Goal:** navigate to kitchen
**Source:** SIM_3D
```

### 3. Dream Engine Scoring

When the dream engine processes traces, it uses fidelity-weighted scoring:

```
score = (avgConfidence × outcomeWeight × recencyBonus × fidelityWeight) / durationPenalty
```

This means a real-world success scores **3.3x higher** than an identical dream-text success (1.0/0.3).

### 4. Strategy Confidence Scaling

When the dream engine creates or updates strategies:

- **New strategy initial confidence** = `0.5 × fidelityWeight`
  - Real-world: 0.50
  - 3D sim: 0.40
  - Dream text: 0.15
- **Strategy reinforcement** = `+0.05 × fidelityWeight`
  - Real-world: +0.05 per success
  - Dream text: +0.015 per success

### 5. Dominant Source Selection

When traces from mixed sources are grouped into a sequence (e.g., a goal trace from real-world with sub-traces from simulation), the dream engine selects the **highest-fidelity source** as the dominant source for the group. The hierarchy is: REAL_WORLD > SIM_3D > SIM_2D > DREAM_TEXT.

## The Dream Simulator

The dream simulator generates synthetic training experiences without hardware:

```bash
npm run dream:sim -- --scenario kitchen_exploration --provider gemini
```

### How It Works

1. **Scenario Definition** — Text-based scene descriptions define a virtual environment
2. **Scenario Runner** — Steps through the scenario, calling the LLM for motor decisions
3. **Trace Generation** — Each decision becomes a trace entry tagged as `DREAM_TEXT`
4. **Standard Dream Pipeline** — Generated traces feed into the normal `DreamEngine`

### The Hypothesis-Validation Loop

The dream simulator's power comes from the fidelity weighting system:

```
Dream Simulator (DREAM_TEXT, fidelity=0.3)
    → Generates 100 traces in 5 minutes
    → DreamEngine creates strategies at confidence 0.15
    → Robot encounters similar situation in real world
    → Strategy matches, robot tries it
    → If SUCCESS: confidence jumps by +0.05 (real-world reinforcement)
    → After 7 real successes: confidence reaches 0.50 (production-ready)
```

This is analogous to how biological organisms use dreaming to pre-consolidate potential strategies, which are then validated or discarded through waking experience.

### Dual-Mode Inference

The dream simulator supports two inference backends:

- **Claude** (via Anthropic API) — Deeper reasoning, better for complex scenario analysis
- **Gemini** (via Google API) — Faster inference with optional thinking budget

## Mechanism Improvements (March 7, 2026)

A comprehensive analysis of the cognitive stack identified and fixed 8 mechanism bugs:

### Critical Fixes

| Fix | Impact |
|-----|--------|
| **Spatial rules round-trip** | Strategy `spatialRules` (e.g., "turn right when target bbox > 600px") were being serialized to markdown but silently lost on re-read. Now properly deserialized. |
| **Last-group outcome bug** | The final ungrouped trace sequence in the dream engine always got `UNKNOWN` outcome even if traces had `SUCCESS`. Now correctly checks for success like intermediate groups. |
| **Active SWS pruning** | SWS phase was counting low-value sequences but not removing them. They would still reach REM phase for strategy abstraction. Now actively spliced from the array. |

### Important Fixes

| Fix | Impact |
|-----|--------|
| **Entropy-based stuck detection** | Old approach: 8 identical opcodes in a row. New approach: Shannon entropy over the opcode window. Catches oscillation patterns (LEFT/RIGHT/LEFT/RIGHT) that the old method missed. Threshold: entropy < 0.5 = stuck. |
| **Heartbeat safety margin** | Heartbeat interval reduced from 1500ms to 1000ms. With a 2000ms firmware timeout, the old 500ms margin was too tight for network jitter. Now has a full 1000ms margin. |
| **Duplicate VLM call** | `advanceToNextStep()` was calling the VLM twice on the same frame — once for scene description and once for topo map navigation. Now reuses the scene description, saving ~200ms per step. |

### Code Quality Fixes

| Fix | Impact |
|-----|--------|
| **parseJSONSafe consolidation** | Three identical implementations across `planner.ts`, `semantic_map.ts`, and `utils.ts`. Now planner imports from core. Semantic map imports `extractJSON` from core but keeps its enhanced truncated-JSON recovery. |
| **Negative constraint deduplication** | `saveNegativeConstraint()` now checks for substring-matching duplicates before appending, preventing the dream engine from accumulating near-identical constraints across dream cycles. |

## Test Coverage

The fidelity weighting system is validated by 8 dedicated tests in `dream-engine.test.ts`:

1. REAL_WORLD traces score higher than DREAM_TEXT traces
2. `fidelityWeight` is correctly assigned during sequence grouping
3. Highest-fidelity source is used as dominant in mixed-source groups
4. Dream-sourced traces produce lower initial strategy confidence (0.15 vs 0.50)
5. Source field is correctly parsed from trace files
6. Legacy traces default to `UNKNOWN_SOURCE` (0.6 fidelity)
7. `summarizeSequence()` includes source and fidelity info for LLM context
8. `TRACE_FIDELITY_WEIGHTS` ordering validation (REAL > SIM_3D > SIM_2D > DREAM > UNKNOWN)

Total test suite: **437 tests** across **25 suites**, all passing.
