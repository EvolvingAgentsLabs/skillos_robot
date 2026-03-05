/**
 * Synthetic E2E Tests — Navigation CoT Validation with Mock VLM
 *
 * Tests the full navigation pipeline using mock inference functions that return
 * realistic VLM JSON — no API key needed, runs in every CI environment.
 *
 * Validates:
 *   A. Jaccard pre-filter integration (Step 6 doesn't break Navigation CoT)
 *   B. Full Navigation CoT pipeline (analyze → match → plan → compile)
 *   C. New feature integration (STOP hold_torque, frame flush, permissive compiler)
 *   D. End-to-end map building and pathfinding
 *
 * Run:
 *   npm test -- --testPathPattern=semantic-map-synthetic
 */

import {
  SemanticMap,
  compareFeatureSets,
  generateFeatureFingerprint,
  type SceneAnalysis,
  type SemanticNode,
  type SpatialFeature,
} from '../../src/3_llmunix_memory/semantic_map';
import type { InferenceFunction } from '../../src/2_qwen_cerebellum/inference';
import {
  BytecodeCompiler,
  Opcode,
  calculateChecksum,
  decodeFrame,
  formatHex,
  FRAME_START,
  FRAME_END,
} from '../../src/2_qwen_cerebellum/bytecode_compiler';

// =============================================================================
// Simulated Scenes — Reuse from semantic-map.e2e.test.ts for consistency
// =============================================================================

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

  kitchen_from_table: `
    The robot is near a small round dining table with two wooden chairs. Looking
    ahead, the robot can see a gas stove with 4 burners and white upper cabinets.
    A stainless steel refrigerator is visible on the far wall. The countertops are
    dark granite. Beige ceramic tile floor. Through a doorway on the right side,
    the robot can see a hallway with hardwood flooring.
  `,
};

// =============================================================================
// Mock Inference — Deterministic VLM Responses
// =============================================================================

/** Extract a location label from the user message based on scene keywords. */
function extractLocationFromMessage(message: string): string {
  const lower = message.toLowerCase();

  // First priority: explicit "The robot is in a/the [location]" pattern
  const robotIsIn = lower.match(/robot is in (?:a |the |an )?(?:small |narrow |middle of (?:a |the )?)?([\w\s]+?)(?:\.|,|\s+(?:with|near|there|the|on|hardwood|looking))/);
  if (robotIsIn) {
    const location = robotIsIn[1].trim();
    if (location.includes('kitchen')) return 'kitchen';
    if (location.includes('bedroom')) return 'bedroom';
    if (location.includes('living room')) return 'living room';
    if (location.includes('bathroom')) return 'bathroom';
    if (location.includes('hallway') || location.includes('corridor')) return 'hallway';
  }

  // Fallback: keyword matching
  if (lower.includes('kitchen') || lower.includes('stove') || lower.includes('refrigerator')) return 'kitchen';
  if (lower.includes('bedroom') || lower.includes('bed') || lower.includes('dresser')) return 'bedroom';
  if (lower.includes('living room') || lower.includes('couch') || lower.includes('tv')) return 'living room';
  if (lower.includes('bathroom') || lower.includes('toilet') || lower.includes('bathtub')) return 'bathroom';
  if (lower.includes('hallway') || lower.includes('corridor')) return 'hallway';
  return 'unknown room';
}

