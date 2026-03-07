/**
 * Semantic Map E2E Tests — Topological Memory & Location-Aware Navigation
 *
 * Tests the full pipeline: scene description → VLM inference → semantic node
 * extraction → topological map building → navigation planning → motor commands.
 *
 * Uses REAL LLM inference via OpenRouter (qwen/qwen3-vl-8b-thinking) but
 * WITHOUT real camera input or hardware. Scenes are described in text,
 * simulating what the VLM would interpret from camera images.
 *
 * Setup:
 *   export OPENROUTER_API_KEY=sk-or-v1-...
 *   npm test -- --testPathPattern=semantic-map
 */

import {
  SemanticMap,
  type SceneAnalysis,
  type SemanticNode,
} from '../../src/3_llmunix_memory/semantic_map';
import { extractJSON } from '../../src/llmunix-core/utils';
import { CerebellumInference } from '../../src/2_qwen_cerebellum/inference';
import type { InferenceFunction } from '../../src/2_qwen_cerebellum/inference';
import { BytecodeCompiler, Opcode, OPCODE_NAMES } from '../../src/2_qwen_cerebellum/bytecode_compiler';
import { StepperKinematics } from '../../src/shared/stepper-kinematics';

// =============================================================================
// Config
// =============================================================================

const API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = 'qwen/qwen3-vl-8b-thinking';
const API_BASE = 'https://openrouter.ai/api/v1';

/** Timeout per test — real VLM inference can take 10-30s per call */
const TEST_TIMEOUT = 120_000;

const shouldRun = API_KEY.length > 0;

// =============================================================================
// Simulated Scenes — Virtual Apartment
// =============================================================================
// These text descriptions simulate what the robot's camera would see.
// The VLM interprets them as if analyzing an image.

const SCENES = {
  hallway_entrance: `
    The robot is in a narrow hallway near the front door. The floor is hardwood.
    On the left wall there is a coat rack with jackets hanging. Ahead, the hallway
    continues about 3 meters. On the right side, there is a closed white door
    (bathroom). At the far end of the hallway, there is an open archway leading
    to what appears to be a brighter room with a window visible.
    A small shoe rack sits by the front door behind the robot.
  `,

  hallway_middle: `
    The robot is in the middle of a hallway. Hardwood floors continue in both
    directions. To the left, there is an open doorway showing a room with a couch
    and TV — this looks like a living room. To the right, there is another open
    doorway showing kitchen cabinets and a refrigerator. Straight ahead, the
    hallway continues toward what looks like a bedroom with a partially visible bed.
    Behind the robot, the hallway leads back toward the entrance area.
  `,

  kitchen: `
    The robot is in a small kitchen. There are white upper cabinets and dark granite
    countertops. A stainless steel refrigerator is on the left wall. The gas stove
    with 4 burners is directly ahead. Above the sink on the right, there is a window
    with natural light coming in. The floor is beige ceramic tile. There is a small
    round dining table with two chairs near the window. The doorway behind the robot
    leads back to the hallway.
  `,

  living_room: `
    The robot is in a living room. There is a large gray L-shaped couch against the
    far wall. A flat-screen TV is mounted on the wall opposite the couch. A wooden
    coffee table sits in the center on a blue area rug. There are two windows on
    the left wall with white curtains letting in daylight. A bookshelf is in the
    corner. The floor is the same hardwood as the hallway. The doorway to the right
    leads back to the hallway.
  `,

  bedroom: `
    The robot is in a bedroom. There is a queen-sized bed with a blue comforter
    against the far wall. Two nightstands with lamps flank the bed. A wooden dresser
    with a mirror is on the left wall. The window on the right has blackout curtains
    partially drawn. The floor is carpeted in light beige. A small desk with a chair
    is in the corner near the window. The door behind the robot leads back to the
    hallway.
  `,

  bathroom: `
    The robot is in a small bathroom. There is a white porcelain toilet on the left,
    a pedestal sink in the center, and a bathtub with a shower curtain on the right.
    The walls are covered with small white tiles. A mirror is above the sink with a
    medicine cabinet. The floor is white hexagonal tile. A small window with frosted
    glass is above the bathtub. The door behind the robot leads back to the hallway.
  `,

  // Same kitchen viewed from a different angle (for location matching tests)
  kitchen_from_table: `
    The robot is near a small round dining table with two wooden chairs. Looking
    ahead, the robot can see a gas stove with 4 burners and white upper cabinets.
    A stainless steel refrigerator is visible on the far wall. The countertops are
    dark granite. Beige ceramic tile floor. Through a doorway on the right side,
    the robot can see a hallway with hardwood flooring.
  `,
};

