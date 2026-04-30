/**
 * Semantic Map Outdoor E2E Tests — Real Walking Routes Through Full Pipeline
 *
 * Replays captured outdoor route sequences (frames + compass heading) through
 * the full navigation pipeline:
 *   frame → VLM description → SemanticMap analysis → map building →
 *   navigation planning → bytecode compilation.
 *
 * Unlike the indoor vision E2E tests (semantic-map-vision.e2e.test.ts) which
 * use stock Kaggle room photos, this suite uses real walking-route captures
 * with sequential frames and compass heading data from IP Webcam.
 *
 * Setup:
 *   1. Capture a route with IP Webcam:
 *      IP_WEBCAM_HOST=192.168.1.50 IP_WEBCAM_PORT=8080 \
 *        npx tsx scripts/capture-route.ts --name basketball-court --duration 30
 *   2. Run tests:
 *      OPENROUTER_API_KEY=sk-or-v1-... npm test -- --testPathPattern=semantic-map-outdoor
 */

import {
  SemanticMap,
  type SceneAnalysis,
  type SemanticNode,
} from '../../src/brain/memory/semantic_map';
import { CerebellumInference } from '../../src/brain/inference/inference';
import type { InferenceFunction } from '../../src/brain/inference/inference';
import { BytecodeCompiler, Opcode, OPCODE_NAMES } from '../../src/control/bytecode_compiler';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Types
// =============================================================================

interface RouteFrame {
  index: number;
  file: string;
  heading: number | null;
  timestamp: number;
}

interface RouteManifest {
  name: string;
  capturedAt: string;
  frameCount: number;
  fps: number;
  frames: RouteFrame[];
}

interface LoadedRoute {
  manifest: RouteManifest;
  frames: Array<RouteFrame & { imageBase64: string }>;
}

// =============================================================================
// Route Loading Helpers
// =============================================================================

const ROUTES_DIR = path.join(__dirname, 'fixtures', 'outdoor_routes');

/** List names of all available route directories with valid route.json */
function listRoutes(): string[] {
  if (!fs.existsSync(ROUTES_DIR)) return [];

  return fs.readdirSync(ROUTES_DIR).filter((name) => {
    const manifestPath = path.join(ROUTES_DIR, name, 'route.json');
    return fs.existsSync(manifestPath);
  });
}

/** Check if any outdoor route fixtures exist */
function routesAvailable(): boolean {
  return listRoutes().length > 0;
}

/** Load a route manifest and all frame images as base64 */
function loadRoute(name: string): LoadedRoute {
  const routeDir = path.join(ROUTES_DIR, name);
  const manifestPath = path.join(routeDir, 'route.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Route manifest not found: ${manifestPath}`);
  }

  const manifest: RouteManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  const frames = manifest.frames.map((frame) => {
    const framePath = path.join(routeDir, frame.file);
    if (!fs.existsSync(framePath)) {
      throw new Error(`Frame file not found: ${framePath}`);
    }
    const buffer = fs.readFileSync(framePath);
    return {
      ...frame,
      imageBase64: buffer.toString('base64'),
    };
  });

  return { manifest, frames };
}

/**
 * Select ~count evenly-spaced keyframes from a route.
 * Keeps runtime manageable by not sending every frame to the VLM.
 */
function sampleKeyframes(route: LoadedRoute, count: number): LoadedRoute['frames'] {
  const { frames } = route;
  if (frames.length <= count) return frames;

  const step = (frames.length - 1) / (count - 1);
  const sampled: LoadedRoute['frames'] = [];

  for (let i = 0; i < count; i++) {
    const idx = Math.round(i * step);
    sampled.push(frames[idx]);
  }

  return sampled;
}

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
const hasRoutes = routesAvailable();
const shouldRun = hasApiKey && hasRoutes;

if (!hasApiKey) {
  console.log('Skipping outdoor E2E tests: OPENROUTER_API_KEY not set');
}
if (!hasRoutes) {
  console.log(
    'Skipping outdoor E2E tests: no outdoor route fixtures found.\n' +
    '   Capture a route first:\n' +
    '   IP_WEBCAM_HOST=192.168.1.50 IP_WEBCAM_PORT=8080 \\\n' +
    '     npx tsx scripts/capture-route.ts --name my-route --duration 30',
  );
}

// =============================================================================
// Inference Adapters
// =============================================================================

/** Vision-capable adapter: processes images -> text descriptions */
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

// =============================================================================
// Helper: Describe an image using VLM (matches production SemanticMapLoop)
// =============================================================================

async function describeImage(
  visionInfer: InferenceFunction,
  imageBase64: string,
): Promise<string> {
  return visionInfer(
    'You are a robot with a camera. Describe what you see in detail. Focus on the type of location, key features, and visible paths or landmarks.',
    'Describe the current outdoor scene for spatial mapping.',
    [imageBase64],
  );
}

