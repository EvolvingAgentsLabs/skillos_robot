import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { SceneGraph } from '../../src/3_llmunix_memory/scene_graph';
import {
  serializeSceneGraph,
  countCollisionPredictions,
} from '../../src/3_llmunix_memory/roclaw_dream_adapter';
import { Sim3DTraceCollector } from '../../src/3_llmunix_memory/sim3d_trace_collector';

// =============================================================================
// serializeSceneGraph
// =============================================================================

describe('serializeSceneGraph', () => {
  test('empty graph (just robot) contains "roclaw" in output', () => {
    const graph = new SceneGraph();
    const output = serializeSceneGraph(graph);
    expect(output.toLowerCase()).toContain('roclaw');
  });

  test('graph with obstacles produces a markdown table with correct headers', () => {
    const graph = new SceneGraph();
    graph.addOrUpdateNode({ id: 'cube', label: 'red cube', x: 100, y: 50 });
    graph.addOrUpdateNode({ id: 'wall', label: 'wall', x: 200, y: 0 });

    const output = serializeSceneGraph(graph);
    // Verify the header row and separator row
    expect(output).toContain('| Node |');
    expect(output).toContain('| Label |');
    expect(output).toContain('| X (cm) |');
    expect(output).toContain('| Y (cm) |');
    expect(output).toContain('| Heading');
    expect(output).toContain('| BBox');
    expect(output).toContain('| Confidence |');
    expect(output).toContain('|------|');
  });

  test('table includes correct position values', () => {
    const graph = new SceneGraph();
    graph.updateRobotPose(45, 100, 0);
    graph.addOrUpdateNode({ id: 'cube', label: 'red cube', x: 123.4, y: -56.7 });

    const output = serializeSceneGraph(graph);
    // Robot position
    expect(output).toContain('45.0');
    expect(output).toContain('100.0');
    // Obstacle position
    expect(output).toContain('123.4');
    expect(output).toContain('-56.7');
  });

  test('table includes heading and bounding box dimensions', () => {
    const graph = new SceneGraph();
    graph.updateRobotPose(0, 0, 90);
    graph.addOrUpdateNode({
      id: 'box',
      label: 'cardboard box',
      x: 50,
      y: 50,
      boundingBox: { w: 20, h: 15, d: 10 },
    });

    const output = serializeSceneGraph(graph);
    const lines = output.split('\n');

    // Find the robot row — heading should be 90.0
    const robotRow = lines.find(l => l.includes('roclaw'));
    expect(robotRow).toBeDefined();
    expect(robotRow).toContain('90.0');

    // Find the box row — bounding box should be 20x15x10
    const boxRow = lines.find(l => l.includes('box'));
    expect(boxRow).toBeDefined();
    expect(boxRow).toContain('20');
    expect(boxRow).toContain('15');
    expect(boxRow).toContain('10');
  });
});

// =============================================================================
// countCollisionPredictions
// =============================================================================

describe('countCollisionPredictions', () => {
  test('no obstacles returns 0', () => {
    const graph = new SceneGraph();
    graph.updateRobotPose(0, 0, 0);
    expect(countCollisionPredictions(graph)).toBe(0);
  });

  test('obstacle directly ahead within range returns 1', () => {
    const graph = new SceneGraph();
    graph.updateRobotPose(0, 0, 0); // facing +X
    graph.addOrUpdateNode({
      id: 'wall',
      label: 'wall',
      x: 20,
      y: 0,
      boundingBox: { w: 5, h: 50, d: 10 },
    });
    // Default distanceCm is 30, wall at x=20 is within that sweep
    expect(countCollisionPredictions(graph)).toBe(1);
  });

  test('obstacle far away returns 0', () => {
    const graph = new SceneGraph();
    graph.updateRobotPose(0, 0, 0); // facing +X
    graph.addOrUpdateNode({
      id: 'far',
      label: 'far cube',
      x: 500,
      y: 500,
      boundingBox: { w: 10, h: 10, d: 10 },
    });
    // Default 30cm sweep should not reach (500, 500)
    expect(countCollisionPredictions(graph)).toBe(0);
  });

  test('multiple obstacles ahead returns correct count', () => {
    const graph = new SceneGraph();
    graph.updateRobotPose(0, 0, 0); // facing +X

    // Place two obstacles directly in the forward path
    graph.addOrUpdateNode({
      id: 'near-wall',
      label: 'near wall',
      x: 15,
      y: 0,
      boundingBox: { w: 5, h: 30, d: 10 },
    });
    graph.addOrUpdateNode({
      id: 'mid-wall',
      label: 'mid wall',
      x: 25,
      y: 0,
      boundingBox: { w: 5, h: 30, d: 10 },
    });

    // Place one obstacle off to the side (should not be counted)
    graph.addOrUpdateNode({
      id: 'side-cube',
      label: 'side cube',
      x: 0,
      y: 200,
      boundingBox: { w: 5, h: 5, d: 5 },
    });

    // Default 30cm sweep: both walls should be hit, side cube should not
    expect(countCollisionPredictions(graph)).toBe(2);
  });
});

// =============================================================================
// Sim3DTraceCollector scene-graph integration
// =============================================================================

describe('Sim3DTraceCollector — scene-graph integration', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = '/tmp/test-traces-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    tmpDirs.push(dir);
    return dir;
  }

  afterAll(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test('setSceneGraph stores reference without error', () => {
    const collector = new Sim3DTraceCollector({ tracesDir: makeTmpDir() });
    const graph = new SceneGraph();
    graph.addOrUpdateNode({ id: 'cube', label: 'red cube', x: 50, y: 30 });

    // Should not throw
    expect(() => collector.setSceneGraph(graph)).not.toThrow();
  });

  test('writeTrace with sceneGraph includes scene_nodes in YAML frontmatter', () => {
    const tracesDir = makeTmpDir();
    const collector = new Sim3DTraceCollector({ tracesDir });

    // Set up a scene graph with two obstacles
    const graph = new SceneGraph();
    graph.updateRobotPose(0, 0, 0);
    graph.addOrUpdateNode({ id: 'cube', label: 'red cube', x: 50, y: 0 });
    graph.addOrUpdateNode({ id: 'wall', label: 'wall', x: 100, y: 0 });
    collector.setSceneGraph(graph);

    // Mock a VisionLoop with EventEmitter
    const mockVisionLoop = new EventEmitter() as any;

    // Attach the collector
    collector.attach(mockVisionLoop, 'navigate to the red cube');

    // Emit a bytecode event to produce at least one frame
    const fakeBytecode = Buffer.from('aabbccdd', 'hex');
    mockVisionLoop.emit('bytecode', fakeBytecode, 'FORWARD');

    // Emit an arrival event to trigger a scene-graph snapshot
    mockVisionLoop.emit('arrival', 'arrived');

    // Detach and write
    collector.detach(mockVisionLoop);
    const tracePath = collector.writeTrace();

    expect(tracePath).not.toBeNull();
    expect(fs.existsSync(tracePath!)).toBe(true);

    const content = fs.readFileSync(tracePath!, 'utf-8');

    // The YAML frontmatter should contain scene_nodes
    // Extract frontmatter between the first pair of ---
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    const frontmatter = fmMatch![1];
    expect(frontmatter).toContain('scene_nodes');

    // scene_nodes should be 2 (the two obstacles we added, robot excluded)
    expect(frontmatter).toContain('scene_nodes: 2');
  });
});
