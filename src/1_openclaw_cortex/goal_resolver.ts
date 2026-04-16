/**
 * Goal Resolver — Text goal → ControllerGoal
 *
 * Bridges the human-readable navigation goal (e.g., "navigate to the red cube")
 * with the ReactiveController's typed ControllerGoal (node reference or point).
 *
 * Resolution strategy:
 *   1. Coordinate pattern: "go to (50, 120)" → { kind: 'point', x: 50, y: 120 }
 *   2. Fuzzy label match against SceneGraph obstacle nodes
 *   3. Fallback: { kind: 'explore' } (not yet supported by ReactiveController,
 *      but callers can handle this gracefully)
 */

import { SceneGraph } from '../3_llmunix_memory/scene_graph';
import type { ControllerGoal } from './reactive_controller';

/** Extended goal type that includes an 'explore' fallback. */
export type ResolvedGoal =
  | ControllerGoal
  | { kind: 'explore' };

/**
 * Resolve a text goal description against the current SceneGraph state.
 *
 * If the graph has no matching nodes (e.g., first frame before perception),
 * returns `{ kind: 'explore' }`.
 */
export function resolveGoalFromText(goalText: string, graph: SceneGraph): ResolvedGoal {
  if (!goalText || typeof goalText !== 'string') {
    return { kind: 'explore' };
  }

  const trimmed = goalText.trim();

  // 1. Try coordinate pattern: "go to (50, 120)" or "point 50 120" or "(50,120)"
  const coordMatch = trimmed.match(/\(?\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*\)?/);
  if (coordMatch && /(?:go\s+to|point|navigate\s+to|move\s+to|coords?|position)\s/i.test(trimmed)) {
    const x = parseFloat(coordMatch[1]);
    const y = parseFloat(coordMatch[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { kind: 'point', x, y };
    }
  }

  // 2. Fuzzy label match against scene graph obstacles
  const obstacles = graph.getObstacles();
  if (obstacles.length === 0) {
    return { kind: 'explore' };
  }

  const goalLc = trimmed.toLowerCase();

  // Extract key noun phrases from goal — strip common navigation prefixes
  const stripped = goalLc
    .replace(/^(?:navigate|go|move|drive|head|walk|proceed)\s+(?:to|toward|towards)\s+(?:the\s+)?/i, '')
    .replace(/^(?:find|reach|get\s+to)\s+(?:the\s+)?/i, '')
    .trim();

  // Try exact substring match first (most reliable)
  let bestMatch: { id: string; score: number } | null = null;
  for (const node of obstacles) {
    const labelLc = node.label.toLowerCase();

    // Exact match
    if (labelLc === stripped) {
      return { kind: 'node', id: node.id };
    }

    // Goal contains label (e.g., goal="find the red cube", label="red cube")
    if (goalLc.includes(labelLc)) {
      const score = labelLc.length; // longer matches are better
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { id: node.id, score };
      }
      continue;
    }

    // Label contains stripped goal words (e.g., stripped="cube", label="red cube")
    if (labelLc.includes(stripped) && stripped.length >= 3) {
      const score = stripped.length;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { id: node.id, score };
      }
      continue;
    }

    // Word overlap scoring
    const goalWords = new Set(stripped.split(/\s+/).filter(w => w.length >= 3));
    const labelWords = labelLc.split(/\s+/);
    let overlap = 0;
    for (const w of labelWords) {
      if (goalWords.has(w)) overlap++;
    }
    if (overlap > 0) {
      const score = overlap * 0.5;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { id: node.id, score };
      }
    }
  }

  if (bestMatch) {
    return { kind: 'node', id: bestMatch.id };
  }

  return { kind: 'explore' };
}