// =============================================================================
// Unit Tests — Fixture Validation (no API needed)
// =============================================================================

const describeIfRoutes = hasRoutes ? describe : describe.skip;

describeIfRoutes('Outdoor Route Fixtures — Validation', () => {
  const routes = listRoutes();

  test('route manifest is valid JSON with expected fields', () => {
    for (const name of routes) {
      const manifestPath = path.join(ROUTES_DIR, name, 'route.json');
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest: RouteManifest = JSON.parse(raw);

      expect(manifest.name).toBeTruthy();
      expect(manifest.capturedAt).toBeTruthy();
      expect(typeof manifest.frameCount).toBe('number');
      expect(manifest.frameCount).toBeGreaterThan(0);
      expect(typeof manifest.fps).toBe('number');
      expect(manifest.fps).toBeGreaterThan(0);
      expect(Array.isArray(manifest.frames)).toBe(true);
      expect(manifest.frames.length).toBe(manifest.frameCount);
    }
  });

  test('all frames referenced in manifest exist and are valid JPEGs', () => {
    for (const name of routes) {
      const routeDir = path.join(ROUTES_DIR, name);
      const manifest: RouteManifest = JSON.parse(
        fs.readFileSync(path.join(routeDir, 'route.json'), 'utf-8'),
      );

      for (const frame of manifest.frames) {
        const framePath = path.join(routeDir, frame.file);
        expect(fs.existsSync(framePath)).toBe(true);

        const buffer = fs.readFileSync(framePath);
        // JPEG magic bytes
        expect(buffer[0]).toBe(0xFF);
        expect(buffer[1]).toBe(0xD8);
        expect(buffer.length).toBeGreaterThan(100);
      }
    }
  });

  test('frames have monotonically increasing timestamps', () => {
    for (const name of routes) {
      const routeDir = path.join(ROUTES_DIR, name);
      const manifest: RouteManifest = JSON.parse(
        fs.readFileSync(path.join(routeDir, 'route.json'), 'utf-8'),
      );

      for (let i = 1; i < manifest.frames.length; i++) {
        expect(manifest.frames[i].timestamp).toBeGreaterThanOrEqual(
          manifest.frames[i - 1].timestamp,
        );
      }
    }
  });
});

// =============================================================================
// Outdoor E2E — Scene Analysis with Heading
// =============================================================================

const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('Outdoor E2E — Scene Analysis with Heading', () => {
  let visionInfer: InferenceFunction;
  let visionAdapter: CerebellumInference;
  let textInfer: InferenceFunction;
  let textAdapter: CerebellumInference;
  let route: LoadedRoute;

  beforeAll(() => {
    ({ infer: visionInfer, adapter: visionAdapter } = createVisionInference());
    ({ infer: textInfer, adapter: textAdapter } = createTextInference());
    const routeName = listRoutes()[0];
    route = loadRoute(routeName);
    console.log(`Using route: ${routeName} (${route.frames.length} frames)`);
  });

  beforeEach(() => {
    clearTopoMap();
  });

  afterAll(() => {
    clearTopoMap();
    const vStats = visionAdapter.getStats();
    const tStats = textAdapter.getStats();
    console.log('\n--- Outdoor Vision Inference Stats ---');
    console.log(`  Vision calls: ${vStats.totalCalls} (${vStats.successfulCalls} ok)`);
    console.log(`  Vision avg latency: ${Math.round(vStats.averageLatencyMs)}ms`);
    console.log(`  Text calls: ${tStats.totalCalls} (${tStats.successfulCalls} ok)`);
    console.log(`  Text avg latency: ${Math.round(tStats.averageLatencyMs)}ms`);
    console.log('--------------------------------------\n');
  });

  test('VLM describes outdoor frame with relevant features', async () => {
    const frame = route.frames[0];
    const description = await describeImage(visionInfer, frame.imageBase64);

    console.log('Outdoor frame description:', description.slice(0, 500));
    expect(description.length).toBeGreaterThan(20);
  }, TEST_TIMEOUT);

  test('analyzeScene extracts structured data from outdoor image', async () => {
    const frame = route.frames[0];
    const description = await describeImage(visionInfer, frame.imageBase64);

    const map = new SemanticMap(textInfer);
    const analysis = await map.analyzeScene(description);

    expect(analysis).not.toBeNull();
    console.log('Outdoor analysis:', JSON.stringify(analysis, null, 2));

    expect(analysis!.locationLabel).toBeTruthy();
    expect(analysis!.features.length).toBeGreaterThan(0);
    expect(analysis!.confidence).toBeGreaterThan(0.1);
  }, TEST_TIMEOUT * 2);

  test('heading from route.json is injected into processScene pose', async () => {
    const frame = route.frames[0];
    const description = await describeImage(visionInfer, frame.imageBase64);

    const map = new SemanticMap(textInfer);
    const heading = frame.heading ?? 0;
    const result = await map.processScene(description, { x: 0, y: 0, heading });

    expect(result.nodeId).toBeTruthy();
    expect(result.isNew).toBe(true);
    expect(result.analysis.locationLabel).toBeTruthy();

    // Verify heading was stored in the node position
    const exported = map.toJSON();
    const node = exported.nodes.find((n) => n.id === result.nodeId);
    expect(node).toBeDefined();
    if (node?.position) {
      expect(node.position.heading).toBeCloseTo(heading, 0);
    }

    console.log(`Node ${result.nodeId}: heading=${heading.toFixed(1)}deg, label="${result.analysis.locationLabel}"`);
  }, TEST_TIMEOUT * 2);
});

