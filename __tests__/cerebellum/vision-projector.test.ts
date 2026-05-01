import {
  projectBoxToArenaCm,
  projectGeminiObject,
  projectGeminiObjects,
  type ArenaConfig,
  type GeminiObject,
} from '../../src/brain/perception/vision_projector';
import { SceneGraph } from '../../src/brain/memory/scene_graph';

const ARENA_300x200: ArenaConfig = { widthCm: 300, heightCm: 200 };

describe('projectBoxToArenaCm — pure math', () => {
  test('full-image bbox covers the entire arena', () => {
    const r = projectBoxToArenaCm([0, 0, 1000, 1000], ARENA_300x200);
    expect(r.centerCm.x).toBeCloseTo(150, 4);
    expect(r.centerCm.y).toBeCloseTo(100, 4);
    expect(r.sizeCm.w).toBeCloseTo(300, 4);
    expect(r.sizeCm.h).toBeCloseTo(200, 4);
  });

  test('top-left quadrant maps to top-left of arena', () => {
    // [ymin=0, xmin=0, ymax=500, xmax=500] = top-left 50% × 50% of image
    const r = projectBoxToArenaCm([0, 0, 500, 500], ARENA_300x200);
    expect(r.centerCm.x).toBeCloseTo(75, 4);
    expect(r.centerCm.y).toBeCloseTo(50, 4);
    expect(r.sizeCm.w).toBeCloseTo(150, 4);
    expect(r.sizeCm.h).toBeCloseTo(100, 4);
  });

  test('center pixel maps to arena center', () => {
    // A 1-unit bbox at the image center.
    const r = projectBoxToArenaCm([499, 499, 501, 501], ARENA_300x200);
    expect(r.centerCm.x).toBeCloseTo(150, 1);
    expect(r.centerCm.y).toBeCloseTo(100, 1);
  });

  test('bottom-right corner maps to arena far corner', () => {
    const r = projectBoxToArenaCm([900, 900, 1000, 1000], ARENA_300x200);
    expect(r.centerCm.x).toBeCloseTo(285, 4);
    expect(r.centerCm.y).toBeCloseTo(190, 4);
  });

  test('swapped min/max is normalized (no negative sizes)', () => {
    const a = projectBoxToArenaCm([200, 100, 400, 300], ARENA_300x200);
    const b = projectBoxToArenaCm([400, 300, 200, 100], ARENA_300x200);
    expect(b.centerCm.x).toBeCloseTo(a.centerCm.x, 6);
    expect(b.centerCm.y).toBeCloseTo(a.centerCm.y, 6);
    expect(b.sizeCm.w).toBeCloseTo(a.sizeCm.w, 6);
    expect(b.sizeCm.h).toBeCloseTo(a.sizeCm.h, 6);
  });

  test('out-of-range coordinates are clamped to [0, 1000]', () => {
    const r = projectBoxToArenaCm([-50, -50, 1100, 1100], ARENA_300x200);
    expect(r.centerCm.x).toBeCloseTo(150, 4);
    expect(r.centerCm.y).toBeCloseTo(100, 4);
    expect(r.sizeCm.w).toBeCloseTo(300, 4);
    expect(r.sizeCm.h).toBeCloseTo(200, 4);
  });

  test('rejects non-positive arena dimensions', () => {
    expect(() => projectBoxToArenaCm([0, 0, 100, 100], { widthCm: 0, heightCm: 100 }))
      .toThrow(/widthCm/);
    expect(() => projectBoxToArenaCm([0, 0, 100, 100], { widthCm: 100, heightCm: -1 }))
      .toThrow(/heightCm/);
  });

  test('arena scale factor is independent in X and Y', () => {
    const arena: ArenaConfig = { widthCm: 1000, heightCm: 100 };
    const r = projectBoxToArenaCm([0, 0, 500, 500], arena);
    expect(r.sizeCm.w).toBeCloseTo(500, 4);  // 50% of 1000
    expect(r.sizeCm.h).toBeCloseTo(50, 4);   // 50% of 100
  });
});

