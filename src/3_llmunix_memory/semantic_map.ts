/**
 * Semantic Map — Topological Memory for Location-Aware Navigation
 *
 * Two layers:
 *   1. PoseMap: Simple pose→label store (persisted to JSON file).
 *      Used by the vision loop to record observations on the fly.
 *
 *   2. SemanticMap: VLM-powered topological graph for Navigation Chain of Thought.
 *      Nodes are locations identified by visual features; edges are navigation paths.
 *      Uses VLM inference for scene analysis, location matching, and navigation planning.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { InferenceFunction } from '../llmunix-core/interfaces';
import { parseJSONSafe } from '../llmunix-core/utils';
import { logger } from '../shared/logger';

// =============================================================================
// Types — PoseMap (simple pose→label storage)
// =============================================================================

export interface Pose {
  x: number;
  y: number;
  heading: number;
}

export interface SemanticMapEntry {
  /** Label describing what was observed (e.g., "kitchen", "sofa", "hallway") */
  label: string;
  /** Robot pose when the observation was made */
  pose: Pose;
  /** ISO timestamp */
  timestamp: string;
  /** Confidence score from VLM (0-1), if available */
  confidence?: number;
}

// =============================================================================
// Types — Spatial Features (Gemini bounding box grounding)
// =============================================================================

export interface SpatialFeature {
  /** Object label (e.g., "red cube", "door") */
  label: string;
  /** Bounding box in normalized 0-1000 coordinate system */
  bbox: { x: number; y: number; w: number; h: number };
  /** Center point computed from bbox */
  center: { x: number; y: number };
}

// =============================================================================
// Types — SemanticMap (VLM-powered topological graph)
// =============================================================================

export interface SemanticNode {
  id: string;
  label: string;
  description: string;
  features: string[];
  navigationHints: string[];
  visitCount: number;
  firstVisited: number;
  lastVisited: number;
  position?: { x: number; y: number; heading: number };
  featureFingerprint?: string;
  spatialFeatures?: SpatialFeature[];
}

export interface SemanticEdge {
  from: string;
  to: string;
  action: string;
  estimatedSteps: number;
  traversalCount: number;
  lastTraversed: number;
}

export interface SceneAnalysis {
  locationLabel: string;
  description: string;
  features: string[];
  navigationHints: string[];
  confidence: number;
  spatialFeatures?: SpatialFeature[];
}

export interface NavigationDecision {
  action: string;
  reasoning: string;
  confidence: number;
  motorCommand: string;
}

export interface LocationMatch {
  isSameLocation: boolean;
  confidence: number;
  reasoning: string;
}

// =============================================================================
// Prompts
// =============================================================================

const SCENE_ANALYSIS_SYSTEM = `You are a robot's spatial perception system. You analyze scenes and output structured JSON.

You will receive either a text description or actual camera images showing what the robot currently sees.
Analyze the scene and identify:
1. What type of location/room this is
2. Key visual features that identify this location
3. Visible exits, doors, or navigable paths

Output ONLY valid JSON (no markdown, no explanation) in this format:
{
  "locationLabel": "kitchen",
  "description": "A small kitchen with white cabinets and a gas stove",
  "features": ["white cabinets", "gas stove", "tile floor", "window above sink"],
  "navigationHints": ["doorway to the left leads to hallway", "open passage ahead"],
  "confidence": 0.85
}`;

const LOCATION_MATCH_SYSTEM = `You are a robot's place recognition system. You compare two scene descriptions and determine if they are the same physical location.

Consider that the robot may be viewing the same location from a different angle or at a different time.
Focus on permanent structural features (walls, doors, furniture) rather than transient details.

Output ONLY valid JSON (no markdown, no explanation):
{
  "isSameLocation": true,
  "confidence": 0.9,
  "reasoning": "Both scenes show the same kitchen with white cabinets and gas stove"
}`;

