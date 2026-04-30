/**
 * SceneGraph — 3D Spatial Memory for the Hierarchical Multi-Rate Spatial-Semantic Engine
 *
 * Sits alongside the topological SemanticMap (which captures *what* is connected to *what*)
 * and provides a 3D geometric layer (where things are in metric space). Used by:
 *
 *   1. The Reflex Loop (~30 Hz, RoClaw-side) — forward-collision prediction
 *      against known obstacles before motor commands leave the UDP transmitter.
 *
 *   2. The Perception Loop (~2 Hz, Gemini Robotics-ER 1.6) — receives normalized
 *      [ymin, xmin, ymax, xmax] bounding boxes from the overhead camera and
 *      projects them into metric coordinates via vision_projector.ts.
 *
 *   3. The Cognitive Loop (~0.1 Hz, planner) — serializes the graph to JSON
 *      and feeds it to a high-thinking model that returns waypoints.
 *
 *   4. The Dream Loop (offline, RoClawDreamAdapter) — clusters and merges
 *      duplicate nodes accumulated from odometry drift.
 *
 * Persistence is *opt-in* — call save()/load() explicitly. The reflex loop
 * mutates this graph many times per second; we never want to hit disk on
 * every update. PoseMap (semantic_map.ts) is the auto-persisting counterpart.
 *
 * All linear units are centimeters; rotations are stored as quaternions to
 * avoid Euler wrap-around bugs (e.g. heading jumping 359° → 0°).
 */

import * as fs from 'fs';
import * as path from 'path';
import { vec3, quat, mat4 } from 'gl-matrix';
import { logger } from '../../shared/logger';

// =============================================================================
// Types
// =============================================================================

/** Local-frame bounding box dimensions in centimeters. */
export interface BoundingBox {
  /** Width — extent along local X axis (forward) */
  w: number;
  /** Height — extent along local Y axis (left/right) */
  h: number;
  /** Depth — extent along local Z axis (up) */
  d: number;
}

/** Axis-aligned bounding box in world frame. Two corner points. */
export interface AABB {
  min: [number, number, number];
  max: [number, number, number];
}

export interface SceneNodeOptions {
  position?: [number, number, number];
  /** Heading in degrees around the Z (up) axis. */
  headingDegrees?: number;
  scale?: [number, number, number];
  boundingBox?: BoundingBox;
  confidence?: number;
  lastSeen?: string;
}

export interface SceneNodeJSON {
  id: string;
  label: string;
  position: [number, number, number];
  /** Quaternion as [x, y, z, w] (gl-matrix convention). */
  rotation: [number, number, number, number];
  scale: [number, number, number];
  boundingBox: BoundingBox;
  confidence: number;
  lastSeen: string;
}

export interface SceneGraphJSON {
  version: 1;
  nodes: SceneNodeJSON[];
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * RoClaw chassis dimensions from sim/roclaw_robot.xml:
 *   chassis box "0.075 0.05 0.025" → 15cm × 10cm × 5cm
 */
export const DEFAULT_ROBOT_BBOX: BoundingBox = { w: 15, h: 10, d: 5 };

/** Default obstacle box used by the projector when Gemini gives a bbox area only. */
export const DEFAULT_OBSTACLE_BBOX: BoundingBox = { w: 10, h: 10, d: 10 };

/** Default scene graph file (sibling of semantic_map.json / topo_map.json). */
const SCENE_GRAPH_FILE = path.join(__dirname, 'traces', 'scene_graph.json');

// =============================================================================
// SceneNode
// =============================================================================

export class SceneNode {
  public readonly id: string;
  public label: string;
  public position: vec3;
  public rotation: quat;
  public scale: vec3;
  public boundingBox: BoundingBox;
  public confidence: number;
  public lastSeen: string;

