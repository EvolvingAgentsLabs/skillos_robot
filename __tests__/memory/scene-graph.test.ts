import * as fs from 'fs';
import * as path from 'path';
import {
  SceneNode,
  SceneGraph,
  aabbIntersect,
  DEFAULT_ROBOT_BBOX,
  type AABB,
  type SceneGraphJSON,
} from '../../src/brain/memory/scene_graph';

const TMP_DIR = path.join(__dirname, '..', '..', '.tmp-scene-graph');
const TMP_FILE = path.join(TMP_DIR, 'scene_graph.test.json');

function rmTmp(): void {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('SceneNode — heading & quaternion', () => {
  test('default rotation is identity (heading = 0°)', () => {
    const n = new SceneNode('a', 'A');
    expect(n.getHeadingDegrees()).toBeCloseTo(0, 4);
  });

  test('round-trips heading through the quaternion', () => {
    const n = new SceneNode('a', 'A');
    for (const deg of [0, 30, 45, 90, 135, 179, -30, -90, -179]) {
      n.setHeadingDegrees(deg);
      expect(n.getHeadingDegrees()).toBeCloseTo(deg, 3);
    }
  });

  test('heading 180° round-trips to ±180° (atan2 branch cut, both valid)', () => {
    const n = new SceneNode('a', 'A');
    n.setHeadingDegrees(180);
    const got = Math.abs(n.getHeadingDegrees());
    expect(got).toBeCloseTo(180, 3);
  });

  test('angular distance across the ±180° seam is short, not 340°', () => {
    // Rotating from 170° to -170° is a 20° rotation through 180°,
    // not a 340° rotation. Scalar heading subtraction would (incorrectly)
    // give 340°; the quaternion-derived angular distance gives 20°.
    const n = new SceneNode('a', 'A');
    n.setHeadingDegrees(170);
    const q1: [number, number, number, number] = [
      n.rotation[0], n.rotation[1], n.rotation[2], n.rotation[3],
    ];
    n.setHeadingDegrees(-170);
    const q2 = n.rotation;
    // Angle between two unit quaternions: 2 * acos(|dot|).
    // The absolute value handles the q ≡ -q ambiguity.
    const dot = q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3];
    const angleRad = 2 * Math.acos(Math.min(1, Math.abs(dot)));
    const angleDeg = (angleRad * 180) / Math.PI;
    expect(angleDeg).toBeCloseTo(20, 1);
  });
});

describe('SceneNode — world AABB', () => {
  test('untransformed unit-cube node has AABB = ±half-extents', () => {
    const n = new SceneNode('a', 'A', { boundingBox: { w: 10, h: 20, d: 6 } });
    const aabb = n.getWorldAABB();
    expect(aabb.min[0]).toBeCloseTo(-5, 4);
    expect(aabb.max[0]).toBeCloseTo(+5, 4);
    expect(aabb.min[1]).toBeCloseTo(-10, 4);
    expect(aabb.max[1]).toBeCloseTo(+10, 4);
    expect(aabb.min[2]).toBeCloseTo(-3, 4);
    expect(aabb.max[2]).toBeCloseTo(+3, 4);
  });

  test('translated node has AABB centered on translation', () => {
    const n = new SceneNode('a', 'A', {
      position: [100, 50, 0],
      boundingBox: { w: 10, h: 10, d: 10 },
    });
    const aabb = n.getWorldAABB();
    expect(aabb.min[0]).toBeCloseTo(95, 4);
    expect(aabb.max[0]).toBeCloseTo(105, 4);
    expect(aabb.min[1]).toBeCloseTo(45, 4);
    expect(aabb.max[1]).toBeCloseTo(55, 4);
  });

  test('45°-rotated square AABB grows by sqrt(2)', () => {
    // A 10×10 square rotated 45° has a world AABB of ~14.14 × ~14.14.
    const n = new SceneNode('a', 'A', {
      headingDegrees: 45,
      boundingBox: { w: 10, h: 10, d: 1 },
    });
    const aabb = n.getWorldAABB();
    const span = aabb.max[0] - aabb.min[0];
    expect(span).toBeCloseTo(10 * Math.SQRT2, 3);
  });

  test('scale is applied to the AABB', () => {
    const n = new SceneNode('a', 'A', {
      scale: [2, 1, 1],
      boundingBox: { w: 10, h: 10, d: 10 },
    });
    const aabb = n.getWorldAABB();
    expect(aabb.max[0] - aabb.min[0]).toBeCloseTo(20, 4);
    expect(aabb.max[1] - aabb.min[1]).toBeCloseTo(10, 4);
  });
});