const SCENE_ANALYSIS_SPATIAL_SYSTEM = `You are a robot's spatial perception system with bounding box grounding. You analyze scenes and output structured JSON with spatial coordinates.

You will receive either a text description or actual camera images showing what the robot currently sees.
Analyze the scene and identify:
1. What type of location/room this is
2. Key visual features that identify this location
3. Visible exits, doors, or navigable paths
4. Bounding boxes for key objects in normalized 0-1000 coordinate system

Output ONLY valid JSON (no markdown, no explanation) in this format:
{
  "locationLabel": "kitchen",
  "description": "A small kitchen with white cabinets and a gas stove",
  "features": ["white cabinets", "gas stove", "tile floor", "window above sink"],
  "navigationHints": ["doorway to the left leads to hallway", "open passage ahead"],
  "confidence": 0.85,
  "spatialFeatures": [
    {"label": "gas stove", "bbox": {"x": 400, "y": 300, "w": 200, "h": 150}},
    {"label": "doorway", "bbox": {"x": 50, "y": 200, "w": 100, "h": 400}}
  ]
}`;

const NAVIGATION_SYSTEM = `You are a robot's navigation planner. Given the robot's current scene, its known map of locations, and a target destination, decide the best motor action.

The robot uses a 6-byte bytecode ISA:
- FORWARD LL RR: Move forward (left speed, right speed, 0-255)
- TURN_LEFT LL RR: Differential left turn
- TURN_RIGHT LL RR: Differential right turn
- STOP: Stop motors

Output ONLY valid JSON (no markdown, no explanation):
{
  "action": "TURN_LEFT 100 180",
  "reasoning": "The hallway leading to the kitchen is to the left",
  "confidence": 0.75,
  "motorCommand": "TURN_LEFT 100 180"
}`;

// parseJSONSafe imported from llmunix-core/utils (includes truncated JSON recovery)

// =============================================================================
// Feature Fingerprint — Fast pre-filter to avoid expensive VLM calls
// =============================================================================

/**
 * Generate a FNV-1a hash of sorted lowercase features.
 * Used as a fast fingerprint for feature set comparison.
 */
