/**
 * RoClaw Dream Domain Adapter
 *
 * Implements the DreamDomainAdapter interface for the RoClaw robot domain.
 * Provides RoClaw-specific action compression (opcode RLE) and LLM prompts
 * for dream consolidation.
 */

import type { DreamDomainAdapter } from '../llmunix-core/interfaces';
import type { ActionEntry } from '../llmunix-core/types';
import type { HierarchyLevel } from '../llmunix-core/types';
import type { SceneGraph, SceneNode } from './scene_graph';
import { aabbIntersect } from './scene_graph';

export const roClawDreamAdapter: DreamDomainAdapter = {
  compressActions(actions: ActionEntry[]): string {
    if (actions.length === 0) return '(no actions)';
    // RLE compression of opcode payloads
    const payloads = actions.map(a => a.actionPayload);
    const rle: string[] = [];
    let current = payloads[0];
    let count = 1;
    for (let i = 1; i < payloads.length; i++) {
      if (payloads[i] === current) {
        count++;
      } else {
        rle.push(count > 1 ? `${current}\u00d7${count}` : current);
        current = payloads[i];
        count = 1;
      }
    }
    rle.push(count > 1 ? `${current}\u00d7${count}` : current);
    return `${actions.length} actions: ${rle.join(', ')}`;
  },

  failureAnalysisSystemPrompt: `You are analyzing a failed robot trace sequence. The robot attempted a goal and failed.

Extract a concise negative constraint \u2014 something the robot should AVOID doing in similar situations.

The trace may contain bytecode commands in RLE-compressed form. Common opcodes:
- FORWARD: drive straight
- TURN_LEFT / TURN_RIGHT: differential steering
- STOP: halt all motors
- ARC_LEFT / ARC_RIGHT: curved path

Output ONLY valid JSON (no markdown, no explanation):
{"description": "...", "context": "...", "severity": "high|medium|low"}`,

  strategyAbstractionSystemPrompt: `You are abstracting successful robot traces into a reusable strategy.

Given a set of successful trace summaries at a specific hierarchy level, create a general-purpose strategy that captures the common pattern.
If the traces contain spatial coordinate hints (e.g., "[spatial: x=...]" or bounding boxes), extract spatial navigation rules that describe how bounding box positions map to motor actions.

Bounding boxes use normalized 0-1000 coordinates in [ymin, xmin, ymax, xmax] format (Gemini Robotics-ER 1.6 native).
Center x = (xmin + xmax) / 2. Use 5-bucket classification: <400 FAR LEFT, 400-480 SLIGHTLY LEFT, 480-520 CENTERED, 520-600 SLIGHTLY RIGHT, >600 FAR RIGHT.

Output ONLY valid JSON (no markdown, no explanation):
{"title": "...", "trigger_goals": [...], "preconditions": [...], "steps": [...], "negative_constraints": [...], "spatial_rules": [...]}`,

  strategyMergeSystemPrompt: `You receive an existing robot strategy and new evidence from recent traces. Produce an updated version that incorporates the new evidence.

Keep the same ID and structure. Update steps, confidence hints, and trigger_goals as needed.

Output ONLY valid JSON (no markdown, no explanation):
{"title": "...", "trigger_goals": [...], "preconditions": [...], "steps": [...], "negative_constraints": [...]}`,

  dreamSummarySystemPrompt: `Write a 2-3 sentence dream journal entry summarizing what the robot learned during this consolidation session.

Be specific about what strategies were created or updated and what failures were analyzed.

Output ONLY the summary text (no JSON, no markdown headers).`,

  buildFailurePrompt(summary: string): string {
    return `Failed robot trace:\n\n${summary}\n\nWhat should the robot avoid doing in similar situations?`;
  },

  buildAbstractionPrompt(summary: string, level: HierarchyLevel): string {
    return `Successful robot trace at Level ${level}:\n\n${summary}\n\nAbstract this into a reusable strategy.`;
  },

  buildMergePrompt(existing: string, evidence: string): string {
    return `Existing strategy:\n${existing}\n\nNew trace evidence:\n${evidence}\n\nUpdate the strategy to incorporate this new evidence.`;
  },
};

// =============================================================================
// Scene-Graph Serialization for Dream Traces (PR-4)
// =============================================================================

/**
 * Serialize a SceneGraph snapshot into a markdown table suitable for
 * inclusion in dream traces. The dream engine can reason about spatial
 * layouts from this structured text.
 *
 * Format:
 *   | Node | Label | X (cm) | Y (cm) | Heading (°) | Confidence |
 *   |------|-------|--------|--------|-------------|------------|
 *   | roclaw | RoClaw Robot | 45.0 | 100.0 | 0.0 | 1.00 |
 */
export function serializeSceneGraph(graph: SceneGraph): string {
  const nodes = graph.getAllNodes();
  if (nodes.length === 0) return '(empty scene graph)';

  const lines: string[] = [
    '| Node | Label | X (cm) | Y (cm) | Heading (°) | BBox (w×h×d) | Confidence |',
    '|------|-------|--------|--------|-------------|--------------|------------|',
  ];

  for (const node of nodes) {
    const x = node.position[0].toFixed(1);
    const y = node.position[1].toFixed(1);
    const heading = node.getHeadingDegrees().toFixed(1);
    const bbox = `${node.boundingBox.w}×${node.boundingBox.h}×${node.boundingBox.d}`;
    const conf = node.confidence.toFixed(2);
    lines.push(`| ${node.id} | ${node.label} | ${x} | ${y} | ${heading} | ${bbox} | ${conf} |`);
  }

  return lines.join('\n');
}

/**
 * Count forward-collision predictions for all obstacle nodes.
 * Returns the number of obstacles within a forward sweep of `distanceCm`.
 */
export function countCollisionPredictions(graph: SceneGraph, distanceCm: number = 30): number {
  const swept = graph.robot.getForwardSweptAABB(distanceCm);
  let count = 0;
  for (const node of graph.getObstacles()) {
    if (aabbIntersect(swept, node.getWorldAABB())) count++;
  }
  return count;
}