describe('SceneNode — forward-swept AABB', () => {
  test('zero distance returns the static AABB', () => {
    const n = new SceneNode('a', 'A', { boundingBox: { w: 10, h: 10, d: 10 } });
    const a = n.getWorldAABB();
    const b = n.getForwardSweptAABB(0);
    expect(b.min[0]).toBeCloseTo(a.min[0], 4);
    expect(b.max[0]).toBeCloseTo(a.max[0], 4);
  });

  test('heading 0° extends the AABB along +X', () => {
    const n = new SceneNode('a', 'A', { boundingBox: { w: 10, h: 10, d: 10 } });
    const swept = n.getForwardSweptAABB(50);
    expect(swept.min[0]).toBeCloseTo(-5, 4);
    expect(swept.max[0]).toBeCloseTo(55, 4); // +5 (half-extent) + 50 (sweep)
    // Y dimension is unchanged.
    expect(swept.min[1]).toBeCloseTo(-5, 4);
    expect(swept.max[1]).toBeCloseTo(+5, 4);
  });

  test('heading 90° extends the AABB along +Y', () => {
    const n = new SceneNode('a', 'A', {
      headingDegrees: 90,
      boundingBox: { w: 10, h: 10, d: 10 },
    });
    const swept = n.getForwardSweptAABB(50);
    expect(swept.max[1]).toBeCloseTo(55, 3);
  });

  test('negative distance sweeps against the heading (backward)', () => {
    const n = new SceneNode('a', 'A', { boundingBox: { w: 10, h: 10, d: 10 } });
    // Heading 0° → +X. Backward sweep of 50 extends min[0] to -55.
    const swept = n.getForwardSweptAABB(-50);
    expect(swept.min[0]).toBeCloseTo(-55, 4);
    expect(swept.max[0]).toBeCloseTo(+5, 4); // unchanged on the +X side
  });

  test('zero distance returns the static AABB unchanged', () => {
    const n = new SceneNode('a', 'A', { boundingBox: { w: 10, h: 10, d: 10 } });
    const a = n.getWorldAABB();
    const b = n.getForwardSweptAABB(0);
    expect(b.min[0]).toBeCloseTo(a.min[0], 4);
    expect(b.max[0]).toBeCloseTo(a.max[0], 4);
  });
});

describe('aabbIntersect', () => {
  const a: AABB = { min: [0, 0, 0], max: [10, 10, 10] };

  test('overlapping boxes intersect', () => {
    expect(aabbIntersect(a, { min: [5, 5, 5], max: [15, 15, 15] })).toBe(true);
  });

  test('disjoint boxes do not intersect', () => {
    expect(aabbIntersect(a, { min: [20, 0, 0], max: [30, 10, 10] })).toBe(false);
  });

  test('touching faces count as intersection (closed intervals)', () => {
    expect(aabbIntersect(a, { min: [10, 0, 0], max: [20, 10, 10] })).toBe(true);
  });

  test('separation along any single axis disqualifies', () => {
    expect(aabbIntersect(a, { min: [0, 0, 11], max: [10, 10, 20] })).toBe(false);
  });
});