  constructor(id: string, label: string, opts: SceneNodeOptions = {}) {
    this.id = id;
    this.label = label;
    const p = opts.position ?? [0, 0, 0];
    this.position = vec3.fromValues(p[0], p[1], p[2]);
    this.rotation = quat.create(); // identity
    if (opts.headingDegrees !== undefined) {
      this.setHeadingDegrees(opts.headingDegrees);
    }
    const s = opts.scale ?? [1, 1, 1];
    this.scale = vec3.fromValues(s[0], s[1], s[2]);
    this.boundingBox = opts.boundingBox ?? { ...DEFAULT_OBSTACLE_BBOX };
    this.confidence = opts.confidence ?? 1.0;
    this.lastSeen = opts.lastSeen ?? new Date().toISOString();
  }

  // ---------------------------------------------------------------------------
  // Heading (Z-axis rotation, the only DOF the differential-drive chassis has)
  // ---------------------------------------------------------------------------

  /**
   * Set heading in degrees around the world Z axis.
   * 0° points along +X; 90° along +Y. Internally converted to a quaternion.
   */
  setHeadingDegrees(deg: number): void {
    quat.fromEuler(this.rotation, 0, 0, deg);
  }

  /**
   * Read the Z-axis yaw from the quaternion.
   * Returns degrees in (-180, 180]. Use this rather than storing a scalar
   * heading externally — quaternions don't suffer wrap-around at the seam.
   */
  getHeadingDegrees(): number {
    const x = this.rotation[0];
    const y = this.rotation[1];
    const z = this.rotation[2];
    const w = this.rotation[3];
    // Yaw extraction (rotation around Z) from a quaternion.
    const sinyCosp = 2 * (w * z + x * y);
    const cosyCosp = 1 - 2 * (y * y + z * z);
    return (Math.atan2(sinyCosp, cosyCosp) * 180) / Math.PI;
  }

  // ---------------------------------------------------------------------------
  // Transforms & bounding volumes
  // ---------------------------------------------------------------------------

  /** Compose the local→world TRS matrix. Pass `out` to avoid an allocation. */
  getTransformMatrix(out?: mat4): mat4 {
    const m = out ?? mat4.create();
    return mat4.fromRotationTranslationScale(m, this.rotation, this.position, this.scale);
  }

  /**
   * Compute the world-frame AABB that encloses this node's (possibly rotated)
   * oriented bounding box. Used by collision queries.
   *
   * For a rotation around Z only, this is conservative — the AABB grows
   * by the diagonal of the in-plane footprint. That over-estimation is a
   * feature for the reflex loop: we'd rather brake one frame early than
   * one frame late.
   */
  getWorldAABB(): AABB {
    // Local pre-scale half-extents. The TRS matrix applies scale internally.
    const hx = this.boundingBox.w / 2;
    const hy = this.boundingBox.h / 2;
    const hz = this.boundingBox.d / 2;

    const corners: [number, number, number][] = [
      [+hx, +hy, +hz], [+hx, +hy, -hz], [+hx, -hy, +hz], [+hx, -hy, -hz],
      [-hx, +hy, +hz], [-hx, +hy, -hz], [-hx, -hy, +hz], [-hx, -hy, -hz],
    ];

    const m = this.getTransformMatrix();
    const tmp = vec3.create();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const c of corners) {
      vec3.set(tmp, c[0], c[1], c[2]);
      vec3.transformMat4(tmp, tmp, m); // applies S, then R, then T
      if (tmp[0] < minX) minX = tmp[0];
      if (tmp[1] < minY) minY = tmp[1];
      if (tmp[2] < minZ) minZ = tmp[2];
      if (tmp[0] > maxX) maxX = tmp[0];
      if (tmp[1] > maxY) maxY = tmp[1];
      if (tmp[2] > maxZ) maxZ = tmp[2];
    }

    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  }