/** Extract features from the user message based on scene keywords. */
function extractFeaturesFromMessage(message: string): string[] {
  const lower = message.toLowerCase();
  const features: string[] = [];

  // Kitchen features
  if (lower.includes('stove') || lower.includes('burner')) features.push('gas stove');
  if (lower.includes('refrigerator') || lower.includes('fridge')) features.push('refrigerator');
  if (lower.includes('cabinet')) features.push('white cabinets');
  if (lower.includes('granite') || lower.includes('countertop')) features.push('granite countertops');
  if (lower.includes('ceramic tile') || lower.includes('tile floor')) features.push('tile floor');
  if (lower.includes('dining table')) features.push('dining table');
  if (lower.includes('sink')) features.push('sink');

  // Bedroom features
  if (lower.includes('bed') && !lower.includes('bedroom')) features.push('queen bed');
  if (lower.includes('nightstand')) features.push('nightstands');
  if (lower.includes('dresser')) features.push('wooden dresser');
  if (lower.includes('comforter')) features.push('blue comforter');
  if (lower.includes('carpet')) features.push('carpet floor');
  if (lower.includes('desk')) features.push('desk');

  // Living room features
  if (lower.includes('couch') || lower.includes('sofa')) features.push('gray couch');
  if (lower.includes('tv') || lower.includes('television')) features.push('flat-screen TV');
  if (lower.includes('coffee table')) features.push('coffee table');
  if (lower.includes('bookshelf')) features.push('bookshelf');
  if (lower.includes('area rug')) features.push('blue area rug');

  // Bathroom features
  if (lower.includes('toilet')) features.push('toilet');
  if (lower.includes('bathtub') || lower.includes('shower')) features.push('bathtub');
  if (lower.includes('pedestal sink') || (lower.includes('sink') && lower.includes('bathroom'))) features.push('pedestal sink');
  if (lower.includes('medicine cabinet')) features.push('medicine cabinet');
  if (lower.includes('hexagonal tile')) features.push('hexagonal tile floor');

  // Hallway features
  if (lower.includes('hardwood')) features.push('hardwood floor');
  if (lower.includes('coat rack')) features.push('coat rack');
  if (lower.includes('shoe rack')) features.push('shoe rack');
  if (lower.includes('doorway') || lower.includes('archway')) features.push('multiple doorways');

  return features.length > 0 ? features : ['generic room'];
}

/** Detect if two scene descriptions in the user message refer to the same location. */
function detectSameLocation(message: string): boolean {
  // The matchLocation prompt format puts "Scene A" and "Scene B" labels on separate lines.
  // Extract the label from each scene section using multiline matching.
  const labelA = message.match(/Scene A[\s\S]*?Label:\s*(.+)/i)?.[1]?.trim().toLowerCase() ?? '';
  const labelB = message.match(/Scene B[\s\S]*?Label:\s*(.+)/i)?.[1]?.trim().toLowerCase() ?? '';

  if (!labelA || !labelB) return false;

  // Same-type rooms are the same location
  return labelA.includes(labelB) || labelB.includes(labelA);
}

/**
 * Create a mock InferenceFunction that inspects the system prompt to determine
 * which pipeline stage is being called, then returns hardcoded JSON matching
 * the expected interfaces.
 */
function createMockInference(): jest.Mock<ReturnType<InferenceFunction>, Parameters<InferenceFunction>> {
  const mockFn = jest.fn<ReturnType<InferenceFunction>, Parameters<InferenceFunction>>(
    async (systemPrompt: string, userMessage: string) => {
      if (systemPrompt.includes('spatial perception')) {
        // Scene analysis
        const label = extractLocationFromMessage(userMessage);
        const features = extractFeaturesFromMessage(userMessage);
        return JSON.stringify({
          locationLabel: label,
          description: `Mock ${label} scene`,
          features,
          navigationHints: ['doorway ahead', 'passage to the left'],
          confidence: 0.85,
        });
      }

      if (systemPrompt.includes('place recognition')) {
        // Location matching
        const isSame = detectSameLocation(userMessage);
        return JSON.stringify({
          isSameLocation: isSame,
          confidence: isSame ? 0.9 : 0.15,
          reasoning: isSame
            ? 'Both scenes share the same structural features'
            : 'Scenes describe different types of rooms',
        });
      }

      if (systemPrompt.includes('navigation planner')) {
        // Navigation planning
        return JSON.stringify({
          action: 'TURN_RIGHT 100 180',
          reasoning: 'Target is to the right based on map layout',
          confidence: 0.8,
          motorCommand: 'TURN_RIGHT 100 180',
        });
      }

      return '{}';
    },
  );
  return mockFn;
}

// =============================================================================
// A. Jaccard Pre-Filter Integration
// =============================================================================