describe('SceneGraph — CRUD', () => {
  test('constructs with a robot node', () => {
    const g = new SceneGraph();
    expect(g.size()).toBe(1);
    expect(g.robot.id).toBe('roclaw');
    expect(g.robot.boundingBox).toEqual(DEFAULT_ROBOT_BBOX);
  });

  test('addOrUpdateNode adds, then mutates in place', () => {
    const g = new SceneGraph();
    const n1 = g.addOrUpdateNode({ id: 'cube', label: 'red cube', x: 100, y: 50 });
    expect(g.size()).toBe(2);
    expect(n1.position[0]).toBeCloseTo(100, 4);

    const n2 = g.addOrUpdateNode({ id: 'cube', label: 'red cube', x: 110, y: 50 });
    expect(g.size()).toBe(2);
    expect(n2).toBe(n1); // same instance
    expect(n2.position[0]).toBeCloseTo(110, 4);
  });

  test('refuses to overwrite the robot via addOrUpdateNode', () => {
    const g = new SceneGraph();
    expect(() =>
      g.addOrUpdateNode({ id: 'roclaw', label: 'imposter', x: 0, y: 0 })
    ).toThrow(/reserved/);
  });

  test('updateRobotPose moves the robot and sets heading', () => {
    const g = new SceneGraph();
    g.updateRobotPose(50, 25, 90);
    expect(g.robot.position[0]).toBeCloseTo(50, 4);
    expect(g.robot.position[1]).toBeCloseTo(25, 4);
    expect(g.robot.getHeadingDegrees()).toBeCloseTo(90, 3);
  });

  test('removeNode removes obstacles but never the robot', () => {
    const g = new SceneGraph();
    g.addOrUpdateNode({ id: 'cube', label: 'red cube', x: 0, y: 0 });
    expect(g.removeNode('cube')).toBe(true);
    expect(g.removeNode('roclaw')).toBe(false);
    expect(g.size()).toBe(1);
  });

  test('getObstacles excludes the robot', () => {
    const g = new SceneGraph();
    g.addOrUpdateNode({ id: 'a', label: 'a', x: 0, y: 0 });
    g.addOrUpdateNode({ id: 'b', label: 'b', x: 10, y: 0 });
    const obs = g.getObstacles();
    expect(obs).toHaveLength(2);
    expect(obs.map(n => n.id).sort()).toEqual(['a', 'b']);
  });
});

describe('SceneGraph — collision queries', () => {
  test('predictForwardCollision returns null when path is clear', () => {
    const g = new SceneGraph();
    g.updateRobotPose(0, 0, 0); // facing +X
    g.addOrUpdateNode({
      id: 'far', label: 'far cube', x: 500, y: 500,
      boundingBox: { w: 10, h: 10, d: 10 },
    });
    expect(g.predictForwardCollision(50)).toBeNull();
  });

  test('predictForwardCollision detects an obstacle directly ahead', () => {
    const g = new SceneGraph();
    g.updateRobotPose(0, 0, 0); // facing +X
    g.addOrUpdateNode({
      id: 'wall', label: 'wall', x: 30, y: 0,
      boundingBox: { w: 5, h: 50, d: 10 },
    });
    const hit = g.predictForwardCollision(50);
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe('wall');
  });

  test('predictForwardCollision respects heading', () => {
    const g = new SceneGraph();
    g.updateRobotPose(0, 0, 90); // facing +Y now
    // Obstacle is along +X (where the robot used to be facing) — should NOT hit.
    g.addOrUpdateNode({
      id: 'side', label: 'side wall', x: 30, y: 0,
      boundingBox: { w: 5, h: 5, d: 10 },
    });
    expect(g.predictForwardCollision(50)).toBeNull();

    // Place an obstacle along +Y — should hit.
    g.addOrUpdateNode({
      id: 'ahead', label: 'wall', x: 0, y: 30,
      boundingBox: { w: 50, h: 5, d: 10 },
    });
    const hit = g.predictForwardCollision(50);
    expect(hit?.id).toBe('ahead');
  });

  test('intersectingNodes returns multiple hits', () => {
    const g = new SceneGraph();
    g.addOrUpdateNode({ id: 'a', label: 'a', x: 0, y: 0, boundingBox: { w: 10, h: 10, d: 10 } });
    g.addOrUpdateNode({ id: 'b', label: 'b', x: 5, y: 5, boundingBox: { w: 10, h: 10, d: 10 } });
    const probe: AABB = { min: [-3, -3, -3], max: [+3, +3, +3] };
    const hits = g.intersectingNodes(probe);
    expect(hits.map(n => n.id).sort()).toEqual(['a', 'b']);
  });
});

