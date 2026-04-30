/**
 * Semantic Map Vision E2E Tests — Real Images Through Full Production Pipeline
 *
 * Tests the complete vision pipeline using real indoor photographs from the
 * Kaggle House Rooms Image Dataset (CC0 Public Domain):
 *   image → VLM description → SemanticMap analysis → map building →
 *   navigation planning → bytecode compilation.
 *
 * Unlike the text-based semantic-map.e2e.test.ts which feeds hand-written
 * scene descriptions to the VLM with supportsVision: false, this suite
 * tests actual image understanding through the full production path.
 *
 * Setup:
 *   1. Download fixtures (one-time):
 *      KAGGLE_USERNAME=... KAGGLE_KEY=... npx tsx __tests__/navigation/fixtures/download-kaggle-rooms.ts
 *   2. Run tests:
 *      OPENROUTER_API_KEY=sk-or-v1-... npm test -- --testPathPattern=semantic-map-vision
 */

import {
  SemanticMap,
  type SceneAnalysis,
  type SemanticNode,
} from '../../src/brain/memory/semantic_map';
import { CerebellumInference } from '../../src/brain/inference/inference';
import type { InferenceFunction } from '../../src/brain/inference/inference';
import { BytecodeCompiler, Opcode, OPCODE_NAMES } from '../../src/control/bytecode_compiler';
import {
  loadSceneFixture,
  validateFixtures,
  fixturesAvailable,
  SCENE_NAMES,
  type SceneName,
} from './fixtures/load-fixtures';
import * as fs from 'fs';
import * as path from 'path';

/** Clear persisted topo_map.json to prevent state leaking between tests */
function clearTopoMap(): void {
  const topoFile = path.join(__dirname, '../../src/3_llmunix_memory/traces/topo_map.json');
  if (fs.existsSync(topoFile)) {
    fs.unlinkSync(topoFile);
  }
}

// =============================================================================
// Config
// =============================================================================

const API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = 'qwen/qwen3-vl-8b-thinking';
const API_BASE = 'https://openrouter.ai/api/v1';

/** Timeout per test — image inference is slower than text */
const TEST_TIMEOUT = 180_000;

const hasApiKey = API_KEY.length > 0;
const hasFixtures = fixturesAvailable();
const shouldRun = hasApiKey && hasFixtures;

if (!hasApiKey) {
  console.log('Skipping vision E2E tests: OPENROUTER_API_KEY not set');
}
if (!hasFixtures) {
  console.log(
    'Skipping vision E2E tests: fixture images not found.\n' +
    '   Run: KAGGLE_USERNAME=... KAGGLE_KEY=... npx tsx __tests__/navigation/fixtures/download-kaggle-rooms.ts',
  );
}

// =============================================================================
// Inference Adapters
// =============================================================================

/** Vision-capable adapter: processes images → text descriptions */
function createVisionInference(): { infer: InferenceFunction; adapter: CerebellumInference } {
  const adapter = new CerebellumInference({
    apiKey: API_KEY,
    model: MODEL,
    apiBaseUrl: API_BASE,
    maxTokens: 1024,
    temperature: 0.3,
    timeoutMs: 180_000,
    maxRetries: 1,
    supportsVision: true,
  });
  return { infer: adapter.createInferenceFunction(), adapter };
}

/** Text-only adapter: for SemanticMap JSON analysis (no images) */
function createTextInference(): { infer: InferenceFunction; adapter: CerebellumInference } {
  const adapter = new CerebellumInference({
    apiKey: API_KEY,
    model: MODEL,
    apiBaseUrl: API_BASE,
    maxTokens: 1024,
    temperature: 0.3,
    timeoutMs: 180_000,
    maxRetries: 1,
    supportsVision: false,
  });
  return { infer: adapter.createInferenceFunction(), adapter };
}

/** Vision adapter for direct image analysis (Tier B) */
function createDirectVisionInference(): { infer: InferenceFunction; adapter: CerebellumInference } {
  const adapter = new CerebellumInference({
    apiKey: API_KEY,
    model: MODEL,
    apiBaseUrl: API_BASE,
    maxTokens: 1024,
    temperature: 0.3,
    timeoutMs: 180_000,
    maxRetries: 1,
    supportsVision: true,
  });
  return { infer: adapter.createInferenceFunction(), adapter };
}