describe('projectGeminiObject — SceneGraph integration', () => {
  test('adds a new obstacle node with arena coordinates', () => {
    const g = new SceneGraph();
    const obj: GeminiObject = { label: 'red cube', box_2d: [400, 200, 600, 400] };
    const node = projectGeminiObject(g, obj, ARENA_300x200);

    expect(g.size()).toBe(2); // robot + new node
    expect(node.label).toBe('red cube');
    // Image center is (xmin=200..xmax=400 → 300; ymin=400..ymax=600 → 500),
    // arena 300x200 → x = 300/1000*300 = 90; y = 500/1000*200 = 100
    expect(node.position[0]).toBeCloseTo(90, 3);
    expect(node.position[1]).toBeCloseTo(100, 3);
    // bbox size = 200x200 normalized = 60cm × 40cm
    expect(node.boundingBox.w).toBeCloseTo(60, 3);
    expect(node.boundingBox.h).toBeCloseTo(40, 3);
  });

  test('same-label detections within matchRadius update one node', () => {
    const g = new SceneGraph();
    const obj1: GeminiObject = { label: 'cube', box_2d: [400, 400, 500, 500] };
    const obj2: GeminiObject = { label: 'cube', box_2d: [410, 410, 510, 510] }; // ~3 cm shift
    const n1 = projectGeminiObject(g, obj1, ARENA_300x200);
    const xBefore = n1.position[0];
    const n2 = projectGeminiObject(g, obj2, ARENA_300x200);
    expect(g.size()).toBe(2); // robot + 1 obstacle
    expect(n1.id).toBe(n2.id);
    expect(n2).toBe(n1); // same instance, mutated in place
    expect(n2.position[0]).toBeGreaterThan(xBefore); // got updated, not duplicated
  });

  test('same-label detections outside matchRadius produce two nodes', () => {
    const g = new SceneGraph();
    projectGeminiObject(g, { label: 'cube', box_2d: [0, 0, 100, 100] }, ARENA_300x200);
    projectGeminiObject(g, { label: 'cube', box_2d: [800, 800, 1000, 1000] }, ARENA_300x200);
    expect(g.size()).toBe(3);
    const obstacles = g.getObstacles();
    expect(obstacles).toHaveLength(2);
    expect(obstacles[0].id).not.toBe(obstacles[1].id);
  });

  test('different labels never merge even at the same position', () => {
    const g = new SceneGraph();
    projectGeminiObject(g, { label: 'cube', box_2d: [400, 400, 500, 500] }, ARENA_300x200);
    projectGeminiObject(g, { label: 'sphere', box_2d: [400, 400, 500, 500] }, ARENA_300x200);
    expect(g.size()).toBe(3);
  });

  test('explicit id overrides the tracker', () => {
    const g = new SceneGraph();
    const n = projectGeminiObject(
      g,
      { label: 'thing', box_2d: [400, 400, 500, 500] },
      ARENA_300x200,
      { id: 'my_custom_id' },
    );
    expect(n.id).toBe('my_custom_id');
    expect(g.getNode('my_custom_id')).toBe(n);
  });

  test('confidence is recorded on the node', () => {
    const g = new SceneGraph();
    const n = projectGeminiObject(
      g,
      { label: 'cube', box_2d: [0, 0, 100, 100] },
      ARENA_300x200,
      { confidence: 0.42 },
    );
    expect(n.confidence).toBeCloseTo(0.42, 4);
  });

  test('id slugs sanitize spaces and punctuation', () => {
    const g = new SceneGraph();
    const n = projectGeminiObject(
      g,
      { label: 'Red Cube!', box_2d: [400, 400, 500, 500] },
      ARENA_300x200,
    );
    expect(n.id).toMatch(/^obj_red_cube_/);
  });
});

