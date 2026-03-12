/**
 * Dream Simulator Tests — TextSceneSimulator + ScenarioRunner
 */

import { TextSceneSimulator, SCENARIOS, type DreamScenario } from '../../src/3_llmunix_memory/dream_simulator/text_scene';
import { encodeFrame, Opcode, formatHex } from '../../src/2_qwen_cerebellum/bytecode_compiler';

// =============================================================================
// TextSceneSimulator
// =============================================================================

describe('TextSceneSimulator', () => {
  const corridorScenario = SCENARIOS.find(s => s.id === 'corridor-target')!;

  test('initializes with correct starting pose', () => {
    const sim = new TextSceneSimulator(corridorScenario);
    const state = sim.getState();

    expect(state.x).toBe(corridorScenario.startPose.x);
    expect(state.y).toBe(corridorScenario.startPose.y);
    expect(state.heading).toBe(corridorScenario.startPose.heading);
    expect(state.motorRunning).toBe(false);
  });

  test('renderFrame returns a valid TextFrame', () => {
    const sim = new TextSceneSimulator(corridorScenario);
    const frame = sim.renderFrame();

    expect(frame.frameIndex).toBe(0);
    expect(frame.sceneText).toBeTruthy();
    expect(frame.sceneText.length).toBeGreaterThan(20);
    expect(frame.pose).toEqual({
      x: corridorScenario.startPose.x,
      y: corridorScenario.startPose.y,
      heading: corridorScenario.startPose.heading,
    });
    expect(frame.roomId).toBe('corridor');
    expect(frame.targetDistance).toBeGreaterThan(0);
    expect(frame.goalReached).toBe(false);
    expect(frame.collision).toBe(false);
  });

  test('scene text includes location info', () => {
    const sim = new TextSceneSimulator(corridorScenario);
    const frame = sim.renderFrame();

    expect(frame.sceneText).toContain('Long corridor');
  });

  test('scene text includes target when visible', () => {
    const sim = new TextSceneSimulator(corridorScenario);
    const frame = sim.renderFrame();

    // Robot starts facing north (heading=0), target is ahead
    expect(frame.sceneText).toContain('TARGET VISIBLE');
    expect(frame.sceneText).toContain('Red Cube');
  });

  test('MOVE_FORWARD advances robot position', () => {
    const sim = new TextSceneSimulator(corridorScenario);
    const initialState = sim.getState();

    const fwd = encodeFrame({ opcode: Opcode.MOVE_FORWARD, paramLeft: 128, paramRight: 128 });
    const frame = sim.step(fwd);

    expect(frame.pose.y).toBeGreaterThan(initialState.y);
    expect(frame.frameIndex).toBe(1);
  });

  test('ROTATE_CW changes heading', () => {
    const sim = new TextSceneSimulator(corridorScenario);

    const rotate = encodeFrame({ opcode: Opcode.ROTATE_CW, paramLeft: 90, paramRight: 128 });
    const frame = sim.step(rotate);

    expect(frame.pose.heading).toBeCloseTo(90, 0);
  });

  test('STOP sets motorRunning to false', () => {
    const sim = new TextSceneSimulator(corridorScenario);

    // Move forward first
    const fwd = encodeFrame({ opcode: Opcode.MOVE_FORWARD, paramLeft: 128, paramRight: 128 });
    sim.step(fwd);
    expect(sim.getState().motorRunning).toBe(true);

    // Then stop
    const stop = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
    sim.step(stop);
    expect(sim.getState().motorRunning).toBe(false);
  });

  test('goal reached when close to target', () => {
    // Create a scenario with robot very close to target
    const closeScenario: DreamScenario = {
      ...corridorScenario,
      startPose: { x: 0, y: 265, heading: 0 }, // 15cm from target at (0, 280)
      goalThresholdCm: 20,
    };

    const sim = new TextSceneSimulator(closeScenario);
    const frame = sim.renderFrame();

    expect(frame.targetDistance).toBeLessThan(20);
    expect(frame.goalReached).toBe(true);
  });

  test('collision detected near walls', () => {
    // Place robot right next to a wall
    const wallScenario: DreamScenario = {
      ...corridorScenario,
      startPose: { x: -25, y: 50, heading: 0 }, // 5cm from left wall at x=-30
    };

    const sim = new TextSceneSimulator(wallScenario);
    const frame = sim.renderFrame();

    expect(frame.collision).toBe(true);
    expect(frame.sceneText).toContain('WARNING');
  });

  test('frame count increments on each step', () => {
    const sim = new TextSceneSimulator(corridorScenario);
    expect(sim.getFrameCount()).toBe(0);

    const fwd = encodeFrame({ opcode: Opcode.MOVE_FORWARD, paramLeft: 64, paramRight: 64 });
    sim.step(fwd);
    expect(sim.getFrameCount()).toBe(1);

    sim.step(fwd);
    expect(sim.getFrameCount()).toBe(2);
  });

  test('multiple forward commands approach target', () => {
    const sim = new TextSceneSimulator(corridorScenario);
    const fwd = encodeFrame({ opcode: Opcode.MOVE_FORWARD, paramLeft: 255, paramRight: 255 });

    let lastDist = Infinity;
    for (let i = 0; i < 10; i++) {
      const frame = sim.step(fwd);
      if (frame.targetDistance !== null) {
        expect(frame.targetDistance).toBeLessThan(lastDist);
        lastDist = frame.targetDistance;
      }
    }
  });
});