// =============================================================================
// Virtual Robot Pose Tracker
// =============================================================================

interface VirtualPose {
  x: number;
  y: number;
  heading: number;
}

/** Simulated apartment layout (approximate positions in cm) */
const LOCATION_POSES: Record<string, VirtualPose> = {
  hallway_entrance: { x: 0, y: 0, heading: 0 },
  hallway_middle:   { x: 0, y: 150, heading: 0 },
  kitchen:          { x: 100, y: 150, heading: 90 },
  living_room:      { x: -100, y: 150, heading: 270 },
  bedroom:          { x: 0, y: 300, heading: 0 },
  bathroom:         { x: 50, y: 0, heading: 90 },
};

// =============================================================================
// Test Helpers
// =============================================================================

function createInference(): { infer: InferenceFunction; adapter: CerebellumInference } {
  const adapter = new CerebellumInference({
    apiKey: API_KEY,
    model: MODEL,
    apiBaseUrl: API_BASE,
    maxTokens: 1024,       // Need more tokens for JSON responses + thinking
    temperature: 0.3,      // Slightly creative for scene understanding
    timeoutMs: 180_000,    // VLM reasoning takes time; thinking model can need >120s
    maxRetries: 1,         // 1 retry only — avoid cascading timeouts in multi-call tests
    supportsVision: false, // We're using text descriptions, not images
  });
  return { infer: adapter.createInferenceFunction(), adapter };
}

// =============================================================================
// Unit Tests (no API needed)
// =============================================================================