export function generateFeatureFingerprint(features: string[]): string {
  const sorted = features.map(f => f.toLowerCase().trim()).sort();
  const str = sorted.join('|');
  // FNV-1a 32-bit hash
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Compare two feature sets using Jaccard similarity (intersection / union).
 * Returns a value between 0 (no overlap) and 1 (identical sets).
 */
export function compareFeatureSets(a: string[], b: string[]): number {
  const setA = new Set(a.map(f => f.toLowerCase().trim()));
  const setB = new Set(b.map(f => f.toLowerCase().trim()));

  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// =============================================================================
// PoseMap — Simple pose→label storage (persisted to JSON)
// =============================================================================

const MAP_FILE = path.join(__dirname, 'traces', 'semantic_map.json');
const TOPO_MAP_FILE = path.join(__dirname, 'traces', 'topo_map.json');

export class PoseMap {
  private entries: SemanticMapEntry[] = [];

  constructor() {
    this.load();
  }

  /**
   * Record an observation at a given pose.
   * Deduplicates: if the same label exists within `mergeRadiusCm`,
   * it updates the existing entry instead of creating a duplicate.
   */
  record(label: string, pose: Pose, confidence?: number, mergeRadiusCm = 30): void {
    const normalized = label.toLowerCase().trim();

    // Check for nearby duplicate
    const existing = this.entries.find(e =>
      e.label === normalized && this.distance(e.pose, pose) < mergeRadiusCm
    );

    if (existing) {
      // Update with newer pose/timestamp if higher confidence
      if (confidence === undefined || (existing.confidence ?? 0) <= confidence) {
        existing.pose = { ...pose };
        existing.timestamp = new Date().toISOString();
        existing.confidence = confidence;
      }
    } else {
      this.entries.push({
        label: normalized,
        pose: { ...pose },
        timestamp: new Date().toISOString(),
        confidence,
      });
    }

    this.save();
    logger.debug('PoseMap', `Recorded "${normalized}" at (${pose.x.toFixed(1)}, ${pose.y.toFixed(1)})`);
  }

  /**
   * Query the map for entries matching a location description.
   * Returns all entries whose label contains any of the query keywords.
   */
  query(description: string): SemanticMapEntry[] {
    const keywords = description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (keywords.length === 0) return [];

    return this.entries.filter(e =>
      keywords.some(kw => e.label.includes(kw))
    );
  }

  /**
   * Find the single closest matching entry for a location description.
   * Returns null if no matches found.
   */
  findNearest(description: string, fromPose?: Pose): SemanticMapEntry | null {
    const matches = this.query(description);
    if (matches.length === 0) return null;

    if (!fromPose) {
      // Return most recent match
      return matches.sort((a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )[0];
    }

    // Return closest match by Euclidean distance
    return matches.sort((a, b) =>
      this.distance(a.pose, fromPose) - this.distance(b.pose, fromPose)
    )[0];
  }

  /**
   * Get all entries in the map.
   */
  getAll(): SemanticMapEntry[] {
    return [...this.entries];
  }

  /**
   * Get a human-readable summary for injection into VLM context.
   */
  getSummary(): string {
    if (this.entries.length === 0) return 'No locations mapped yet.';

    const lines = this.entries.map(e =>
      `- "${e.label}" at pose (${e.pose.x.toFixed(1)}, ${e.pose.y.toFixed(1)}), heading ${e.pose.heading.toFixed(0)}°`
    );
    return `Known locations:\n${lines.join('\n')}`;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries = [];
    this.save();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private distance(a: Pose, b: Pose): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private load(): void {
    try {
      if (fs.existsSync(MAP_FILE)) {
        const raw = fs.readFileSync(MAP_FILE, 'utf-8');
        this.entries = JSON.parse(raw);
      }
    } catch {
      logger.warn('PoseMap', 'Failed to load semantic map, starting fresh');
      this.entries = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(MAP_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(MAP_FILE, JSON.stringify(this.entries, null, 2));
    } catch (err) {
      logger.error('PoseMap', 'Failed to save semantic map', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// =============================================================================
// SemanticMap — VLM-powered topological graph (Navigation Chain of Thought)
// =============================================================================

export class SemanticMap {
  private nodes: Map<string, SemanticNode> = new Map();
  private edges: SemanticEdge[] = [];
  private infer: InferenceFunction;
  private nextId = 0;
  private currentNodeId: string | null = null;

  constructor(inferFn: InferenceFunction) {
    this.infer = inferFn;
    this.load();
  }

  // ---------------------------------------------------------------------------
  // Scene Analysis
  // ---------------------------------------------------------------------------

  /**
   * Analyze a scene description and return structured location data.
   * Works with both text descriptions (simulated) and image-based inference.
   *
   * @param sceneDescription Text description of the scene (or prompt for image analysis)
   * @param images Optional base64-encoded images to pass to the VLM for direct vision analysis
   * @param options Optional settings: spatialGrounding requests bounding box data
   */
  async analyzeScene(
    sceneDescription: string,
    images?: string[],
    options?: { spatialGrounding?: boolean },
  ): Promise<SceneAnalysis | null> {
    const systemPrompt = options?.spatialGrounding
      ? SCENE_ANALYSIS_SPATIAL_SYSTEM
      : SCENE_ANALYSIS_SYSTEM;

    const response = await this.infer(
      systemPrompt,
      `The robot's camera currently sees:\n\n${sceneDescription}`,
      images,
    );

    const analysis = parseJSONSafe<SceneAnalysis & { spatialFeatures?: Array<{ label: string; bbox: { x: number; y: number; w: number; h: number } }> }>(response);
    if (!analysis) return null;

    // Compute center points for spatial features
    if (analysis.spatialFeatures) {
      analysis.spatialFeatures = analysis.spatialFeatures.map(sf => ({
        label: sf.label,
        bbox: sf.bbox,
        center: {
          x: sf.bbox.x + sf.bbox.w / 2,
          y: sf.bbox.y + sf.bbox.h / 2,
        },
      }));
    }

    return analysis;
  }

  // ---------------------------------------------------------------------------
  // Location Matching
  // ---------------------------------------------------------------------------

  /**
   * Determine if a new scene matches an existing node in the map.
   */
  async matchLocation(
    newScene: SceneAnalysis,
    candidate: SemanticNode,
  ): Promise<LocationMatch | null> {
    const prompt = [
      'Scene A (new observation):',
      `  Label: ${newScene.locationLabel}`,
      `  Description: ${newScene.description}`,
      `  Features: ${newScene.features.join(', ')}`,
      '',
      'Scene B (known location):',
      `  Label: ${candidate.label}`,
      `  Description: ${candidate.description}`,
      `  Features: ${candidate.features.join(', ')}`,
      '',
      'Are Scene A and Scene B the same physical location?',
    ].join('\n');

    const response = await this.infer(LOCATION_MATCH_SYSTEM, prompt);
    return parseJSONSafe<LocationMatch>(response);
  }

  // ---------------------------------------------------------------------------
  // Map Building
  // ---------------------------------------------------------------------------

  /**
   * Process a new scene: analyze it, match or create a node, and link edges.
   * Returns the node ID for the current location.
   *
   * @param sceneDescription Text description of the scene (or prompt for image analysis)
   * @param pose Optional robot pose at the time of observation
   * @param actionTaken Optional description of the action that brought the robot here
   * @param images Optional base64-encoded images to pass to the VLM for direct vision analysis
   */
  async processScene(
    sceneDescription: string,
    pose?: { x: number; y: number; heading: number },
    actionTaken?: string,
    images?: string[],
  ): Promise<{ nodeId: string; isNew: boolean; analysis: SceneAnalysis }> {
    const analysis = await this.analyzeScene(sceneDescription, images);
    if (!analysis) {
      throw new Error('Failed to analyze scene');
    }

    // Try to match against existing nodes (early exit on high-confidence match)
    // Uses Jaccard similarity pre-filter to skip obviously-different locations
    let bestMatch: { nodeId: string; confidence: number } | null = null;

    for (const [id, node] of this.nodes) {
      // Fast pre-filter: skip nodes with very different feature sets
      if (node.features.length > 0 && analysis.features.length > 0) {
        const similarity = compareFeatureSets(analysis.features, node.features);
        if (similarity < 0.15) {
          logger.debug('SemanticMap', `Skipping ${node.label} (Jaccard=${similarity.toFixed(2)})`);
          continue;
        }
      }

      try {
        const match = await this.matchLocation(analysis, node);
        if (match && match.isSameLocation && match.confidence > 0.6) {
          if (!bestMatch || match.confidence > bestMatch.confidence) {
            bestMatch = { nodeId: id, confidence: match.confidence };
          }
          // Early exit — high-confidence match means no need to check remaining nodes
          if (bestMatch.confidence >= 0.85) break;
        }
      } catch {
        // Individual match failure (e.g., VLM timeout) — skip this candidate
        // and continue checking others. Worst case: a duplicate node is created.
      }
    }

    const now = Date.now();
    let nodeId: string;
    let isNew: boolean;

    const fingerprint = generateFeatureFingerprint(analysis.features);

    if (bestMatch) {
      // Update existing node
      nodeId = bestMatch.nodeId;
      isNew = false;
      const node = this.nodes.get(nodeId)!;
      node.visitCount++;
      node.lastVisited = now;
      node.featureFingerprint = fingerprint;
      if (pose) node.position = pose;
      if (analysis.spatialFeatures) node.spatialFeatures = analysis.spatialFeatures;
    } else {
      // Create new node
      nodeId = `loc_${this.nextId++}`;
      isNew = true;
      this.nodes.set(nodeId, {
        id: nodeId,
        label: analysis.locationLabel,
        description: analysis.description,
        features: analysis.features,
        navigationHints: analysis.navigationHints,
        visitCount: 1,
        firstVisited: now,
        lastVisited: now,
        position: pose,
        featureFingerprint: fingerprint,
        ...(analysis.spatialFeatures ? { spatialFeatures: analysis.spatialFeatures } : {}),
      });
    }

    // Create edge from previous location
    if (this.currentNodeId && this.currentNodeId !== nodeId && actionTaken) {
      this.addEdge(this.currentNodeId, nodeId, actionTaken);
    }

    this.currentNodeId = nodeId;
    this.save();
    return { nodeId, isNew, analysis };
  }

  // ---------------------------------------------------------------------------
  // Navigation Planning
  // ---------------------------------------------------------------------------

  /**
   * Compute a directional hint from a spatial feature's bounding box center.
   * Returns "left", "right", "center", or null if target not found.
   */
  getSpatialNavigationHint(
    targetLabel: string,
    spatialFeatures: SpatialFeature[],
  ): string | null {
    const lower = targetLabel.toLowerCase();
    const match = spatialFeatures.find(sf =>
      sf.label.toLowerCase().includes(lower) || lower.includes(sf.label.toLowerCase()),
    );
    if (!match) return null;

    const cx = match.center.x;
    // In 0-1000 coordinate system: <333 = left, >666 = right, else center
    if (cx < 333) return `[SPATIAL] "${match.label}" is to the LEFT (x=${cx})`;
    if (cx > 666) return `[SPATIAL] "${match.label}" is to the RIGHT (x=${cx})`;
    return `[SPATIAL] "${match.label}" is CENTERED (x=${cx})`;
  }

  /**
   * Given the current scene and a target location label, decide the next action.
   * Optionally accepts strategy hints and constraints from the hierarchical planner.
   */
  async planNavigation(
    currentScene: string,
    targetLabel: string,
    strategyHint?: string,
    constraints?: string[],
  ): Promise<NavigationDecision | null> {
    const mapSummary = this.getMapSummary();
    const promptParts = [
      `Current scene: ${currentScene}`,
      '',
      `Target destination: ${targetLabel}`,
      '',
      'Known map:',
      mapSummary,
    ];

    if (strategyHint) {
      promptParts.push('', `Strategy hint: ${strategyHint}`);
    }
    if (constraints && constraints.length > 0) {
      promptParts.push('', 'Active constraints:', ...constraints.map(c => `- ${c}`));
    }

    // Inject spatial hint if current node has spatial features
    if (this.currentNodeId) {
      const currentNode = this.nodes.get(this.currentNodeId);
      if (currentNode?.spatialFeatures) {
        const hint = this.getSpatialNavigationHint(targetLabel, currentNode.spatialFeatures);
        if (hint) {
          promptParts.push('', `Spatial grounding: ${hint}`);
        }
      }
    }

    promptParts.push('', 'What motor action should the robot take to navigate toward the target?');
    const prompt = promptParts.join('\n');

    const response = await this.infer(NAVIGATION_SYSTEM, prompt);
    return parseJSONSafe<NavigationDecision>(response);
  }

  // ---------------------------------------------------------------------------
  // Graph Queries
  // ---------------------------------------------------------------------------

  getNode(id: string): SemanticNode | undefined {
    return this.nodes.get(id);
  }

  getAllNodes(): SemanticNode[] {
    return Array.from(this.nodes.values());
  }

  getEdges(): SemanticEdge[] {
    return [...this.edges];
  }

  getEdgesFrom(nodeId: string): SemanticEdge[] {
    return this.edges.filter(e => e.from === nodeId);
  }

  getEdgesTo(nodeId: string): SemanticEdge[] {
    return this.edges.filter(e => e.to === nodeId);
  }

  getNeighbors(nodeId: string): string[] {
    const neighbors = new Set<string>();
    for (const edge of this.edges) {
      if (edge.from === nodeId) neighbors.add(edge.to);
      if (edge.to === nodeId) neighbors.add(edge.from);
    }
    return Array.from(neighbors);
  }

  getCurrentNodeId(): string | null {
    return this.currentNodeId;
  }

  findNodeByLabel(label: string): SemanticNode | undefined {
    const lower = label.toLowerCase();
    for (const node of this.nodes.values()) {
      if (node.label.toLowerCase().includes(lower)) return node;
    }
    return undefined;
  }

  /**
   * BFS shortest path between two nodes.
   */
  findPath(fromId: string, toId: string): string[] | null {
    if (fromId === toId) return [fromId];
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;

    const visited = new Set<string>();
    const queue: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];
    visited.add(fromId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of this.getNeighbors(current.id)) {
        if (neighbor === toId) return [...current.path, neighbor];
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ id: neighbor, path: [...current.path, neighbor] });
        }
      }
    }

    return null;
  }

  getMapSummary(): string {
    if (this.nodes.size === 0) return '(empty map)';

    const lines: string[] = [];
    lines.push(`Locations (${this.nodes.size}):`);
    for (const node of this.nodes.values()) {
      const exits = this.getEdgesFrom(node.id)
        .map(e => this.nodes.get(e.to)?.label || e.to)
        .join(', ');
      lines.push(`  - ${node.label} [${node.id}]: ${node.description}`);
      if (node.navigationHints.length > 0) {
        lines.push(`    Exits: ${node.navigationHints.join('; ')}`);
      }
      if (exits) {
        lines.push(`    Connected to: ${exits}`);
      }
    }
    return lines.join('\n');
  }

  getStats() {
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
      currentNodeId: this.currentNodeId,
    };
  }

  // ---------------------------------------------------------------------------
  // Serialization (for LLMunix memory persistence)
  // ---------------------------------------------------------------------------

  toJSON(): { nodes: SemanticNode[]; edges: SemanticEdge[]; currentNodeId: string | null } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
      currentNodeId: this.currentNodeId,
    };
  }

  loadFromJSON(data: { nodes: SemanticNode[]; edges: SemanticEdge[]; currentNodeId?: string | null }): void {
    this.nodes.clear();
    this.edges = [];
    for (const node of data.nodes) {
      this.nodes.set(node.id, node);
      const idNum = parseInt(node.id.replace('loc_', ''), 10);
      if (!isNaN(idNum) && idNum >= this.nextId) this.nextId = idNum + 1;
    }
    this.edges = data.edges;
    this.currentNodeId = data.currentNodeId ?? null;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private load(): void {
    try {
      if (fs.existsSync(TOPO_MAP_FILE)) {
        const raw = fs.readFileSync(TOPO_MAP_FILE, 'utf-8');
        const data = JSON.parse(raw);
        this.loadFromJSON(data);
      }
    } catch {
      logger.warn('SemanticMap', 'Failed to load topo map, starting fresh');
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(TOPO_MAP_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(TOPO_MAP_FILE, JSON.stringify(this.toJSON(), null, 2));
    } catch (err) {
      logger.error('SemanticMap', 'Failed to save topo map', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private addEdge(fromId: string, toId: string, action: string, steps = 0): void {
    // Check if edge already exists
    const existing = this.edges.find(e => e.from === fromId && e.to === toId);
    if (existing) {
      existing.traversalCount++;
      existing.lastTraversed = Date.now();
      return;
    }

    this.edges.push({
      from: fromId,
      to: toId,
      action,
      estimatedSteps: steps,
      traversalCount: 1,
      lastTraversed: Date.now(),
    });
  }
}