describe('Synthetic E2E — Jaccard Pre-Filter', () => {
  test('A1: compareFeatureSets — high similarity for same-type rooms', () => {
    const kitchenA = ['gas stove', 'refrigerator', 'white cabinets', 'granite countertops', 'tile floor'];
    const kitchenB = ['gas stove', 'white cabinets', 'granite countertops', 'tile floor', 'dining table'];

    const similarity = compareFeatureSets(kitchenA, kitchenB);
    // 4 shared out of 6 unique = 0.667
    expect(similarity).toBeGreaterThan(0.5);
  });

  test('A2: compareFeatureSets — low similarity for different rooms', () => {
    const kitchen = ['gas stove', 'refrigerator', 'white cabinets', 'granite countertops', 'tile floor'];
    const bedroom = ['queen bed', 'nightstands', 'wooden dresser', 'blue comforter', 'carpet floor'];

    const similarity = compareFeatureSets(kitchen, bedroom);
    // No overlap → 0
    expect(similarity).toBeLessThan(0.15);
  });

  test('A2b: generateFeatureFingerprint produces consistent hashes', () => {
    const features = ['gas stove', 'refrigerator', 'white cabinets'];
    const hash1 = generateFeatureFingerprint(features);
    const hash2 = generateFeatureFingerprint(features);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{8}$/);

    // Order shouldn't matter
    const hash3 = generateFeatureFingerprint(['white cabinets', 'gas stove', 'refrigerator']);
    expect(hash3).toBe(hash1);

    // Different features produce different hashes
    const hash4 = generateFeatureFingerprint(['queen bed', 'dresser']);
    expect(hash4).not.toBe(hash1);
  });

  test('A3: processScene skips VLM match for dissimilar nodes (Jaccard < 0.15)', async () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    // Pre-populate with a bedroom node
    map.loadFromJSON({
      nodes: [
        {
          id: 'loc_0',
          label: 'bedroom',
          description: 'A bedroom with a bed and dresser',
          features: ['queen bed', 'nightstands', 'wooden dresser', 'blue comforter', 'carpet floor'],
          navigationHints: ['door to hallway'],
          visitCount: 1,
          firstVisited: 1000,
          lastVisited: 1000,
          featureFingerprint: generateFeatureFingerprint(['queen bed', 'nightstands', 'wooden dresser', 'blue comforter', 'carpet floor']),
        },
      ],
      edges: [],
    });

    // Process a kitchen scene — features have zero overlap with bedroom
    const result = await map.processScene(SCENES.kitchen, { x: 100, y: 150, heading: 90 });

    // Should create a NEW node (not match the bedroom)
    expect(result.isNew).toBe(true);
    expect(result.analysis.locationLabel).toBe('kitchen');

    // The mock should have been called for scene analysis but NOT for location matching
    // because Jaccard similarity between kitchen and bedroom features is < 0.15
    const matchCalls = mockInfer.mock.calls.filter(
      ([prompt]) => prompt.includes('place recognition'),
    );
    expect(matchCalls.length).toBe(0);
  });

  test('A4: processScene calls VLM match for similar nodes (Jaccard > 0.15)', async () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    // Pre-populate with a kitchen node that shares features
    map.loadFromJSON({
      nodes: [
        {
          id: 'loc_0',
          label: 'kitchen',
          description: 'A kitchen with cabinets and stove',
          features: ['gas stove', 'refrigerator', 'white cabinets', 'granite countertops', 'tile floor'],
          navigationHints: ['door to hallway'],
          visitCount: 1,
          firstVisited: 1000,
          lastVisited: 1000,
          featureFingerprint: generateFeatureFingerprint(['gas stove', 'refrigerator', 'white cabinets', 'granite countertops', 'tile floor']),
        },
      ],
      edges: [],
    });

    // Process the same kitchen from a different angle
    const result = await map.processScene(SCENES.kitchen_from_table, { x: 100, y: 150, heading: 180 });

    // The mock matchLocation SHOULD have been called because features overlap
    const matchCalls = mockInfer.mock.calls.filter(
      ([prompt]) => prompt.includes('place recognition'),
    );
    expect(matchCalls.length).toBeGreaterThan(0);

    // Should match the existing kitchen node (isSameLocation: true from mock)
    expect(result.isNew).toBe(false);
    expect(result.nodeId).toBe('loc_0');
  });
});

// =============================================================================
// B. Full Navigation CoT Pipeline (Synthetic)
// =============================================================================

