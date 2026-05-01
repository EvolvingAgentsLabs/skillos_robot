/**
 * VisionProjector — Overhead-camera 2D bounding box → 3D Arena coordinates
 *
 * Lives between the Perception Loop (Gemini Robotics-ER 1.6, ~2 Hz) and the
 * SceneGraph (Reflex Loop, ~30 Hz). Gemini returns normalized bounding boxes:
 *
 *     { "label": "red cube", "box_2d": [ymin, xmin, ymax, xmax] }    // 0–1000
 *
 * Because the V1 hardware camera is mounted overhead (Android phone on tripod —
 * matches sim/roclaw_robot.xml `external_cam` at pos="0 0 0.8" looking down),
 * a normalized [x, y] image coordinate maps almost linearly to a position on
 * the arena floor. No depth estimation, no frustum ray-casting required.
 *
 * Coordinate convention chosen for the projector (single frame throughout the
 * SceneGraph — a separate arena→world transform is the caller's responsibility
 * if they need to reconcile with another frame):
 *
 *   • Image origin (0, 0)        → Arena origin (0, 0)            (top-left)
 *   • Image X right (xmax→1000)  → Arena X right                  (cm)
 *   • Image Y down  (ymax→1000)  → Arena Y down                   (cm)
 *   • Arena Z+ is up out of the floor; obstacles default to z=0.
 *   • Heading 0° points along +X (right); +90° along +Y (down in image).
 *
 * Object identity:
 *   By default we keep stable IDs across frames via a "nearest same-label
 *   within matchRadiusCm" rule (mirrors PoseMap's deduplication logic in
 *   semantic_map.ts). Callers that do their own object tracking (e.g. via
 *   IoU + Hungarian matching in a future commit) can pass an explicit `id`.
 */

import { vec3 } from 'gl-matrix';
import {
  SceneGraph,
  type SceneNode,
  type BoundingBox,
} from '../memory/scene_graph';

// =============================================================================
// Types
// =============================================================================

/** Arena dimensions and floor-plane parameters. */
export interface ArenaConfig {
  /** Physical width (cm) corresponding to the full image X range (xmin=0..xmax=1000). */
  widthCm: number;
  /** Physical height (cm) corresponding to the full image Y range (ymin=0..ymax=1000). */
  heightCm: number;
  /** Z coordinate (cm) at which obstacles are placed. Defaults to 0 (on floor). */
  defaultZCm?: number;
  /** Bounding-box depth (cm) along Z used when none is supplied. Defaults to 5. */
  defaultDepthCm?: number;
}

/**
 * One detection from Gemini Robotics-ER 1.6's `box_2d` output. The normalized
 * tuple is [ymin, xmin, ymax, xmax], each in [0, 1000].
 */
/** Egocentric direction from the robot (8-way compass relative to robot heading). */
export type EgocentricDirection =
  | 'front' | 'front_left' | 'left' | 'behind_left'
  | 'behind' | 'behind_right' | 'right' | 'front_right';

export interface GeminiObject {
  label: string;
  box_2d: [number, number, number, number];
  /**
   * Optional cardinal heading hint. Useful when this object is the robot —
   * the projector will translate it to a degree heading on the arena frame.
   */
  heading_estimate?: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
  /**
   * VLM-estimated distance from the robot to this object in cm.
   * Complements the projector's exact computation — can be used for
   * cross-validation or as fallback when bbox precision is low.
   * (Spartun3D-style egocentric spatial grounding.)
   */
  estimated_distance_cm?: number;
  /**
   * VLM-estimated egocentric direction from the robot to this object,
   * relative to the robot's heading. 8-way compass.
   * (Spartun3D-style egocentric spatial grounding.)
   */
  direction_from_agent?: EgocentricDirection;
  /**
   * Labels of objects that lie between the robot and this object.
   * (Spartun3D situated scene graph — passby objects.)
   */
  passby_objects?: string[];
}

/** Pure-math projection result (no SceneGraph mutation). */
export interface ProjectionResult {
  /** Center of the bbox in arena cm. */
  centerCm: { x: number; y: number };
  /** Bounding-box footprint in arena cm. */
  sizeCm: { w: number; h: number };
}

export interface ProjectOpts {
  /** Override the auto-assigned id. Bypasses the nearest-same-label tracker. */
  id?: string;
  /**
   * Two detections of the same label whose centers are within this distance
   * are treated as the same physical object and update one node. Default: 30.
   */
  matchRadiusCm?: number;
  /** Confidence to record on the node. */
  confidence?: number;
  /**
   * Labels that should update `graph.robot` instead of creating a new node.
   * Matched case-insensitively. Default: ['roclaw', 'robot'].
   */
  robotLabels?: string[];
  /** Optional override for the obstacle Z position (cm). */
  zCm?: number;
}

// =============================================================================
// Constants
// =============================================================================

const NORMALIZED_MAX = 1000;
const DEFAULT_MATCH_RADIUS_CM = 30;
const DEFAULT_ROBOT_LABELS = ['roclaw', 'robot'];

const HEADING_FROM_ESTIMATE: Record<NonNullable<GeminiObject['heading_estimate']>, number> = {
  RIGHT: 0,
  DOWN: 90,
  LEFT: 180,
  UP: -90,
};

// =============================================================================
// Pure projection math
// =============================================================================

