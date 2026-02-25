# LLMunix Evolution

## Markdown Memory

RoClaw's memory system is radically simple: markdown files and JSON graphs.

```
src/3_llmunix_memory/
├── semantic_map.ts        # VLM-powered topological graph (Navigation CoT)
├── semantic_map_loop.ts   # Async sidecar that feeds camera frames to the map
├── system/
│   ├── hardware.md        # Physical specs (wheel size, motor limits)
│   └── identity.md        # "I am RoClaw"
├── skills/                # Learned capabilities (populated over time)
└── traces/
    ├── semantic_map.json  # Pose→label store (simple observations)
    └── topo_map.json      # Topological graph (nodes + edges)
```

No database. No vector store. No embeddings. Just text files and JSON that an LLM can read and write.

## System Memory

The `system/` directory contains immutable facts about the robot:

- **hardware.md**: Motor specs, chassis dimensions, camera resolution, safety limits. This is injected into every VLM prompt so the Cerebellum understands its physical constraints.
- **identity.md**: Who the robot is. This grounds the LLM's self-model.

## Semantic Map

The **Semantic Map** is the robot's topological memory — a graph where nodes are locations (identified by VLM-extracted visual features) and edges are navigation paths between them. It powers the [Navigation Chain of Thought](../README.md#navigation-chain-of-thought).

Two layers:
- **PoseMap** (`semantic_map.json`): Simple pose→label store. Records observations as the robot drives.
- **SemanticMap** (`topo_map.json`): VLM-powered topological graph. Each node stores a location label, description, visual features, and navigation hints. Edges record how the robot traversed between locations.

The SemanticMap runs as an async background sidecar (`SemanticMapLoop`) alongside the Cerebellum's vision loop. It captures the latest camera frame, asks the VLM to describe the scene, then analyzes the description to build and update the graph. Both `analyzeScene()` and `processScene()` accept optional images for direct vision analysis.

The full pipeline is validated with E2E tests using real indoor photographs — see `__tests__/navigation/semantic-map-vision.e2e.test.ts`.

## Skills (Future)

The `skills/` directory will contain learned capabilities as markdown files:

```markdown
# Skill: Navigate Through Doorway

## When to use
When the goal mentions a room transition and a doorway is visible.

## Procedure
1. Align with the doorway center
2. Move forward slowly (speed 60)
3. Check clearance on both sides
4. Accelerate once through

## Learned from
Trace #42, 2026-02-15
```

Skills are promoted from execution traces when a behavior pattern is confirmed across multiple runs.

## Execution Traces (Future)

The `traces/` directory will accumulate during operation:

```markdown
# Trace #42 — 2026-02-15T14:23:00Z

## Goal
Navigate to the kitchen

## Frames
- Frame 1: Hallway detected → FORWARD 80 80
- Frame 2: Doorway visible → FORWARD 60 60
- Frame 3: Through doorway → FORWARD 80 80
- Frame 4: Kitchen counter visible → STOP

## Outcome
SUCCESS — Reached kitchen in 12 frames (6 seconds)
```

## The Dreaming Engine (Future)

Between active operation periods, RoClaw can "dream" — reviewing traces, extracting patterns, and promoting them to skills. This is the LLMunix evolution loop:

1. **Operate**: Execute goals, accumulate traces
2. **Dream**: Review traces, identify patterns
3. **Promote**: Convert confirmed patterns to skills
4. **Evolve**: Skills improve future operation

This is not yet implemented in RoClaw V1. The infrastructure (directory structure, file format conventions) is in place for future development.