describe('Synthetic E2E — Navigation CoT Pipeline', () => {
  test('B5: Scene Analysis extracts structured data from mock', async () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    const analysis = await map.analyzeScene(SCENES.kitchen);

    expect(analysis).not.toBeNull();
    expect(analysis!.locationLabel).toBe('kitchen');
    expect(analysis!.features).toContain('gas stove');
    expect(analysis!.features).toContain('refrigerator');
    expect(analysis!.confidence).toBe(0.85);
    expect(analysis!.navigationHints.length).toBeGreaterThan(0);
  });

  test('B6: Location Matching — same room from 2 angles returns isSameLocation: true', async () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    const analysis = await map.analyzeScene(SCENES.kitchen_from_table);
    expect(analysis).not.toBeNull();

    const kitchenNode: SemanticNode = {
      id: 'test_kitchen',
      label: 'kitchen',
      description: 'A kitchen with stove and fridge',
      features: ['gas stove', 'refrigerator', 'white cabinets'],
      navigationHints: ['door to hallway'],
      visitCount: 1,
      firstVisited: Date.now(),
      lastVisited: Date.now(),
    };

    const match = await map.matchLocation(analysis!, kitchenNode);
    expect(match).not.toBeNull();
    expect(match!.isSameLocation).toBe(true);
    expect(match!.confidence).toBe(0.9);
  });

  test('B7: Location Matching — different rooms returns isSameLocation: false', async () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    const bedroomAnalysis: SceneAnalysis = {
      locationLabel: 'bedroom',
      description: 'A bedroom',
      features: ['queen bed', 'nightstands'],
      navigationHints: ['door to hallway'],
      confidence: 0.85,
    };

    const kitchenNode: SemanticNode = {
      id: 'test_kitchen',
      label: 'kitchen',
      description: 'A kitchen',
      features: ['gas stove', 'refrigerator'],
      navigationHints: ['door to hallway'],
      visitCount: 1,
      firstVisited: Date.now(),
      lastVisited: Date.now(),
    };

    const match = await map.matchLocation(bedroomAnalysis, kitchenNode);
    expect(match).not.toBeNull();
    expect(match!.isSameLocation).toBe(false);
    expect(match!.confidence).toBeLessThan(0.5);
  });

  test('B8: Map building — 4-room walkthrough with revisit detection', async () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    // Clear any persisted state from other tests
    map.loadFromJSON({ nodes: [], edges: [] });

    // hallway → kitchen → hallway (revisit) → living room
    const route = [
      { scene: SCENES.hallway_middle, pose: { x: 0, y: 150, heading: 0 } },
      { scene: SCENES.kitchen, pose: { x: 100, y: 150, heading: 90 }, action: 'turned right into kitchen' },
      { scene: SCENES.hallway_middle, pose: { x: 0, y: 150, heading: 0 }, action: 'exited kitchen back to hallway' },
      { scene: SCENES.living_room, pose: { x: -100, y: 150, heading: 270 }, action: 'turned left into living room' },
    ];

    const results = [];
    for (const step of route) {
      const result = await map.processScene(step.scene, step.pose, step.action);
      results.push(result);
    }

    const stats = map.getStats();

    // Should have 3 distinct nodes: hallway, kitchen, living room
    expect(stats.nodeCount).toBe(3);

    // Step 2 (hallway revisit) should NOT be new
    expect(results[2].isNew).toBe(false);

    // Should have edges connecting the locations
    expect(stats.edgeCount).toBeGreaterThanOrEqual(3);

    // Verify we can find locations by label
    expect(map.findNodeByLabel('kitchen')).toBeDefined();
    expect(map.findNodeByLabel('hallway')).toBeDefined();
    expect(map.findNodeByLabel('living room')).toBeDefined();
  });

  test('B9: Navigation Planning returns compilable motor command', async () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);
    const compiler = new BytecodeCompiler('fewshot');

    map.loadFromJSON({
      nodes: [
        { id: 'loc_0', label: 'hallway', description: 'Central hallway', features: ['hardwood floor'], navigationHints: ['kitchen to the right'], visitCount: 1, firstVisited: 0, lastVisited: 0 },
        { id: 'loc_1', label: 'kitchen', description: 'Kitchen with stove', features: ['gas stove'], navigationHints: ['door to hallway'], visitCount: 1, firstVisited: 0, lastVisited: 0 },
      ],
      edges: [
        { from: 'loc_0', to: 'loc_1', action: 'turn right', estimatedSteps: 500, traversalCount: 1, lastTraversed: 0 },
      ],
    });

    const decision = await map.planNavigation(SCENES.hallway_middle, 'kitchen');
    expect(decision).not.toBeNull();
    expect(decision!.motorCommand).toBe('TURN_RIGHT 100 180');

    const bytecode = compiler.compile(decision!.motorCommand);
    expect(bytecode).not.toBeNull();
    expect(bytecode!.length).toBe(6);
    expect(bytecode![0]).toBe(FRAME_START);
    expect(bytecode![1]).toBe(Opcode.TURN_RIGHT);
    expect(bytecode![5]).toBe(FRAME_END);
  });

  test('B10: Full pipeline — analyze → build map → plan → compile to 6-byte frame', async () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);
    const compiler = new BytecodeCompiler('fewshot');

    // Clear any persisted state from other tests
    map.loadFromJSON({ nodes: [], edges: [] });

    // Step 1: Process hallway
    await map.processScene(SCENES.hallway_middle, { x: 0, y: 150, heading: 0 });

    // Step 2: Process kitchen (creates edge)
    await map.processScene(SCENES.kitchen, { x: 100, y: 150, heading: 90 }, 'turned right');

    // Step 3: Plan navigation from kitchen back to hallway
    const decision = await map.planNavigation(SCENES.kitchen, 'hallway');
    expect(decision).not.toBeNull();

    // Step 4: Compile
    const bytecode = compiler.compile(decision!.motorCommand);
    expect(bytecode).not.toBeNull();
    expect(bytecode!.length).toBe(6);
    expect(bytecode![0]).toBe(0xAA);
    expect(bytecode![5]).toBe(0xFF);

    // Verify checksum
    const decoded = decodeFrame(bytecode!);
    expect(decoded).not.toBeNull();
    expect(decoded!.opcode).toBe(Opcode.TURN_RIGHT);
  });
});