  /**
   * Return a *forward-extended* AABB: the swept volume produced by translating
   * this node's footprint along its current heading by `distanceCm`.
   *
   * Sign convention: positive = sweep along the heading direction,
   * negative = sweep against it (backward). Zero returns the static AABB.
   *
   * Intended for the robot node — the reflex loop calls this to ask
   * "if I move this far in this direction, will I hit anything?" without
   * needing a physics integrator.
   */
  getForwardSweptAABB(distanceCm: number): AABB {
    const current = this.getWorldAABB();
    if (distanceCm === 0) return current;

    const headingRad = (this.getHeadingDegrees() * Math.PI) / 180;
    const dx = Math.cos(headingRad) * distanceCm;
    const dy = Math.sin(headingRad) * distanceCm;

    return {
      min: [
        Math.min(current.min[0], current.min[0] + dx),
        Math.min(current.min[1], current.min[1] + dy),
        current.min[2],
      ],
      max: [
        Math.max(current.max[0], current.max[0] + dx),
        Math.max(current.max[1], current.max[1] + dy),
        current.max[2],
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  toJSON(): SceneNodeJSON {
    return {
      id: this.id,
      label: this.label,
      position: [this.position[0], this.position[1], this.position[2]],
      rotation: [this.rotation[0], this.rotation[1], this.rotation[2], this.rotation[3]],
      scale: [this.scale[0], this.scale[1], this.scale[2]],
      boundingBox: { ...this.boundingBox },
      confidence: this.confidence,
      lastSeen: this.lastSeen,
    };
  }

  static fromJSON(j: SceneNodeJSON): SceneNode {
    const node = new SceneNode(j.id, j.label, {
      position: j.position,
      scale: j.scale,
      boundingBox: j.boundingBox,
      confidence: j.confidence,
      lastSeen: j.lastSeen,
    });
    quat.set(node.rotation, j.rotation[0], j.rotation[1], j.rotation[2], j.rotation[3]);
    return node;
  }
}

// =============================================================================
// SceneGraph
// =============================================================================

export class SceneGraph {
  private readonly nodes = new Map<string, SceneNode>();
  public readonly robot: SceneNode;

  constructor(robotBoundingBox: BoundingBox = DEFAULT_ROBOT_BBOX) {
    this.robot = new SceneNode('roclaw', 'RoClaw Robot', { boundingBox: robotBoundingBox });
    this.nodes.set(this.robot.id, this.robot);
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  addOrUpdateNode(args: {
    id: string;
    label: string;
    x: number;
    y: number;
    z?: number;
    boundingBox?: BoundingBox;
    confidence?: number;
  }): SceneNode {
    if (args.id === this.robot.id) {
      throw new Error(
        `SceneGraph: id "${this.robot.id}" is reserved for the robot. ` +
        `Use updateRobotPose() instead.`
      );
    }
    let node = this.nodes.get(args.id);
    if (!node) {
      node = new SceneNode(args.id, args.label, {
        position: [args.x, args.y, args.z ?? 0],
        boundingBox: args.boundingBox,
        confidence: args.confidence,
      });
      this.nodes.set(args.id, node);
    } else {
      node.label = args.label;
      vec3.set(node.position, args.x, args.y, args.z ?? node.position[2]);
      if (args.boundingBox) node.boundingBox = args.boundingBox;
      if (args.confidence !== undefined) node.confidence = args.confidence;
      node.lastSeen = new Date().toISOString();
    }
    return node;
  }

  /** Update the robot's pose. Heading is in degrees (Z-axis yaw). */
  updateRobotPose(x: number, y: number, headingDegrees: number, z: number = 0): void {
    vec3.set(this.robot.position, x, y, z);
    this.robot.setHeadingDegrees(headingDegrees);
    this.robot.lastSeen = new Date().toISOString();
  }

  getNode(id: string): SceneNode | undefined {
    return this.nodes.get(id);
  }

  getAllNodes(): SceneNode[] {
    return Array.from(this.nodes.values());
  }

  /** All nodes except the robot — convenience for collision queries. */
  getObstacles(): SceneNode[] {
    return this.getAllNodes().filter(n => n.id !== this.robot.id);
  }

  removeNode(id: string): boolean {
    if (id === this.robot.id) return false;
    return this.nodes.delete(id);
  }

  size(): number {
    return this.nodes.size;
  }

  // ---------------------------------------------------------------------------
  // Spatial queries
  // ---------------------------------------------------------------------------

  /**
   * Return all obstacle nodes whose world AABB intersects `box`.
   * The robot is never included.
   */
  intersectingNodes(box: AABB): SceneNode[] {
    const hits: SceneNode[] = [];
    for (const n of this.getObstacles()) {
      if (aabbIntersect(box, n.getWorldAABB())) hits.push(n);
    }
    return hits;
  }

  /**
   * Forward-collision prediction for the Reflex Loop.
   *
   * Asks: "if the robot translates `distanceCm` along its current heading,
   * does the swept AABB intersect any obstacle?" Returns the first hit,
   * or null if the path is clear.
   *
   * This is the single primitive that lets the Reflex Loop veto a bytecode
   * before it's transmitted, no LLM round-trip required.
   */
  predictForwardCollision(distanceCm: number): SceneNode | null {
    const swept = this.robot.getForwardSweptAABB(distanceCm);
    for (const n of this.getObstacles()) {
      if (aabbIntersect(swept, n.getWorldAABB())) return n;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Serialization & persistence
  // ---------------------------------------------------------------------------

  toJSON(): SceneGraphJSON {
    return {
      version: 1,
      nodes: this.getAllNodes().map(n => n.toJSON()),
    };
  }

  /**
   * Hydrate a SceneGraph from a previously serialized JSON dump.
   * If a node with id "roclaw" is present in the dump, it overrides the
   * default robot node (preserving its bounding box and last-known pose).
   */
  static fromJSON(j: SceneGraphJSON): SceneGraph {
    if (j.version !== 1) {
      throw new Error(`SceneGraph: unsupported version ${j.version}`);
    }
    const robotJson = j.nodes.find(n => n.id === 'roclaw');
    const graph = new SceneGraph(robotJson?.boundingBox ?? DEFAULT_ROBOT_BBOX);
    for (const nj of j.nodes) {
      if (nj.id === 'roclaw') {
        // Replace the freshly created robot in place to preserve identity.
        const restored = SceneNode.fromJSON(nj);
        vec3.copy(graph.robot.position, restored.position);
        quat.copy(graph.robot.rotation, restored.rotation);
        vec3.copy(graph.robot.scale, restored.scale);
        graph.robot.label = restored.label;
        graph.robot.boundingBox = restored.boundingBox;
        graph.robot.confidence = restored.confidence;
        graph.robot.lastSeen = restored.lastSeen;
      } else {
        graph.nodes.set(nj.id, SceneNode.fromJSON(nj));
      }
    }
    return graph;
  }

  /** Write the graph to disk. Opt-in — never auto-called by mutators. */
  save(filePath: string = SCENE_GRAPH_FILE): void {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(this.toJSON(), null, 2));
    } catch (err) {
      logger.error('SceneGraph', 'Failed to save scene graph', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Load a graph from disk. Returns null if the file is absent or invalid. */
  static load(filePath: string = SCENE_GRAPH_FILE): SceneGraph | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as SceneGraphJSON;
      return SceneGraph.fromJSON(parsed);
    } catch (err) {
      logger.warn('SceneGraph', 'Failed to load scene graph; returning null', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

// =============================================================================
// Free helpers
// =============================================================================

/** Standard AABB-vs-AABB overlap. Touching boxes (shared face) count as overlap. */
export function aabbIntersect(a: AABB, b: AABB): boolean {
  return (
    a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] && a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] && a.max[2] >= b.min[2]
  );
}