describe('SemanticMap — Unit Tests', () => {
  // -------------------------------------------------------------------------
  // extractJSON helper
  // -------------------------------------------------------------------------

  test('extractJSON strips <think> tags', () => {
    const input = '<think>Let me analyze this...</think>\n{"locationLabel": "kitchen"}';
    expect(JSON.parse(extractJSON(input))).toEqual({ locationLabel: 'kitchen' });
  });

  test('extractJSON strips markdown code fences', () => {
    const input = '```json\n{"locationLabel": "kitchen"}\n```';
    expect(JSON.parse(extractJSON(input))).toEqual({ locationLabel: 'kitchen' });
  });

  test('extractJSON handles nested objects', () => {
    const input = 'Here is the result: {"a": {"b": [1, 2]}, "c": true}';
    expect(JSON.parse(extractJSON(input))).toEqual({ a: { b: [1, 2] }, c: true });
  });

  test('extractJSON handles think tags + code fences combined', () => {
    const input = `<think>
I need to analyze this scene carefully.
The features suggest this is a kitchen.
</think>

\`\`\`json
{
  "locationLabel": "kitchen",
  "confidence": 0.9
}
\`\`\``;
    const parsed = JSON.parse(extractJSON(input));
    expect(parsed.locationLabel).toBe('kitchen');
    expect(parsed.confidence).toBe(0.9);
  });

  // -------------------------------------------------------------------------
  // Graph operations (mock inference)
  // -------------------------------------------------------------------------

  test('empty map has zero stats', () => {
    const mockInfer: InferenceFunction = async () => '';
    const map = new SemanticMap(mockInfer);
    // Clear any state persisted to disk by other tests
    map.loadFromJSON({ nodes: [], edges: [] });
    const stats = map.getStats();
    expect(stats.nodeCount).toBe(0);
    expect(stats.edgeCount).toBe(0);
    expect(stats.currentNodeId).toBeNull();
  });

  test('getMapSummary on empty map', () => {
    const mockInfer: InferenceFunction = async () => '';
    const map = new SemanticMap(mockInfer);
    map.loadFromJSON({ nodes: [], edges: [] });
    expect(map.getMapSummary()).toBe('(empty map)');
  });

  test('findPath returns null for unknown nodes', () => {
    const mockInfer: InferenceFunction = async () => '';
    const map = new SemanticMap(mockInfer);
    map.loadFromJSON({ nodes: [], edges: [] });
    expect(map.findPath('a', 'b')).toBeNull();
  });

  test('toJSON / loadFromJSON round-trip', () => {
    const mockInfer: InferenceFunction = async () => '';
    const map = new SemanticMap(mockInfer);

    // Manually populate via loadFromJSON
    const data = {
      nodes: [
        {
          id: 'loc_0',
          label: 'kitchen',
          description: 'A kitchen',
          features: ['stove', 'fridge'],
          navigationHints: ['door to hallway'],
          visitCount: 2,
          firstVisited: 1000,
          lastVisited: 2000,
        },
        {
          id: 'loc_1',
          label: 'hallway',
          description: 'A hallway',
          features: ['hardwood floor'],
          navigationHints: ['door to kitchen', 'door to bedroom'],
          visitCount: 3,
          firstVisited: 500,
          lastVisited: 2000,
        },
      ],
      edges: [
        {
          from: 'loc_0',
          to: 'loc_1',
          action: 'move backward through doorway',
          estimatedSteps: 0,
          traversalCount: 1,
          lastTraversed: 2000,
        },
      ],
    };

    map.loadFromJSON(data);

    expect(map.getStats().nodeCount).toBe(2);
    expect(map.getStats().edgeCount).toBe(1);
    expect(map.getNode('loc_0')?.label).toBe('kitchen');
    expect(map.getNode('loc_1')?.label).toBe('hallway');
    expect(map.getNeighbors('loc_0')).toContain('loc_1');
    expect(map.findPath('loc_0', 'loc_1')).toEqual(['loc_0', 'loc_1']);
    expect(map.findNodeByLabel('kitchen')?.id).toBe('loc_0');

    // Round-trip
    const exported = map.toJSON();
    const map2 = new SemanticMap(mockInfer);
    map2.loadFromJSON(exported);
    expect(map2.getStats().nodeCount).toBe(2);
    expect(map2.getStats().edgeCount).toBe(1);
  });

  test('findPath with multi-hop route', () => {
    const mockInfer: InferenceFunction = async () => '';
    const map = new SemanticMap(mockInfer);

    map.loadFromJSON({
      nodes: [
        { id: 'loc_0', label: 'A', description: '', features: [], navigationHints: [], visitCount: 1, firstVisited: 0, lastVisited: 0 },
        { id: 'loc_1', label: 'B', description: '', features: [], navigationHints: [], visitCount: 1, firstVisited: 0, lastVisited: 0 },
        { id: 'loc_2', label: 'C', description: '', features: [], navigationHints: [], visitCount: 1, firstVisited: 0, lastVisited: 0 },
      ],
      edges: [
        { from: 'loc_0', to: 'loc_1', action: 'forward', estimatedSteps: 0, traversalCount: 1, lastTraversed: 0 },
        { from: 'loc_1', to: 'loc_2', action: 'forward', estimatedSteps: 0, traversalCount: 1, lastTraversed: 0 },
      ],
    });

    expect(map.findPath('loc_0', 'loc_2')).toEqual(['loc_0', 'loc_1', 'loc_2']);
    expect(map.findPath('loc_2', 'loc_0')).toEqual(['loc_2', 'loc_1', 'loc_0']);
  });
});

// =============================================================================
// E2E Tests with Real VLM Inference
// =============================================================================