// =============================================================================
// C. New Feature Integration in Pipeline
// =============================================================================

describe('Synthetic E2E — New Feature Integration', () => {
  test('C11: createStopFrame(true) produces hold-torque frame', () => {
    const compiler = new BytecodeCompiler();
    const frame = compiler.createStopFrame(true);

    expect(frame.length).toBe(6);
    expect(frame[0]).toBe(0xAA);
    expect(frame[1]).toBe(Opcode.STOP);   // 0x07
    expect(frame[2]).toBe(1);             // hold_torque = 1
    expect(frame[3]).toBe(0);
    expect(frame[4]).toBe(calculateChecksum(0x07, 1, 0)); // 0x06
    expect(frame[5]).toBe(0xFF);
    expect(formatHex(frame)).toBe('AA 07 01 00 06 FF');
  });

  test('C11b: createStopFrame(false) produces freewheel frame', () => {
    const compiler = new BytecodeCompiler();
    const frame = compiler.createStopFrame(false);

    expect(formatHex(frame)).toBe('AA 07 00 00 07 FF');
  });

  test('C13: Permissive compiler handles trailing punctuation from VLM', () => {
    const compiler = new BytecodeCompiler('fewshot');

    // Trailing period
    const result1 = compiler.compile('FORWARD 150, 150.');
    expect(result1).not.toBeNull();
    expect(result1![0]).toBe(0xAA);
    expect(result1![1]).toBe(Opcode.MOVE_FORWARD);
    expect(result1![2]).toBe(150);
    expect(result1![3]).toBe(150);

    // Trailing exclamation
    const result2 = compiler.compile('TURN_LEFT 100 80!');
    expect(result2).not.toBeNull();
    expect(result2![1]).toBe(Opcode.TURN_LEFT);

    // Markdown bold
    const result3 = compiler.compile('**FORWARD 200 200**');
    expect(result3).not.toBeNull();
    expect(result3![1]).toBe(Opcode.MOVE_FORWARD);
    expect(result3![2]).toBe(200);
  });

  test('C14: Feature fingerprint stored on new nodes and updated on revisit', async () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    // Clear any persisted state from other tests
    map.loadFromJSON({ nodes: [], edges: [] });

    // Process kitchen — should store fingerprint
    const result1 = await map.processScene(SCENES.kitchen, { x: 100, y: 150, heading: 90 });
    expect(result1.isNew).toBe(true);

    const node1 = map.getNode(result1.nodeId);
    expect(node1).toBeDefined();
    expect(node1!.featureFingerprint).toBeDefined();
    expect(node1!.featureFingerprint).toMatch(/^[0-9a-f]{8}$/);
    const firstFingerprint = node1!.featureFingerprint;

    // Process same kitchen from table — should match and update fingerprint
    const result2 = await map.processScene(SCENES.kitchen_from_table, { x: 100, y: 150, heading: 180 });
    expect(result2.isNew).toBe(false);
    expect(result2.nodeId).toBe(result1.nodeId);

    const node2 = map.getNode(result2.nodeId);
    expect(node2!.featureFingerprint).toBeDefined();
    // Fingerprint may have been updated based on the new feature set
    expect(node2!.visitCount).toBe(2);
  });
});