/**
 * Convert one normalized [ymin, xmin, ymax, xmax] tuple to arena cm.
 *
 * Tolerates swapped min/max (returns a valid box regardless of order) and
 * clamps to the [0, NORMALIZED_MAX] range — Gemini occasionally emits
 * slightly out-of-range values when an object touches the image edge.
 */
export function projectBoxToArenaCm(
  box: [number, number, number, number],
  arena: ArenaConfig,
): ProjectionResult {
  if (!Number.isFinite(arena.widthCm) || arena.widthCm <= 0) {
    throw new Error(`projectBoxToArenaCm: arena.widthCm must be positive, got ${arena.widthCm}`);
  }
  if (!Number.isFinite(arena.heightCm) || arena.heightCm <= 0) {
    throw new Error(`projectBoxToArenaCm: arena.heightCm must be positive, got ${arena.heightCm}`);
  }

  const ymin = clamp(Math.min(box[0], box[2]), 0, NORMALIZED_MAX);
  const xmin = clamp(Math.min(box[1], box[3]), 0, NORMALIZED_MAX);
  const ymax = clamp(Math.max(box[0], box[2]), 0, NORMALIZED_MAX);
  const xmax = clamp(Math.max(box[1], box[3]), 0, NORMALIZED_MAX);

  const xScale = arena.widthCm / NORMALIZED_MAX;
  const yScale = arena.heightCm / NORMALIZED_MAX;

  const xMinCm = xmin * xScale;
  const xMaxCm = xmax * xScale;
  const yMinCm = ymin * yScale;
  const yMaxCm = ymax * yScale;

  return {
    centerCm: {
      x: (xMinCm + xMaxCm) / 2,
      y: (yMinCm + yMaxCm) / 2,
    },
    sizeCm: {
      w: xMaxCm - xMinCm,
      h: yMaxCm - yMinCm,
    },
  };
}

// =============================================================================
// SceneGraph integration
// =============================================================================

/**
 * Project one Gemini detection into the SceneGraph.
 *
 *   - Robot labels (default: 'roclaw', 'robot') update graph.robot in place,
 *     including heading if `heading_estimate` is provided.
 *   - Other labels add a new node, OR update the nearest existing same-label
 *     node within `matchRadiusCm`.
 *
 * Returns the affected SceneNode.
 */
export function projectGeminiObject(
  graph: SceneGraph,
  obj: GeminiObject,
  arena: ArenaConfig,
  opts: ProjectOpts = {},
): SceneNode {
  const result = projectBoxToArenaCm(obj.box_2d, arena);
  const z = opts.zCm ?? arena.defaultZCm ?? 0;
  const depth = arena.defaultDepthCm ?? 5;
  const bbox: BoundingBox = {
    w: Math.max(result.sizeCm.w, 1),  // avoid degenerate zero-width boxes
    h: Math.max(result.sizeCm.h, 1),
    d: depth,
  };

  const robotLabels = (opts.robotLabels ?? DEFAULT_ROBOT_LABELS).map(s => s.toLowerCase());
  const isRobot = robotLabels.includes(obj.label.trim().toLowerCase());

  if (isRobot) {
    let headingDeg = graph.robot.getHeadingDegrees();
    if (obj.heading_estimate) {
      headingDeg = HEADING_FROM_ESTIMATE[obj.heading_estimate];
    }
    graph.updateRobotPose(result.centerCm.x, result.centerCm.y, headingDeg, z);
    graph.robot.boundingBox = bbox;
    if (opts.confidence !== undefined) graph.robot.confidence = opts.confidence;
    return graph.robot;
  }

  const id = opts.id ?? findOrCreateId(
    graph,
    obj.label,
    result.centerCm,
    opts.matchRadiusCm ?? DEFAULT_MATCH_RADIUS_CM,
  );

  return graph.addOrUpdateNode({
    id,
    label: obj.label,
    x: result.centerCm.x,
    y: result.centerCm.y,
    z,
    boundingBox: bbox,
    confidence: opts.confidence,
  });
}

/** Bulk version: project an array of detections in one call. */
export function projectGeminiObjects(
  graph: SceneGraph,
  objects: GeminiObject[],
  arena: ArenaConfig,
  opts: ProjectOpts = {},
): SceneNode[] {
  return objects.map(obj => projectGeminiObject(graph, obj, arena, opts));
}

// =============================================================================
// Internals
// =============================================================================

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Find an existing same-label node whose center is within `radiusCm` of the
 * incoming detection. If found, return its id; otherwise mint a new id of
 * the form `obj_<sanitized_label>_<n>` choosing the smallest free n.
 */
function findOrCreateId(
  graph: SceneGraph,
  label: string,
  centerCm: { x: number; y: number },
  radiusCm: number,
): string {
  const labelLc = label.trim().toLowerCase();
  const tmp = vec3.fromValues(centerCm.x, centerCm.y, 0);
  let best: { id: string; dist: number } | null = null;

  for (const node of graph.getObstacles()) {
    if (node.label.trim().toLowerCase() !== labelLc) continue;
    const dx = node.position[0] - tmp[0];
    const dy = node.position[1] - tmp[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= radiusCm && (best === null || d < best.dist)) {
      best = { id: node.id, dist: d };
    }
  }
  if (best) return best.id;

  // Mint a fresh id. Reserve "obj_<slug>_<n>" with the smallest n not in use.
  const slug = labelLc.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'obj';
  let n = 0;
  while (graph.getNode(`obj_${slug}_${n}`)) n++;
  return `obj_${slug}_${n}`;
}