describe('SceneGraph — JSON serialization', () => {
  test('round-trips through JSON without losing information', () => {
    const g = new SceneGraph({ w: 12, h: 8, d: 4 });
    g.updateRobotPose(123.4, -56.7, 42);
    g.addOrUpdateNode({
      id: 'cube', label: 'red cube', x: 100, y: 50, z: 5,
      boundingBox: { w: 7, h: 7, d: 7 },
      confidence: 0.83,
    });

    const json = g.toJSON();
    expect(json.version).toBe(1);
    expect(json.nodes).toHaveLength(2);

    const restored = SceneGraph.fromJSON(json);
    expect(restored.size()).toBe(2);
    expect(restored.robot.boundingBox).toEqual({ w: 12, h: 8, d: 4 });
    expect(restored.robot.position[0]).toBeCloseTo(123.4, 3);
    expect(restored.robot.position[1]).toBeCloseTo(-56.7, 3);
    expect(restored.robot.getHeadingDegrees()).toBeCloseTo(42, 2);

    const cube = restored.getNode('cube');
    expect(cube).toBeDefined();
    expect(cube?.position[0]).toBeCloseTo(100, 4);
    expect(cube?.position[1]).toBeCloseTo(50, 4);
    expect(cube?.position[2]).toBeCloseTo(5, 4);
    expect(cube?.confidence).toBeCloseTo(0.83, 4);
  });

  test('rejects unsupported version', () => {
    const bad: SceneGraphJSON = { version: 99 as 1, nodes: [] };
    expect(() => SceneGraph.fromJSON(bad)).toThrow(/version/);
  });

  test('quaternion serialization preserves rotation precisely', () => {
    const g = new SceneGraph();
    g.updateRobotPose(0, 0, 137.5);
    const restored = SceneGraph.fromJSON(g.toJSON());
    expect(restored.robot.getHeadingDegrees()).toBeCloseTo(137.5, 3);
  });
});

describe('SceneGraph — disk persistence', () => {
  beforeEach(rmTmp);
  afterEach(rmTmp);

  test('save then load round-trips through disk', () => {
    const g = new SceneGraph();
    g.updateRobotPose(10, 20, 45);
    g.addOrUpdateNode({ id: 'cube', label: 'red cube', x: 100, y: 50 });

    g.save(TMP_FILE);
    expect(fs.existsSync(TMP_FILE)).toBe(true);

    const loaded = SceneGraph.load(TMP_FILE);
    expect(loaded).not.toBeNull();
    expect(loaded?.size()).toBe(2);
    expect(loaded?.getNode('cube')?.label).toBe('red cube');
    expect(loaded?.robot.getHeadingDegrees()).toBeCloseTo(45, 3);
  });

  test('load returns null when the file is missing', () => {
    expect(SceneGraph.load(TMP_FILE)).toBeNull();
  });

  test('save creates the parent directory if it does not exist', () => {
    const nested = path.join(TMP_DIR, 'a', 'b', 'c', 'sg.json');
    const g = new SceneGraph();
    g.save(nested);
    expect(fs.existsSync(nested)).toBe(true);
  });
});