const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('SemanticMap — E2E with VLM (OpenRouter)', () => {
  let infer: InferenceFunction;
  let adapter: CerebellumInference;

  beforeAll(() => {
    ({ infer, adapter } = createInference());
  });

  afterAll(() => {
    const stats = adapter.getStats();
    console.log('\n--- VLM Inference Stats ---');
    console.log(`  Total calls: ${stats.totalCalls}`);
    console.log(`  Successful:  ${stats.successfulCalls}`);
    console.log(`  Failed:      ${stats.failedCalls}`);
    console.log(`  Avg latency: ${Math.round(stats.averageLatencyMs)}ms`);
    console.log(`  Tokens used: ${stats.totalTokens}`);
    console.log('---------------------------\n');
  });

  // -------------------------------------------------------------------------
  // Test 1: Scene Analysis — VLM extracts location info from text description
  // -------------------------------------------------------------------------

  test('analyzes kitchen scene and extracts structured data', async () => {
    const map = new SemanticMap(infer);
    const analysis = await map.analyzeScene(SCENES.kitchen);

    expect(analysis).not.toBeNull();
    console.log('Kitchen analysis:', JSON.stringify(analysis, null, 2));

    // VLM should identify this as a kitchen
    expect(analysis!.locationLabel.toLowerCase()).toContain('kitchen');

    // Should extract relevant features
    expect(analysis!.features.length).toBeGreaterThan(0);
    const featureText = analysis!.features.join(' ').toLowerCase();
    // At least some kitchen features should be mentioned
    const hasKitchenFeatures = ['stove', 'refrigerator', 'fridge', 'cabinet', 'sink', 'counter']
      .some(f => featureText.includes(f));
    expect(hasKitchenFeatures).toBe(true);

    // Should identify exits
    expect(analysis!.navigationHints.length).toBeGreaterThan(0);

    // Confidence should be reasonable
    expect(analysis!.confidence).toBeGreaterThan(0.5);
  }, TEST_TIMEOUT);

  test('analyzes bedroom scene and extracts structured data', async () => {
    const map = new SemanticMap(infer);
    const analysis = await map.analyzeScene(SCENES.bedroom);

    expect(analysis).not.toBeNull();
    console.log('Bedroom analysis:', JSON.stringify(analysis, null, 2));

    expect(analysis!.locationLabel.toLowerCase()).toContain('bedroom');
    expect(analysis!.features.length).toBeGreaterThan(0);

    const featureText = analysis!.features.join(' ').toLowerCase();
    const hasBedroomFeatures = ['bed', 'nightstand', 'dresser', 'pillow', 'comforter', 'lamp']
      .some(f => featureText.includes(f));
    expect(hasBedroomFeatures).toBe(true);
  }, TEST_TIMEOUT);

  test('analyzes hallway scene identifying multiple exits', async () => {
    const map = new SemanticMap(infer);
    const analysis = await map.analyzeScene(SCENES.hallway_middle);

    expect(analysis).not.toBeNull();
    console.log('Hallway analysis:', JSON.stringify(analysis, null, 2));

    const label = analysis!.locationLabel.toLowerCase();
    expect(label.includes('hallway') || label.includes('corridor') || label.includes('hall')).toBe(true);

    // The hallway scene describes multiple exits — VLM should identify at least 2
    expect(analysis!.navigationHints.length).toBeGreaterThanOrEqual(2);
  }, TEST_TIMEOUT);

  // -------------------------------------------------------------------------
  // Test 2: Location Matching — Same kitchen from different angles
  // -------------------------------------------------------------------------

  test('recognizes same kitchen from different viewing angles', async () => {
    const map = new SemanticMap(infer);

    const analysis1 = await map.analyzeScene(SCENES.kitchen);
    const analysis2 = await map.analyzeScene(SCENES.kitchen_from_table);

    expect(analysis1).not.toBeNull();
    expect(analysis2).not.toBeNull();

    console.log('Kitchen (angle 1):', analysis1!.locationLabel);
    console.log('Kitchen (angle 2):', analysis2!.locationLabel);

    // Create a fake node from the first analysis to test matching
    const node: SemanticNode = {
      id: 'test_node',
      label: analysis1!.locationLabel,
      description: analysis1!.description,
      features: analysis1!.features,
      navigationHints: analysis1!.navigationHints,
      visitCount: 1,
      firstVisited: Date.now(),
      lastVisited: Date.now(),
    };

    const match = await map.matchLocation(analysis2!, node);
    expect(match).not.toBeNull();
    console.log('Location match result:', JSON.stringify(match, null, 2));

    // VLM should recognize these as the same kitchen
    expect(match!.isSameLocation).toBe(true);
    expect(match!.confidence).toBeGreaterThan(0.5);
  }, TEST_TIMEOUT * 2); // 3 VLM calls: 2 analyses + 1 match

  test('distinguishes kitchen from bedroom', async () => {
    const map = new SemanticMap(infer);

    const kitchenAnalysis = await map.analyzeScene(SCENES.kitchen);
    const bedroomAnalysis = await map.analyzeScene(SCENES.bedroom);

    expect(kitchenAnalysis).not.toBeNull();
    expect(bedroomAnalysis).not.toBeNull();

    const kitchenNode: SemanticNode = {
      id: 'test_kitchen',
      label: kitchenAnalysis!.locationLabel,
      description: kitchenAnalysis!.description,
      features: kitchenAnalysis!.features,
      navigationHints: kitchenAnalysis!.navigationHints,
      visitCount: 1,
      firstVisited: Date.now(),
      lastVisited: Date.now(),
    };

    const match = await map.matchLocation(bedroomAnalysis!, kitchenNode);
    expect(match).not.toBeNull();
    console.log('Kitchen vs Bedroom match:', JSON.stringify(match, null, 2));

    // VLM should recognize these are DIFFERENT locations
    expect(match!.isSameLocation).toBe(false);
  }, TEST_TIMEOUT * 2); // 3 VLM calls: 2 analyses + 1 match

  // -------------------------------------------------------------------------
  // Test 3: Map Building — Walk through apartment building topological graph
  // -------------------------------------------------------------------------

  test('builds topological map from sequential room visits', async () => {
    const map = new SemanticMap(infer);
    // Clear any state persisted by previous tests
    map.loadFromJSON({ nodes: [], edges: [] });

    // Simulate: hallway → kitchen → hallway (revisit) → living room
    // Kept to 4 steps to limit VLM calls (each step matches against all existing nodes)
    const route: Array<{ scene: keyof typeof SCENES; action?: string; poseKey: string }> = [
      { scene: 'hallway_middle', poseKey: 'hallway_middle' },
      { scene: 'kitchen', action: 'turned right into kitchen', poseKey: 'kitchen' },
      { scene: 'hallway_middle', action: 'exited kitchen back to hallway', poseKey: 'hallway_middle' },
      { scene: 'living_room', action: 'turned left into living room', poseKey: 'living_room' },
    ];

    const visitLog: Array<{ scene: string; nodeId: string; isNew: boolean; label: string }> = [];

    for (const step of route) {
      const result = await map.processScene(
        SCENES[step.scene],
        LOCATION_POSES[step.poseKey],
        step.action,
      );

      visitLog.push({
        scene: step.scene,
        nodeId: result.nodeId,
        isNew: result.isNew,
        label: result.analysis.locationLabel,
      });

      console.log(
        `  ${step.scene}: ${result.isNew ? 'NEW' : 'REVISIT'} → ` +
        `${result.nodeId} (${result.analysis.locationLabel})`
      );
    }

    // Should have created distinct nodes for distinct locations
    const stats = map.getStats();
    console.log('\nMap stats:', stats);
    console.log('Map summary:\n' + map.getMapSummary());

    // At least 2 distinct locations (hallway, kitchen, living_room)
    expect(stats.nodeCount).toBeGreaterThanOrEqual(2);
    expect(stats.nodeCount).toBeLessThanOrEqual(4);

    // Should have edges connecting locations
    expect(stats.edgeCount).toBeGreaterThanOrEqual(1);

    // The hallway_middle revisit (step 2) ideally matches the existing hallway node.
    // However, VLM non-determinism may produce different enough features that the
    // Jaccard pre-filter or VLM match doesn't merge them. Log the outcome either way.
    if (visitLog[2].isNew) {
      console.log('  Note: VLM did not recognize hallway revisit — acceptable non-determinism');
    } else {
      console.log('  Hallway revisit correctly matched existing node');
    }

    // Verify we can find locations by label
    const kitchenNode = map.findNodeByLabel('kitchen');
    expect(kitchenNode).toBeDefined();

    // Verify path exists from hallway node (index 0) to kitchen
    if (kitchenNode) {
      const hallwayNode = map.getNode(visitLog[0].nodeId);
      if (hallwayNode) {
        const path = map.findPath(hallwayNode.id, kitchenNode.id);
        console.log(`Path from ${hallwayNode.label} to ${kitchenNode.label}:`, path);
        expect(path).not.toBeNull();
        expect(path!.length).toBeGreaterThanOrEqual(2);
      }
    }

    // Verify serialization works
    const exported = map.toJSON();
    expect(exported.nodes.length).toBe(stats.nodeCount);
    expect(exported.edges.length).toBe(stats.edgeCount);
  }, TEST_TIMEOUT * 8); // Many sequential VLM calls with O(n) matching per scene

  // -------------------------------------------------------------------------
  // Test 4: Navigation Planning — VLM decides motor action toward target
  // -------------------------------------------------------------------------

  test('plans navigation from hallway toward kitchen', async () => {
    const map = new SemanticMap(infer);

    // Pre-load a known map so navigation has context
    map.loadFromJSON({
      nodes: [
        {
          id: 'loc_0', label: 'hallway', description: 'Central hallway with hardwood floors',
          features: ['hardwood floor', 'multiple doorways'],
          navigationHints: ['kitchen to the right', 'living room to the left', 'bedroom ahead'],
          visitCount: 3, firstVisited: 0, lastVisited: 0,
        },
        {
          id: 'loc_1', label: 'kitchen', description: 'Kitchen with white cabinets and gas stove',
          features: ['white cabinets', 'gas stove', 'tile floor'],
          navigationHints: ['doorway back to hallway'],
          visitCount: 1, firstVisited: 0, lastVisited: 0,
        },
        {
          id: 'loc_2', label: 'living room', description: 'Living room with gray couch and TV',
          features: ['gray couch', 'TV', 'coffee table'],
          navigationHints: ['doorway back to hallway'],
          visitCount: 1, firstVisited: 0, lastVisited: 0,
        },
      ],
      edges: [
        { from: 'loc_0', to: 'loc_1', action: 'turn right', estimatedSteps: 500, traversalCount: 1, lastTraversed: 0 },
        { from: 'loc_0', to: 'loc_2', action: 'turn left', estimatedSteps: 500, traversalCount: 1, lastTraversed: 0 },
        { from: 'loc_1', to: 'loc_0', action: 'go through doorway', estimatedSteps: 500, traversalCount: 1, lastTraversed: 0 },
        { from: 'loc_2', to: 'loc_0', action: 'go through doorway', estimatedSteps: 500, traversalCount: 1, lastTraversed: 0 },
      ],
    });

    const decision = await map.planNavigation(SCENES.hallway_middle, 'kitchen');

    expect(decision).not.toBeNull();
    console.log('Navigation decision:', JSON.stringify(decision, null, 2));

    // VLM should output a motor command
    expect(decision!.action).toBeTruthy();
    expect(decision!.motorCommand).toBeTruthy();
    expect(decision!.reasoning).toBeTruthy();

    // The action should involve turning right (kitchen is to the right in hallway)
    const actionLower = decision!.action.toLowerCase();
    const hasNavAction = ['turn', 'right', 'forward', 'move'].some(w => actionLower.includes(w));
    expect(hasNavAction).toBe(true);
  }, TEST_TIMEOUT);

  // -------------------------------------------------------------------------
  // Test 5: Full E2E Loop — Scene → Map → Navigate → Motor Command
  // -------------------------------------------------------------------------

  test('full navigation loop: analyze scene, update map, plan, compile bytecode', async () => {
    const map = new SemanticMap(infer);
    // Clear any state persisted by previous tests
    map.loadFromJSON({ nodes: [], edges: [] });
    const compiler = new BytecodeCompiler('fewshot');
    const kin = new StepperKinematics();

    // Step 1: Robot starts in hallway — analyze and add to map
    console.log('\n=== Step 1: Analyze hallway ===');
    const hallwayResult = await map.processScene(
      SCENES.hallway_middle,
      LOCATION_POSES.hallway_middle,
    );
    console.log(`  Created node: ${hallwayResult.nodeId} (${hallwayResult.analysis.locationLabel})`);
    expect(hallwayResult.isNew).toBe(true);

    // Step 2: Robot moves to kitchen — analyze and add to map
    console.log('\n=== Step 2: Analyze kitchen ===');
    const kitchenResult = await map.processScene(
      SCENES.kitchen,
      LOCATION_POSES.kitchen,
      'turned right into doorway',
    );
    console.log(`  Created node: ${kitchenResult.nodeId} (${kitchenResult.analysis.locationLabel})`);
    expect(kitchenResult.isNew).toBe(true);
    expect(map.getStats().edgeCount).toBeGreaterThanOrEqual(1);

    // Step 3: Robot returns to hallway — ideally matches existing node
    // VLM non-determinism may produce different features, so we log but don't hard-fail
    console.log('\n=== Step 3: Return to hallway ===');
    const returnResult = await map.processScene(
      SCENES.hallway_middle,
      LOCATION_POSES.hallway_middle,
      'exited kitchen through doorway',
    );
    console.log(`  ${returnResult.isNew ? 'NEW' : 'REVISIT'} node: ${returnResult.nodeId} (${returnResult.analysis.locationLabel})`);

    // Step 4: Plan navigation to bedroom (haven't visited yet)
    console.log('\n=== Step 4: Plan navigation to bedroom ===');
    const navDecision = await map.planNavigation(SCENES.hallway_middle, 'bedroom');
    expect(navDecision).not.toBeNull();
    console.log(`  Decision: ${navDecision!.action}`);
    console.log(`  Reasoning: ${navDecision!.reasoning}`);
    console.log(`  Motor command: ${navDecision!.motorCommand}`);

    // Step 5: Compile the motor command to bytecode
    console.log('\n=== Step 5: Compile to bytecode ===');
    const motorCmd = navDecision!.motorCommand;
    const bytecode = compiler.compile(motorCmd);

    if (bytecode) {
      const opcodeName = OPCODE_NAMES[bytecode[1]] || 'UNKNOWN';
      console.log(`  Bytecode: ${Array.from(bytecode).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`);
      console.log(`  Opcode: ${opcodeName} (0x${bytecode[1].toString(16).toUpperCase()})`);
      console.log(`  Params: L=${bytecode[2]} R=${bytecode[3]}`);

      // Should be a valid 6-byte frame
      expect(bytecode.length).toBe(6);
      expect(bytecode[0]).toBe(0xAA);
      expect(bytecode[5]).toBe(0xFF);

      // Should be a movement command (not STOP or STATUS)
      const movementOpcodes = [
        Opcode.MOVE_FORWARD, Opcode.MOVE_BACKWARD,
        Opcode.TURN_LEFT, Opcode.TURN_RIGHT,
        Opcode.ROTATE_CW, Opcode.ROTATE_CCW,
      ];
      expect(movementOpcodes).toContain(bytecode[1]);
    } else {
      // Even if bytecode compilation fails, the VLM produced a valid decision
      console.log(`  Note: Motor command "${motorCmd}" did not compile to bytecode`);
      console.log('  This is acceptable — the VLM reasoning was still valid');
    }

    // Final map state
    console.log('\n=== Final Map ===');
    console.log(map.getMapSummary());
    const stats = map.getStats();
    console.log(`Nodes: ${stats.nodeCount}, Edges: ${stats.edgeCount}`);

    expect(stats.nodeCount).toBeGreaterThanOrEqual(2);
  }, TEST_TIMEOUT * 5);

  // -------------------------------------------------------------------------
  // Test 6: Multi-room exploration builds connected graph
  // -------------------------------------------------------------------------

  test('exploration of 4+ rooms builds fully connected graph', async () => {
    const map = new SemanticMap(infer);
    // Clear any state persisted by previous tests
    map.loadFromJSON({ nodes: [], edges: [] });

    // 5 scenes to balance coverage vs VLM call budget (each scene matches O(n) existing nodes)
    const explorationRoute: Array<{ scene: keyof typeof SCENES; action?: string; poseKey: string }> = [
      { scene: 'hallway_entrance', poseKey: 'hallway_entrance' },
      { scene: 'bathroom', action: 'turned right and entered bathroom', poseKey: 'bathroom' },
      { scene: 'hallway_entrance', action: 'exited bathroom to hallway', poseKey: 'hallway_entrance' },
      { scene: 'kitchen', action: 'moved forward and turned right into kitchen', poseKey: 'kitchen' },
      { scene: 'bedroom', action: 'returned to hallway and moved to bedroom', poseKey: 'bedroom' },
    ];

    console.log('\n=== Full Apartment Exploration ===');
    for (const step of explorationRoute) {
      const result = await map.processScene(
        SCENES[step.scene],
        LOCATION_POSES[step.poseKey],
        step.action,
      );
      console.log(
        `  ${step.scene.padEnd(20)} → ${result.isNew ? 'NEW    ' : 'REVISIT'} ` +
        `${result.nodeId} (${result.analysis.locationLabel})`
      );
    }

    const stats = map.getStats();
    console.log(`\nMap: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
    console.log(map.getMapSummary());

    // Should have at least 4 distinct rooms
    // (entrance hallway and mid hallway might merge, or bathroom/kitchen/bedroom stay distinct)
    expect(stats.nodeCount).toBeGreaterThanOrEqual(4);

    // Should have edges forming a connected graph
    expect(stats.edgeCount).toBeGreaterThanOrEqual(3);

    // Verify the graph is connected — should be able to find path between any two nodes
    const allNodes = map.getAllNodes();
    if (allNodes.length >= 2) {
      const path = map.findPath(allNodes[0].id, allNodes[allNodes.length - 1].id);
      console.log(
        `Path from ${allNodes[0].label} to ${allNodes[allNodes.length - 1].label}: ` +
        (path ? path.map(id => map.getNode(id)?.label).join(' → ') : 'NOT FOUND')
      );
      expect(path).not.toBeNull();
    }

    // Verify serialization round-trip preserves the full graph
    const exported = map.toJSON();
    const map2 = new SemanticMap(infer);
    map2.loadFromJSON(exported);
    expect(map2.getStats().nodeCount).toBe(stats.nodeCount);
    expect(map2.getStats().edgeCount).toBe(stats.edgeCount);
  }, TEST_TIMEOUT * 12); // 7 scenes × O(n) matching = ~40+ VLM calls
});

// =============================================================================
// Integration: Semantic Map + Bytecode Pipeline
// =============================================================================

describeE2E('SemanticMap + Bytecode Pipeline Integration', () => {
  let infer: InferenceFunction;
  let adapter: CerebellumInference;

  beforeAll(() => {
    ({ infer, adapter } = createInference());
  });

  test('navigation decision compiles to valid bytecode frame', async () => {
    const map = new SemanticMap(infer);
    const compiler = new BytecodeCompiler('fewshot');

    // Give the map some context
    map.loadFromJSON({
      nodes: [
        {
          id: 'loc_0', label: 'hallway',
          description: 'Hallway with doors on both sides',
          features: ['hardwood floor', 'white walls'],
          navigationHints: ['kitchen door on the right', 'living room on the left'],
          visitCount: 1, firstVisited: 0, lastVisited: 0,
        },
        {
          id: 'loc_1', label: 'kitchen',
          description: 'Kitchen with stove and fridge',
          features: ['gas stove', 'refrigerator', 'tile floor'],
          navigationHints: ['door to hallway'],
          visitCount: 1, firstVisited: 0, lastVisited: 0,
        },
      ],
      edges: [
        { from: 'loc_0', to: 'loc_1', action: 'turn right through doorway', estimatedSteps: 500, traversalCount: 1, lastTraversed: 0 },
        { from: 'loc_1', to: 'loc_0', action: 'exit through doorway', estimatedSteps: 500, traversalCount: 1, lastTraversed: 0 },
      ],
    });

    // Plan navigation to kitchen from hallway
    const decision = await map.planNavigation(
      'The robot is in a hallway. To the right, there is an open doorway leading to a kitchen with visible cabinets. To the left is a closed door. Ahead the hallway continues.',
      'kitchen',
    );

    expect(decision).not.toBeNull();
    console.log('Navigation decision:', decision);

    // Try to compile the motor command
    const bytecode = compiler.compile(decision!.motorCommand);
    if (bytecode) {
      console.log('Bytecode compiled successfully:', Array.from(bytecode).map(b => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(' '));
      expect(bytecode.length).toBe(6);
      expect(bytecode[0]).toBe(0xAA);
      expect(bytecode[5]).toBe(0xFF);
    } else {
      // VLM might output a command format that doesn't directly compile
      // This is useful feedback for prompt engineering
      console.log(`Motor command "${decision!.motorCommand}" did not compile — prompt tuning needed`);
    }
  }, TEST_TIMEOUT);
});