describe('projectGeminiObject — robot detection', () => {
  test('label "roclaw" updates graph.robot in place (no new node)', () => {
    const g = new SceneGraph();
    const obj: GeminiObject = { label: 'roclaw', box_2d: [400, 400, 600, 600] };
    const n = projectGeminiObject(g, obj, ARENA_300x200);
    expect(g.size()).toBe(1); // still just the robot
    expect(n).toBe(g.robot);
    // arena center
    expect(g.robot.position[0]).toBeCloseTo(150, 3);
    expect(g.robot.position[1]).toBeCloseTo(100, 3);
  });

  test('label match is case-insensitive and trims whitespace', () => {
    const g = new SceneGraph();
    projectGeminiObject(
      g,
      { label: '  RoClaw  ', box_2d: [400, 400, 600, 600] },
      ARENA_300x200,
    );
    expect(g.size()).toBe(1);
  });

  test('heading_estimate updates the robot heading', () => {
    const cases: Array<[GeminiObject['heading_estimate'], number]> = [
      ['RIGHT', 0],
      ['DOWN', 90],
      ['LEFT', 180],
      ['UP', -90],
    ];
    for (const [estimate, expectedDeg] of cases) {
      const g = new SceneGraph();
      projectGeminiObject(
        g,
        { label: 'roclaw', box_2d: [400, 400, 600, 600], heading_estimate: estimate },
        ARENA_300x200,
      );
      expect(Math.abs(g.robot.getHeadingDegrees())).toBeCloseTo(Math.abs(expectedDeg), 2);
    }
  });

  test('absent heading_estimate preserves prior robot heading', () => {
    const g = new SceneGraph();
    g.updateRobotPose(0, 0, 42);
    projectGeminiObject(
      g,
      { label: 'roclaw', box_2d: [400, 400, 600, 600] },
      ARENA_300x200,
    );
    expect(g.robot.getHeadingDegrees()).toBeCloseTo(42, 2);
  });

  test('custom robotLabels list overrides the default', () => {
    const g = new SceneGraph();
    projectGeminiObject(
      g,
      { label: 'roclaw', box_2d: [0, 0, 100, 100] },
      ARENA_300x200,
      { robotLabels: ['my_custom_robot_label'] },
    );
    // 'roclaw' is no longer a robot label → treated as obstacle
    expect(g.size()).toBe(2);
    expect(g.getObstacles()[0].label).toBe('roclaw');
  });
});

describe('projectGeminiObjects — bulk', () => {
  test('processes multiple detections in one call', () => {
    const g = new SceneGraph();
    const objs: GeminiObject[] = [
      { label: 'roclaw', box_2d: [400, 400, 600, 600], heading_estimate: 'RIGHT' },
      { label: 'red cube', box_2d: [100, 100, 200, 200] },
      { label: 'blue cube', box_2d: [800, 800, 900, 900] },
      { label: 'red cube', box_2d: [800, 100, 900, 200] }, // far from first red cube
    ];
    const nodes = projectGeminiObjects(g, objs, ARENA_300x200);
    expect(nodes).toHaveLength(4);
    expect(g.size()).toBe(4); // robot + 3 obstacles (two 'red cube' are far apart)
    expect(g.robot.getHeadingDegrees()).toBeCloseTo(0, 2);
  });

  test('end-to-end: robot can predict collision with a projected obstacle', () => {
    const g = new SceneGraph();
    // Robot at arena center, facing +X
    g.updateRobotPose(150, 100, 0);
    // Place a wall in the right half of the image, in front of the robot.
    projectGeminiObject(
      g,
      { label: 'wall', box_2d: [400, 600, 600, 700] },
      ARENA_300x200,
    );
    // Arena coordinates of that wall: center (195, 100), 30cm × 40cm
    // From robot at x=150, the wall starts ~30cm ahead. Sweep > 30 hits.
    const hit = g.predictForwardCollision(60);
    expect(hit?.label).toBe('wall');
    // A 10cm sweep is still in clear space.
    expect(g.predictForwardCollision(10)).toBeNull();
  });
});