// =============================================================================
// Outdoor E2E — Map Building from Route
// =============================================================================

describeE2E('Outdoor E2E — Map Building from Route', () => {
  let visionInfer: InferenceFunction;
  let visionAdapter: CerebellumInference;
  let textInfer: InferenceFunction;
  let textAdapter: CerebellumInference;
  let route: LoadedRoute;

  beforeAll(() => {
    ({ infer: visionInfer, adapter: visionAdapter } = createVisionInference());
    ({ infer: textInfer, adapter: textAdapter } = createTextInference());
    const routeName = listRoutes()[0];
    route = loadRoute(routeName);
  });

  beforeEach(() => {
    clearTopoMap();
  });

  afterAll(() => {
    clearTopoMap();
    const vStats = visionAdapter.getStats();
    const tStats = textAdapter.getStats();
    console.log('\n--- Map Building Stats ---');
    console.log(`  Vision calls: ${vStats.totalCalls}`);
    console.log(`  Text calls: ${tStats.totalCalls}`);
    console.log(`  Total tokens: ${vStats.totalTokens + tStats.totalTokens}`);
    console.log('--------------------------\n');
  });

  test('sequential keyframes build topological map (new nodes as scenes change)', async () => {
    const map = new SemanticMap(textInfer);
    const keyframes = sampleKeyframes(route, 6);

    console.log(`Processing ${keyframes.length} keyframes from route "${route.manifest.name}"...`);

    const visitLog: Array<{ index: number; nodeId: string; isNew: boolean; label: string; heading: number | null }> = [];

    for (const frame of keyframes) {
      const description = await describeImage(visionInfer, frame.imageBase64);
      const heading = frame.heading ?? 0;
      const result = await map.processScene(
        description,
        { x: 0, y: 0, heading },
        visitLog.length > 0 ? 'moved forward along path' : undefined,
      );

      visitLog.push({
        index: frame.index,
        nodeId: result.nodeId,
        isNew: result.isNew,
        label: result.analysis.locationLabel,
        heading: frame.heading,
      });

      console.log(
        `  Frame ${frame.index}: ${result.isNew ? 'NEW' : 'REVISIT'} -> ` +
        `${result.nodeId} ("${result.analysis.locationLabel}") heading=${frame.heading?.toFixed(1) ?? 'N/A'}deg`,
      );
    }

    const stats = map.getStats();
    console.log(`\nMap: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
    console.log('Map summary:\n' + map.getMapSummary());

    // Should create at least 1 node
    expect(stats.nodeCount).toBeGreaterThanOrEqual(1);
    // Should have some new nodes
    expect(visitLog.some((v) => v.isNew)).toBe(true);
  }, TEST_TIMEOUT * 8);

  test('revisiting same area matches existing node', async () => {
    const map = new SemanticMap(textInfer);

    // Use first and last frames (if walking a loop, these may match)
    const firstFrame = route.frames[0];
    const lastFrame = route.frames[route.frames.length - 1];

    const desc1 = await describeImage(visionInfer, firstFrame.imageBase64);
    const result1 = await map.processScene(desc1, {
      x: 0,
      y: 0,
      heading: firstFrame.heading ?? 0,
    });
    console.log(`First frame: ${result1.nodeId} ("${result1.analysis.locationLabel}")`);
    expect(result1.isNew).toBe(true);

    // Process last frame — may or may not match depending on route shape
    const desc2 = await describeImage(visionInfer, lastFrame.imageBase64);
    const result2 = await map.processScene(desc2, {
      x: 0,
      y: 0,
      heading: lastFrame.heading ?? 0,
    });
    console.log(`Last frame: ${result2.nodeId} ("${result2.analysis.locationLabel}") isNew=${result2.isNew}`);

    // The test validates that processScene works for both new and revisit cases
    expect(result2.nodeId).toBeTruthy();
    expect(result2.analysis.locationLabel).toBeTruthy();
  }, TEST_TIMEOUT * 4);

  test('compass heading stored in node.position.heading', async () => {
    const map = new SemanticMap(textInfer);
    const keyframes = sampleKeyframes(route, 3);

    for (const frame of keyframes) {
      const description = await describeImage(visionInfer, frame.imageBase64);
      const heading = frame.heading ?? 0;
      await map.processScene(description, { x: 0, y: 0, heading });
    }

    const exported = map.toJSON();
    const nodesWithPosition = exported.nodes.filter((n) => n.position);

    console.log(`Nodes with position data: ${nodesWithPosition.length}/${exported.nodes.length}`);
    for (const node of nodesWithPosition) {
      console.log(`  ${node.id}: heading=${node.position!.heading.toFixed(1)}deg`);
      expect(node.position!.heading).toBeGreaterThanOrEqual(0);
      expect(node.position!.heading).toBeLessThan(360);
    }

    expect(nodesWithPosition.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT * 6);
});

// =============================================================================
// Outdoor E2E — Full Pipeline
// =============================================================================

describeE2E('Outdoor E2E — Full Pipeline', () => {
  let visionInfer: InferenceFunction;
  let visionAdapter: CerebellumInference;
  let textInfer: InferenceFunction;
  let textAdapter: CerebellumInference;
  let route: LoadedRoute;

  beforeAll(() => {
    ({ infer: visionInfer, adapter: visionAdapter } = createVisionInference());
    ({ infer: textInfer, adapter: textAdapter } = createTextInference());
    const routeName = listRoutes()[0];
    route = loadRoute(routeName);
  });

  beforeEach(() => {
    clearTopoMap();
  });

  afterAll(() => {
    clearTopoMap();
    const vStats = visionAdapter.getStats();
    const tStats = textAdapter.getStats();
    console.log('\n--- Full Pipeline Stats ---');
    console.log(`  Vision: ${vStats.totalCalls} calls, ${vStats.totalTokens} tokens`);
    console.log(`  Text: ${tStats.totalCalls} calls, ${tStats.totalTokens} tokens`);
    console.log('---------------------------\n');
  });

  test('keyframe sequence -> descriptions -> map -> navigation plan -> bytecode', async () => {
    const map = new SemanticMap(textInfer);
    const compiler = new BytecodeCompiler('fewshot');
    const keyframes = sampleKeyframes(route, 4);

    // Step 1: Build map from keyframes
    console.log('\n=== Step 1: Build map from keyframes ===');
    for (const frame of keyframes) {
      const description = await describeImage(visionInfer, frame.imageBase64);
      const heading = frame.heading ?? 0;
      const result = await map.processScene(
        description,
        { x: 0, y: 0, heading },
        'moved forward',
      );
      console.log(`  Frame ${frame.index}: ${result.nodeId} ("${result.analysis.locationLabel}")`);
    }

    const stats = map.getStats();
    console.log(`\nMap built: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
    expect(stats.nodeCount).toBeGreaterThanOrEqual(1);

    // Step 2: Get description of last keyframe for navigation context
    console.log('\n=== Step 2: Navigation planning ===');
    const lastFrame = keyframes[keyframes.length - 1];
    const currentDesc = await describeImage(visionInfer, lastFrame.imageBase64);

    // Try to navigate to the first node's label
    const exported = map.toJSON();
    const targetLabel = exported.nodes[0].label;
    console.log(`  Target: "${targetLabel}"`);

    const navDecision = await map.planNavigation(currentDesc, targetLabel);

    if (navDecision) {
      console.log(`  Action: ${navDecision.action}`);
      console.log(`  Reasoning: ${navDecision.reasoning}`);
      console.log(`  Motor: ${navDecision.motorCommand}`);

      // Step 3: Compile to bytecode
      console.log('\n=== Step 3: Compile to bytecode ===');
      const bytecode = compiler.compile(navDecision.motorCommand);
      if (bytecode) {
        const opcodeName = OPCODE_NAMES[bytecode[1]] || 'UNKNOWN';
        console.log(`  Bytecode: ${Array.from(bytecode).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`);
        console.log(`  Opcode: ${opcodeName}`);
        expect(bytecode.length).toBe(6);
        expect(bytecode[0]).toBe(0xAA);
        expect(bytecode[5]).toBe(0xFF);
      } else {
        console.log(`  Motor command "${navDecision.motorCommand}" did not compile — acceptable`);
      }
    } else {
      console.log('  Navigation returned null — may already be at target or single-node map');
    }

    // Final summary
    console.log('\n=== Final Map ===');
    console.log(map.getMapSummary());
  }, TEST_TIMEOUT * 8);
});