// =============================================================================
// C2. Spatial Feature Integration
// =============================================================================

describe('Synthetic E2E — Spatial Feature Integration', () => {
  test('C15: getSpatialNavigationHint returns LEFT for low x', () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    const features: SpatialFeature[] = [
      { label: 'red cube', bbox: { x: 50, y: 200, w: 100, h: 100 }, center: { x: 100, y: 250 } },
    ];

    const hint = map.getSpatialNavigationHint('red cube', features);
    expect(hint).not.toBeNull();
    expect(hint).toContain('LEFT');
    expect(hint).toContain('x=100');
  });

  test('C16: getSpatialNavigationHint returns RIGHT for high x', () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    const features: SpatialFeature[] = [
      { label: 'door', bbox: { x: 700, y: 200, w: 150, h: 400 }, center: { x: 775, y: 400 } },
    ];

    const hint = map.getSpatialNavigationHint('door', features);
    expect(hint).not.toBeNull();
    expect(hint).toContain('RIGHT');
  });

  test('C17: getSpatialNavigationHint returns CENTERED for middle x', () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    const features: SpatialFeature[] = [
      { label: 'hallway', bbox: { x: 350, y: 100, w: 300, h: 500 }, center: { x: 500, y: 350 } },
    ];

    const hint = map.getSpatialNavigationHint('hallway', features);
    expect(hint).not.toBeNull();
    expect(hint).toContain('CENTERED');
  });

  test('C18: getSpatialNavigationHint returns null for unknown target', () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    const features: SpatialFeature[] = [
      { label: 'door', bbox: { x: 100, y: 100, w: 100, h: 100 }, center: { x: 150, y: 150 } },
    ];

    const hint = map.getSpatialNavigationHint('red cube', features);
    expect(hint).toBeNull();
  });

  test('C19: spatialFeatures stored on nodes and round-tripped via JSON', async () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    const spatialFeatures: SpatialFeature[] = [
      { label: 'stove', bbox: { x: 400, y: 300, w: 200, h: 150 }, center: { x: 500, y: 375 } },
      { label: 'doorway', bbox: { x: 50, y: 200, w: 100, h: 400 }, center: { x: 100, y: 400 } },
    ];

    map.loadFromJSON({
      nodes: [{
        id: 'loc_0',
        label: 'kitchen',
        description: 'Kitchen with stove',
        features: ['gas stove'],
        navigationHints: ['doorway'],
        visitCount: 1,
        firstVisited: 1000,
        lastVisited: 1000,
        spatialFeatures,
      }],
      edges: [],
    });

    // Verify spatial features are on the node
    const node = map.getNode('loc_0');
    expect(node).toBeDefined();
    expect(node!.spatialFeatures).toBeDefined();
    expect(node!.spatialFeatures!.length).toBe(2);
    expect(node!.spatialFeatures![0].label).toBe('stove');
    expect(node!.spatialFeatures![0].center.x).toBe(500);

    // Round-trip via JSON serialization
    const exported = map.toJSON();
    expect(exported.nodes[0].spatialFeatures).toBeDefined();
    expect(exported.nodes[0].spatialFeatures!.length).toBe(2);

    const map2 = new SemanticMap(mockInfer);
    map2.loadFromJSON(exported);
    const node2 = map2.getNode('loc_0');
    expect(node2!.spatialFeatures).toEqual(spatialFeatures);
  });

  test('C20: nodes without spatialFeatures remain backward compatible', async () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    map.loadFromJSON({
      nodes: [{
        id: 'loc_0',
        label: 'hallway',
        description: 'Hallway',
        features: ['hardwood floor'],
        navigationHints: ['door ahead'],
        visitCount: 1,
        firstVisited: 1000,
        lastVisited: 1000,
        // No spatialFeatures — backward compatible
      }],
      edges: [],
    });

    const node = map.getNode('loc_0');
    expect(node).toBeDefined();
    expect(node!.spatialFeatures).toBeUndefined();

    // Round-trip preserves undefined
    const exported = map.toJSON();
    const map2 = new SemanticMap(mockInfer);
    map2.loadFromJSON(exported);
    expect(map2.getNode('loc_0')!.spatialFeatures).toBeUndefined();
  });
});

