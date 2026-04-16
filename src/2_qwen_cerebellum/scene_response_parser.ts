/**
 * Scene Response Parser — Gemini perception JSON → GeminiObject[]
 *
 * Parses the JSON output from Gemini when running in OVERHEAD_SCENE_PROMPT
 * mode. Tolerates markdown code fences, partial output, and minor schema
 * deviations.
 *
 * Expected input shape (from bytecode_compiler.ts OVERHEAD_SCENE_PROMPT):
 * ```json
 * {
 *   "objects": [
 *     { "label": "roclaw", "box_2d": [ymin, xmin, ymax, xmax], "heading_estimate": "RIGHT" },
 *     { "label": "red cube", "box_2d": [ymin, xmin, ymax, xmax] }
 *   ]
 * }
 * ```
 */

import type { GeminiObject } from './vision_projector';
import { logger } from '../shared/logger';

/**
 * Parse a Gemini scene response string into validated GeminiObject[].
 *
 * Returns an empty array on any failure — never throws. Callers should
 * treat an empty result as "perception unavailable this frame" and fall
 * back to the previous SceneGraph state.
 */
export function parseGeminiSceneResponse(text: string): GeminiObject[] {
  if (!text || typeof text !== 'string') return [];

  let json = text.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
  }

  // Attempt to parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Try to extract a JSON object from surrounding text (Gemini sometimes
    // emits explanation before/after the JSON blob)
    const objectMatch = json.match(/\{[\s\S]*"objects"\s*:\s*\[[\s\S]*\]\s*\}/);
    if (objectMatch) {
      try {
        parsed = JSON.parse(objectMatch[0]);
      } catch {
        logger.debug('SceneParser', 'Failed to parse extracted JSON', { text: text.slice(0, 200) });
        return [];
      }
    } else {
      logger.debug('SceneParser', 'No valid JSON found', { text: text.slice(0, 200) });
      return [];
    }
  }

  // Validate top-level shape
  if (!parsed || typeof parsed !== 'object') return [];

  const root = parsed as Record<string, unknown>;
  const objects = root.objects;
  if (!Array.isArray(objects)) return [];

  // Validate and extract each object
  const results: GeminiObject[] = [];
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    const o = obj as Record<string, unknown>;

    // label is required
    if (typeof o.label !== 'string' || !o.label.trim()) continue;

    // box_2d is required and must be a 4-element numeric array
    if (!Array.isArray(o.box_2d) || o.box_2d.length !== 4) continue;
    const box = o.box_2d.map(Number);
    if (box.some(v => !Number.isFinite(v))) continue;

    const result: GeminiObject = {
      label: o.label.trim(),
      box_2d: box as [number, number, number, number],
    };

    // heading_estimate is optional
    if (typeof o.heading_estimate === 'string') {
      const he = o.heading_estimate.toUpperCase() as GeminiObject['heading_estimate'];
      if (he === 'UP' || he === 'DOWN' || he === 'LEFT' || he === 'RIGHT') {
        result.heading_estimate = he;
      }
    }

    results.push(result);
  }

  return results;
}