// =============================================================================
// Scenarios Validation
// =============================================================================

describe('SCENARIOS', () => {
  test('all scenarios have required fields', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(5);

    for (const scenario of SCENARIOS) {
      expect(scenario.id).toBeTruthy();
      expect(scenario.title).toBeTruthy();
      expect(scenario.goal).toBeTruthy();
      expect(scenario.world.rooms.length).toBeGreaterThan(0);
      expect(scenario.world.walls.length).toBeGreaterThan(0);
      expect(scenario.maxFrames).toBeGreaterThan(0);
      expect(scenario.goalThresholdCm).toBeGreaterThan(0);
    }
  });

  test('all target objects exist in their worlds', () => {
    for (const scenario of SCENARIOS) {
      if (scenario.targetObjectId) {
        const target = scenario.world.objects.find(o => o.id === scenario.targetObjectId);
        expect(target).toBeDefined();
        expect(target!.isTarget).toBe(true);
      }
    }
  });

  test('each scenario can render an initial frame', () => {
    for (const scenario of SCENARIOS) {
      const sim = new TextSceneSimulator(scenario);
      const frame = sim.renderFrame();

      expect(frame.sceneText.length).toBeGreaterThan(0);
      expect(frame.frameIndex).toBe(0);
      expect(frame.goalReached).toBe(false);
    }
  });

  test('all scenario IDs are unique', () => {
    const ids = SCENARIOS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// =============================================================================
// Scene Description Quality
// =============================================================================

describe('Scene description quality', () => {
  test('room exploration scenario describes doorway', () => {
    const scenario = SCENARIOS.find(s => s.id === 'room-exploration')!;
    const sim = new TextSceneSimulator(scenario);

    // Rotate to face east (where the doorway is)
    const rotate = encodeFrame({ opcode: Opcode.ROTATE_CW, paramLeft: 90, paramRight: 128 });
    const frame = sim.step(rotate);

    // After rotating east, the doorway should be described
    expect(frame.sceneText).toContain('doorway');
  });

  test('obstacle avoidance scenario mentions obstacles', () => {
    const scenario = SCENARIOS.find(s => s.id === 'obstacle-avoidance')!;
    const sim = new TextSceneSimulator(scenario);
    const frame = sim.renderFrame();

    // Robot starts facing north, obstacles are ahead
    const hasObstacle = frame.sceneText.includes('box') ||
                        frame.sceneText.includes('Cardboard') ||
                        frame.sceneText.includes('crate') ||
                        frame.sceneText.includes('books');
    expect(hasObstacle).toBe(true);
  });

  test('path status is included in scene', () => {
    const scenario = SCENARIOS.find(s => s.id === 'corridor-target')!;
    const sim = new TextSceneSimulator(scenario);
    const frame = sim.renderFrame();

    const lowerScene = frame.sceneText.toLowerCase();
    const hasPathInfo = lowerScene.includes('clearance') ||
                        lowerScene.includes('clear') ||
                        lowerScene.includes('blocked');
    expect(hasPathInfo).toBe(true);
  });
});