// =============================================================================
// D. Navigation CoT End-to-End Validation
// =============================================================================

describe('Synthetic E2E — Full Navigation CoT Validation', () => {
  test('D15: 5-node apartment map — pathfinding, summary, serialization, navigation', async () => {
    const mockInfer = createMockInference();
    const map = new SemanticMap(mockInfer);

    // Clear any persisted state from other tests
    map.loadFromJSON({ nodes: [], edges: [] });

    // Build a 5-node apartment: hallway → kitchen → living_room → bedroom → bathroom
    const route = [
      { scene: SCENES.hallway_middle, pose: { x: 0, y: 150, heading: 0 } },
      { scene: SCENES.kitchen, pose: { x: 100, y: 150, heading: 90 }, action: 'turned right into kitchen' },
      { scene: SCENES.living_room, pose: { x: -100, y: 150, heading: 270 }, action: 'returned to hallway and turned left' },
      { scene: SCENES.bedroom, pose: { x: 0, y: 300, heading: 0 }, action: 'returned to hallway and went to end' },
      { scene: SCENES.bathroom, pose: { x: 50, y: 0, heading: 90 }, action: 'returned to hallway and entered bathroom' },
    ];

    for (const step of route) {
      await map.processScene(step.scene, step.pose, step.action);
    }

    const stats = map.getStats();

    // Should have 5 distinct location nodes
    expect(stats.nodeCount).toBe(5);
    expect(stats.edgeCount).toBeGreaterThanOrEqual(4);

    // findPath returns valid paths
    const allNodes = map.getAllNodes();
    const firstNode = allNodes[0];
    const lastNode = allNodes[allNodes.length - 1];
    const path = map.findPath(firstNode.id, lastNode.id);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThanOrEqual(2);
    expect(path![0]).toBe(firstNode.id);
    expect(path![path!.length - 1]).toBe(lastNode.id);

    // getMapSummary produces readable output
    const summary = map.getMapSummary();
    expect(summary).not.toBe('(empty map)');
    expect(summary).toContain('Locations (5)');

    // toJSON/loadFromJSON round-trip preserves all nodes, edges, and fingerprints
    const exported = map.toJSON();
    expect(exported.nodes.length).toBe(5);
    expect(exported.edges.length).toBe(stats.edgeCount);

    // Verify fingerprints are preserved
    for (const node of exported.nodes) {
      expect(node.featureFingerprint).toBeDefined();
      expect(node.featureFingerprint).toMatch(/^[0-9a-f]{8}$/);
    }

    const map2 = new SemanticMap(mockInfer);
    map2.loadFromJSON(exported);
    expect(map2.getStats().nodeCount).toBe(5);
    expect(map2.getStats().edgeCount).toBe(stats.edgeCount);

    // Verify individual nodes survived round-trip
    for (const origNode of exported.nodes) {
      const restored = map2.getNode(origNode.id);
      expect(restored).toBeDefined();
      expect(restored!.label).toBe(origNode.label);
      expect(restored!.featureFingerprint).toBe(origNode.featureFingerprint);
      expect(restored!.features).toEqual(origNode.features);
    }

    // planNavigation returns motor command that compiles to bytecode
    const compiler = new BytecodeCompiler('fewshot');
    const decision = await map.planNavigation(SCENES.hallway_middle, 'kitchen');
    expect(decision).not.toBeNull();
    expect(decision!.motorCommand).toBeTruthy();

    const bytecode = compiler.compile(decision!.motorCommand);
    expect(bytecode).not.toBeNull();
    expect(bytecode!.length).toBe(6);
    expect(bytecode![0]).toBe(0xAA);
    expect(bytecode![5]).toBe(0xFF);

    // Verify valid opcode
    const decoded = decodeFrame(bytecode!);
    expect(decoded).not.toBeNull();
  });
});