// =============================================================================
// Helper: Describe an image using VLM (matches production SemanticMapLoop)
// =============================================================================

/**
 * Use the VLM to describe what it sees in an image.
 * Mirrors the production pipeline in semantic_map_loop.ts:154-158.
 */
async function describeImage(
  visionInfer: InferenceFunction,
  imageBase64: string,
): Promise<string> {
  return visionInfer(
    'You are a robot with a camera. Describe what you see in detail. Focus on the type of room/location, key features, and visible exits or paths.',
    'Describe the current scene for spatial mapping.',
    [imageBase64],
  );
}

// =============================================================================
// Unit Tests — Fixture Validation (no API needed)
// =============================================================================

describe('Vision Fixtures — Validation', () => {
  const skipIfNoFixtures = !hasFixtures ? test.skip : test;

  skipIfNoFixtures('all fixture images exist and are valid JPEGs', () => {
    const result = validateFixtures();

    console.log(`Available: ${result.available.length}/${SCENE_NAMES.length}`);
    if (result.errors.length > 0) {
      console.log('Errors:', result.errors);
    }

    expect(result.valid).toBe(true);
    expect(result.available.length).toBe(SCENE_NAMES.length);
    expect(result.missing.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  skipIfNoFixtures('fixture images are reasonable size (< 500KB each)', () => {
    for (const name of SCENE_NAMES) {
      const fixture = loadSceneFixture(name);
      const sizeKB = fixture.sizeBytes / 1024;
      console.log(`  ${name}: ${sizeKB.toFixed(1)} KB`);
      expect(fixture.sizeBytes).toBeLessThan(500 * 1024);
      expect(fixture.sizeBytes).toBeGreaterThan(1024);
    }
  });

  skipIfNoFixtures('fixture images have valid base64 encoding', () => {
    for (const name of SCENE_NAMES) {
      const fixture = loadSceneFixture(name);
      expect(fixture.imageBase64.length).toBeGreaterThan(100);
      expect(fixture.imageBase64.startsWith('data:')).toBe(false);
      // Round-trip: base64 → buffer → first bytes = JPEG magic
      const buf = Buffer.from(fixture.imageBase64, 'base64');
      expect(buf[0]).toBe(0xFF);
      expect(buf[1]).toBe(0xD8);
    }
  });
});

// =============================================================================
// Tier A — Full Production Pipeline (image → text description → SemanticMap)
// =============================================================================

const describeVision = shouldRun ? describe : describe.skip;

describeVision('Vision E2E — Full Pipeline (image → VLM → SemanticMap)', () => {
  let visionInfer: InferenceFunction;
  let visionAdapter: CerebellumInference;
  let textInfer: InferenceFunction;
  let textAdapter: CerebellumInference;

  beforeAll(() => {
    ({ infer: visionInfer, adapter: visionAdapter } = createVisionInference());
    ({ infer: textInfer, adapter: textAdapter } = createTextInference());
  });

  beforeEach(() => {
    clearTopoMap();
  });

  afterAll(() => {
    clearTopoMap();
    const vStats = visionAdapter.getStats();
    const tStats = textAdapter.getStats();
    console.log('\n--- Vision Inference Stats ---');
    console.log(`  Total calls: ${vStats.totalCalls}`);
    console.log(`  Successful:  ${vStats.successfulCalls}`);
    console.log(`  Failed:      ${vStats.failedCalls}`);
    console.log(`  Avg latency: ${Math.round(vStats.averageLatencyMs)}ms`);
    console.log(`  Tokens used: ${vStats.totalTokens}`);
    console.log('--- Text Inference Stats ---');
    console.log(`  Total calls: ${tStats.totalCalls}`);
    console.log(`  Successful:  ${tStats.successfulCalls}`);
    console.log(`  Avg latency: ${Math.round(tStats.averageLatencyMs)}ms`);
    console.log(`  Tokens used: ${tStats.totalTokens}`);
    console.log('-----------------------------\n');
  });

  // -------------------------------------------------------------------------
  // Test 1: VLM describes images with relevant features
  // -------------------------------------------------------------------------

  test('VLM describes kitchen image with relevant features', async () => {
    const fixture = loadSceneFixture('kitchen');
    const description = await describeImage(visionInfer, fixture.imageBase64);

    console.log('Kitchen image description:', description.slice(0, 500));
    expect(description.length).toBeGreaterThan(20);

    const lower = description.toLowerCase();
    const hasRelevantContent = [
      'kitchen', 'counter', 'cabinet', 'stove', 'refrigerator', 'fridge',
      'sink', 'appliance', 'cook', 'oven', 'tile', 'food',
    ].some(w => lower.includes(w));
    expect(hasRelevantContent).toBe(true);
  }, TEST_TIMEOUT);

  test('VLM describes bedroom image with relevant features', async () => {
    const fixture = loadSceneFixture('bedroom');
    const description = await describeImage(visionInfer, fixture.imageBase64);

    console.log('Bedroom image description:', description.slice(0, 500));
    expect(description.length).toBeGreaterThan(20);

    const lower = description.toLowerCase();
    const hasRelevantContent = [
      'bed', 'bedroom', 'room', 'pillow', 'mattress', 'nightstand',
      'lamp', 'curtain', 'furniture', 'dresser', 'sleep', 'blanket',
    ].some(w => lower.includes(w));
    expect(hasRelevantContent).toBe(true);
  }, TEST_TIMEOUT);

  test('VLM describes living room image with relevant features', async () => {
    const fixture = loadSceneFixture('living_room');
    const description = await describeImage(visionInfer, fixture.imageBase64);

    console.log('Living room image description:', description.slice(0, 500));
    expect(description.length).toBeGreaterThan(20);

    const lower = description.toLowerCase();
    const hasRelevantContent = [
      'living', 'room', 'couch', 'sofa', 'chair', 'table', 'tv',
      'television', 'rug', 'lounge', 'furniture', 'cushion', 'window',
    ].some(w => lower.includes(w));
    expect(hasRelevantContent).toBe(true);
  }, TEST_TIMEOUT);

  // -------------------------------------------------------------------------
  // Test 2: Image description → SemanticMap.analyzeScene() → structured JSON
  // -------------------------------------------------------------------------

  test('image description feeds into analyzeScene and extracts structured data', async () => {
    const fixture = loadSceneFixture('kitchen');
    const description = await describeImage(visionInfer, fixture.imageBase64);

    const map = new SemanticMap(textInfer);
    const analysis = await map.analyzeScene(description);

    expect(analysis).not.toBeNull();
    console.log('Kitchen analysis from image:', JSON.stringify(analysis, null, 2));

    expect(analysis!.locationLabel).toBeTruthy();
    expect(analysis!.locationLabel.length).toBeGreaterThan(0);
    expect(analysis!.features.length).toBeGreaterThan(0);
    expect(analysis!.confidence).toBeGreaterThan(0.3);
  }, TEST_TIMEOUT * 2);

  // -------------------------------------------------------------------------
  // Test 3: Same location from 2 descriptions → isSameLocation: true
  // -------------------------------------------------------------------------

  test('same kitchen from two VLM descriptions → location match', async () => {
    const kitchenFixture = loadSceneFixture('kitchen');

    // Two descriptions of the same image (VLM outputs may vary slightly)
    const desc1 = await describeImage(visionInfer, kitchenFixture.imageBase64);
    const desc2 = await describeImage(visionInfer, kitchenFixture.imageBase64);

    const map = new SemanticMap(textInfer);
    const analysis1 = await map.analyzeScene(desc1);
    const analysis2 = await map.analyzeScene(desc2);

    expect(analysis1).not.toBeNull();
    expect(analysis2).not.toBeNull();

    console.log('Kitchen desc 1 label:', analysis1!.locationLabel);
    console.log('Kitchen desc 2 label:', analysis2!.locationLabel);

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
    console.log('Same-kitchen match:', JSON.stringify(match, null, 2));

    expect(match!.isSameLocation).toBe(true);
    expect(match!.confidence).toBeGreaterThan(0.5);
  }, TEST_TIMEOUT * 3);

  // -------------------------------------------------------------------------
  // Test 4: Kitchen vs bedroom → isSameLocation: false
  // -------------------------------------------------------------------------

  test('kitchen vs bedroom images → different locations', async () => {
    const kitchenFixture = loadSceneFixture('kitchen');
    const bedroomFixture = loadSceneFixture('bedroom');

    const kitchenDesc = await describeImage(visionInfer, kitchenFixture.imageBase64);
    const bedroomDesc = await describeImage(visionInfer, bedroomFixture.imageBase64);

    const map = new SemanticMap(textInfer);
    const kitchenAnalysis = await map.analyzeScene(kitchenDesc);
    const bedroomAnalysis = await map.analyzeScene(bedroomDesc);

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
    console.log('Kitchen vs bedroom match:', JSON.stringify(match, null, 2));

    expect(match!.isSameLocation).toBe(false);
  }, TEST_TIMEOUT * 3);

  // -------------------------------------------------------------------------
  // Test 5: Sequential room visits build topological map
  // -------------------------------------------------------------------------

  test('sequential image visits build topological map with correct structure', async () => {
    const map = new SemanticMap(textInfer);

    // Visit 3 distinct rooms: kitchen → bedroom → living_room
    const route: Array<{ scene: SceneName; action?: string }> = [
      { scene: 'kitchen' },
      { scene: 'bedroom', action: 'moved through doorway into bedroom' },
      { scene: 'living_room', action: 'moved through doorway into living room' },
    ];

    const visitLog: Array<{ scene: string; nodeId: string; isNew: boolean; label: string }> = [];

    for (const step of route) {
      const fixture = loadSceneFixture(step.scene);
      const description = await describeImage(visionInfer, fixture.imageBase64);
      const result = await map.processScene(description, undefined, step.action);

      visitLog.push({
        scene: step.scene,
        nodeId: result.nodeId,
        isNew: result.isNew,
        label: result.analysis.locationLabel,
      });

      console.log(
        `  ${step.scene}: ${result.isNew ? 'NEW' : 'REVISIT'} -> ` +
        `${result.nodeId} (${result.analysis.locationLabel})`,
      );
    }

    const stats = map.getStats();
    console.log('\nMap stats:', stats);
    console.log('Map summary:\n' + map.getMapSummary());

    // Should have created at least 2 distinct nodes
    expect(stats.nodeCount).toBeGreaterThanOrEqual(2);
    expect(stats.nodeCount).toBeLessThanOrEqual(3);

    // Should have edges connecting locations
    expect(stats.edgeCount).toBeGreaterThanOrEqual(1);

    // Verify serialization round-trip
    const exported = map.toJSON();
    expect(exported.nodes.length).toBe(stats.nodeCount);
    expect(exported.edges.length).toBe(stats.edgeCount);
  }, TEST_TIMEOUT * 8);

  // -------------------------------------------------------------------------
  // Test 6: Full pipeline — image → description → map → nav → bytecode
  // -------------------------------------------------------------------------

  test('full pipeline: image → description → map → navigation → bytecode', async () => {
    const map = new SemanticMap(textInfer);
    const compiler = new BytecodeCompiler('fewshot');

    // Step 1: Analyze kitchen image
    console.log('\n=== Step 1: Analyze kitchen image ===');
    const kitchenFixture = loadSceneFixture('kitchen');
    const kitchenDesc = await describeImage(visionInfer, kitchenFixture.imageBase64);
    const kitchenResult = await map.processScene(kitchenDesc);
    console.log(`  Node: ${kitchenResult.nodeId} (${kitchenResult.analysis.locationLabel})`);
    expect(kitchenResult.isNew).toBe(true);

    // Step 2: Analyze bedroom image (visually distinct from kitchen)
    console.log('\n=== Step 2: Analyze bedroom image ===');
    const bedroomFixture = loadSceneFixture('bedroom');
    const bedroomDesc = await describeImage(visionInfer, bedroomFixture.imageBase64);
    const bedroomResult = await map.processScene(bedroomDesc, undefined, 'moved through doorway');
    console.log(`  Node: ${bedroomResult.nodeId} (${bedroomResult.analysis.locationLabel})`);
    expect(bedroomResult.isNew).toBe(true);
    expect(map.getStats().edgeCount).toBeGreaterThanOrEqual(1);

    // Step 3: Plan navigation back to kitchen
    console.log('\n=== Step 3: Plan navigation to kitchen ===');
    const navDecision = await map.planNavigation(bedroomDesc, 'kitchen');
    expect(navDecision).not.toBeNull();
    console.log(`  Action: ${navDecision!.action}`);
    console.log(`  Reasoning: ${navDecision!.reasoning}`);
    console.log(`  Motor: ${navDecision!.motorCommand}`);

    // Step 4: Compile to bytecode
    console.log('\n=== Step 4: Compile to bytecode ===');
    const bytecode = compiler.compile(navDecision!.motorCommand);
    if (bytecode) {
      const opcodeName = OPCODE_NAMES[bytecode[1]] || 'UNKNOWN';
      console.log(`  Bytecode: ${Array.from(bytecode).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`);
      console.log(`  Opcode: ${opcodeName}`);
      expect(bytecode.length).toBe(6);
      expect(bytecode[0]).toBe(0xAA);
      expect(bytecode[5]).toBe(0xFF);

      const movementOpcodes = [
        Opcode.MOVE_FORWARD, Opcode.MOVE_BACKWARD,
        Opcode.TURN_LEFT, Opcode.TURN_RIGHT,
        Opcode.ROTATE_CW, Opcode.ROTATE_CCW,
      ];
      expect(movementOpcodes).toContain(bytecode[1]);
    } else {
      console.log(`  Motor command "${navDecision!.motorCommand}" did not compile — acceptable`);
    }

    // Final map state
    console.log('\n=== Final Map ===');
    console.log(map.getMapSummary());
    expect(map.getStats().nodeCount).toBeGreaterThanOrEqual(2);
  }, TEST_TIMEOUT * 5);
});

// =============================================================================
// Tier B — Direct Vision (images passed directly to SemanticMap)
// =============================================================================

describeVision('Vision E2E — Direct Image Analysis (Tier B)', () => {
  let directInfer: InferenceFunction;
  let directAdapter: CerebellumInference;

  beforeAll(() => {
    ({ infer: directInfer, adapter: directAdapter } = createDirectVisionInference());
  });

  beforeEach(() => {
    clearTopoMap();
  });

  afterAll(() => {
    clearTopoMap();
    const stats = directAdapter.getStats();
    console.log('\n--- Direct Vision Stats ---');
    console.log(`  Total calls: ${stats.totalCalls}`);
    console.log(`  Successful:  ${stats.successfulCalls}`);
    console.log(`  Avg latency: ${Math.round(stats.averageLatencyMs)}ms`);
    console.log('---------------------------\n');
  });

  // -------------------------------------------------------------------------
  // Test: analyzeScene with image passed directly (no intermediate text)
  // -------------------------------------------------------------------------

  test('analyzeScene with image passed directly extracts structured data', async () => {
    const map = new SemanticMap(directInfer);
    const fixture = loadSceneFixture('kitchen');

    const analysis = await map.analyzeScene(
      'Analyze this camera image and identify the location.',
      [fixture.imageBase64],
    );

    expect(analysis).not.toBeNull();
    console.log('Direct vision analysis:', JSON.stringify(analysis, null, 2));

    expect(analysis!.locationLabel).toBeTruthy();
    expect(analysis!.features.length).toBeGreaterThan(0);
    expect(analysis!.confidence).toBeGreaterThan(0.3);
  }, TEST_TIMEOUT);

  // -------------------------------------------------------------------------
  // Test: processScene with image — builds map from images in one step
  // -------------------------------------------------------------------------

  test('processScene with images builds map directly from camera input', async () => {
    const map = new SemanticMap(directInfer);

    // Process kitchen image
    const kitchenFixture = loadSceneFixture('kitchen');
    const kitchenResult = await map.processScene(
      'Analyze this camera image and identify the location.',
      undefined,
      undefined,
      [kitchenFixture.imageBase64],
    );
    console.log(`Kitchen: ${kitchenResult.nodeId} (${kitchenResult.analysis.locationLabel})`);
    expect(kitchenResult.isNew).toBe(true);

    // Process bedroom image
    const bedroomFixture = loadSceneFixture('bedroom');
    const bedroomResult = await map.processScene(
      'Analyze this camera image and identify the location.',
      undefined,
      'moved forward into next room',
      [bedroomFixture.imageBase64],
    );
    console.log(`Bedroom: ${bedroomResult.nodeId} (${bedroomResult.analysis.locationLabel})`);
    expect(bedroomResult.isNew).toBe(true);

    const stats = map.getStats();
    console.log(`Map: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
    expect(stats.nodeCount).toBe(2);
    expect(stats.edgeCount).toBeGreaterThanOrEqual(1);
  }, TEST_TIMEOUT * 4);
});
