import { EventEmitter } from 'events';
import { SemanticMapLoop } from '../../src/3_llmunix_memory/semantic_map_loop';
import { SemanticMap } from '../../src/3_llmunix_memory/semantic_map';
import type { VisionLoop } from '../../src/2_qwen_cerebellum/vision_loop';
import type { InferenceFunction } from '../../src/2_qwen_cerebellum/inference';
import { BytecodeCompiler, Opcode } from '../../src/2_qwen_cerebellum/bytecode_compiler';
import type { UDPTransmitter } from '../../src/2_qwen_cerebellum/udp_transmitter';

// Mock SemanticMap to avoid real VLM calls and file I/O
jest.mock('../../src/3_llmunix_memory/semantic_map', () => {
  const actual = jest.requireActual('../../src/3_llmunix_memory/semantic_map');
  return {
    ...actual,
    SemanticMap: jest.fn().mockImplementation(() => ({
      processScene: jest.fn().mockResolvedValue({
        nodeId: 'loc_0',
        isNew: true,
        analysis: {
          locationLabel: 'hallway',
          description: 'A long hallway',
          features: ['tile floor'],
          navigationHints: ['door ahead'],
          confidence: 0.85,
        },
      }),
      analyzeScene: jest.fn(),
      getAllNodes: jest.fn().mockReturnValue([]),
      getMapSummary: jest.fn().mockReturnValue('(empty map)'),
    })),
  };
});

describe('SemanticMapLoop', () => {
  let loop: SemanticMapLoop;
  let mockSemanticMap: jest.Mocked<SemanticMap>;
  let mockVisionLoop: EventEmitter & { getLatestFrameBase64: jest.Mock };
  let mockInfer: jest.Mock;
  let mockTransmitter: jest.Mocked<UDPTransmitter>;
  let compiler: BytecodeCompiler;

  beforeEach(() => {
    mockSemanticMap = new SemanticMap(jest.fn()) as jest.Mocked<SemanticMap>;

    mockVisionLoop = Object.assign(new EventEmitter(), {
      getLatestFrameBase64: jest.fn().mockReturnValue('dGVzdGZyYW1l'),
    });

    mockInfer = jest.fn().mockResolvedValue('A hallway with tile floors and a door ahead.');

    mockTransmitter = {
      send: jest.fn().mockResolvedValue(undefined),
      sendAndReceive: jest.fn().mockResolvedValue(
        Buffer.from('{"pose":{"x":1.0,"y":2.0,"h":0.5},"run":false}'),
      ),
      isConnected: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<UDPTransmitter>;

    compiler = new BytecodeCompiler('fewshot');

    loop = new SemanticMapLoop(
      mockSemanticMap,
      mockVisionLoop as unknown as VisionLoop,
      mockInfer as InferenceFunction,
      compiler,
      mockTransmitter,
      { analyzeIntervalSec: 1 },  // short interval for testing
    );
  });

  afterEach(() => {
    loop.stop();
  });

  // ===========================================================================
  // Interval respect
  // ===========================================================================

  test('respects analyzeIntervalSec — does not analyze more often', async () => {
    loop.start();

    // First bytecode event triggers analysis
    mockVisionLoop.emit('bytecode', Buffer.alloc(6), 'FORWARD 100 100');
    await new Promise(r => setTimeout(r, 50));

    expect(mockSemanticMap.processScene).toHaveBeenCalledTimes(1);

    // Second bytecode event within the interval should NOT trigger
    mockSemanticMap.processScene.mockClear();
    mockVisionLoop.emit('bytecode', Buffer.alloc(6), 'FORWARD 100 100');
    await new Promise(r => setTimeout(r, 50));

    expect(mockSemanticMap.processScene).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Mutex
  // ===========================================================================

  test('mutex prevents concurrent analyses', async () => {
    let resolveFirst: (() => void) | null = null;
    const slowPromise = new Promise<{ nodeId: string; isNew: boolean; analysis: { locationLabel: string; description: string; features: string[]; navigationHints: string[]; confidence: number } }>(
      (resolve) => {
        resolveFirst = () => resolve({
          nodeId: 'loc_0',
          isNew: true,
          analysis: {
            locationLabel: 'hallway',
            description: 'A long hallway',
            features: ['tile floor'],
            navigationHints: ['door ahead'],
            confidence: 0.85,
          },
        });
      },
    );

    mockSemanticMap.processScene.mockReturnValueOnce(slowPromise);

    loop = new SemanticMapLoop(
      mockSemanticMap,
      mockVisionLoop as unknown as VisionLoop,
      mockInfer as InferenceFunction,
      compiler,
      mockTransmitter,
      { analyzeIntervalSec: 0 },  // no delay between analyses
    );
    loop.start();

    // First event starts a slow analysis
    mockVisionLoop.emit('bytecode', Buffer.alloc(6), 'FORWARD 100 100');
    await new Promise(r => setTimeout(r, 20));

    // Second event should be blocked by mutex
    mockVisionLoop.emit('bytecode', Buffer.alloc(6), 'FORWARD 100 100');
    await new Promise(r => setTimeout(r, 20));

    // processScene was called only once (second was blocked)
    expect(mockSemanticMap.processScene).toHaveBeenCalledTimes(1);

    // Resolve the first analysis
    resolveFirst!();
    await new Promise(r => setTimeout(r, 20));
  });

  // ===========================================================================
  // Failure isolation
  // ===========================================================================

  test('analysis failure does not crash the loop', async () => {
    mockSemanticMap.processScene.mockRejectedValueOnce(new Error('VLM timeout'));

    loop = new SemanticMapLoop(
      mockSemanticMap,
      mockVisionLoop as unknown as VisionLoop,
      mockInfer as InferenceFunction,
      compiler,
      mockTransmitter,
      { analyzeIntervalSec: 0 },
    );
    loop.start();

    // This should not throw
    mockVisionLoop.emit('bytecode', Buffer.alloc(6), 'FORWARD 100 100');
    await new Promise(r => setTimeout(r, 50));

    expect(loop.isRunning()).toBe(true);

    // Next analysis should work
    mockSemanticMap.processScene.mockResolvedValueOnce({
      nodeId: 'loc_1',
      isNew: true,
      analysis: {
        locationLabel: 'kitchen',
        description: 'A kitchen',
        features: ['stove'],
        navigationHints: ['door to left'],
        confidence: 0.9,
      },
    });

    mockVisionLoop.emit('bytecode', Buffer.alloc(6), 'FORWARD 100 100');
    await new Promise(r => setTimeout(r, 50));

    expect(mockSemanticMap.processScene).toHaveBeenCalledTimes(2);
  });

  // ===========================================================================
  // stop()
  // ===========================================================================

  test('stop() halts further analyses', async () => {
    loop = new SemanticMapLoop(
      mockSemanticMap,
      mockVisionLoop as unknown as VisionLoop,
      mockInfer as InferenceFunction,
      compiler,
      mockTransmitter,
      { analyzeIntervalSec: 0 },
    );
    loop.start();
    loop.stop();

    mockVisionLoop.emit('bytecode', Buffer.alloc(6), 'FORWARD 100 100');
    await new Promise(r => setTimeout(r, 50));

    expect(mockSemanticMap.processScene).not.toHaveBeenCalled();
    expect(loop.isRunning()).toBe(false);
  });

  // ===========================================================================
  // analyzeNow()
  // ===========================================================================

  test('analyzeNow() returns SceneAnalysis on demand', async () => {
    const analysis = await loop.analyzeNow();

    expect(analysis).not.toBeNull();
    expect(analysis!.locationLabel).toBe('hallway');
    expect(analysis!.confidence).toBe(0.85);
    expect(mockSemanticMap.processScene).toHaveBeenCalledTimes(1);
  });

  test('analyzeNow() returns null when no frame available', async () => {
    mockVisionLoop.getLatestFrameBase64.mockReturnValue('');

    const analysis = await loop.analyzeNow();
    expect(analysis).toBeNull();
  });

  // ===========================================================================
  // VisionLoop events not blocked
  // ===========================================================================

  test('VisionLoop bytecode events are never blocked', async () => {
    // Make processScene slow
    let resolveSlowAnalysis: (() => void) = () => {};
    mockSemanticMap.processScene.mockImplementation(
      () => new Promise(resolve => {
        resolveSlowAnalysis = () => resolve({
          nodeId: 'loc_0',
          isNew: true,
          analysis: {
            locationLabel: 'hallway',
            description: 'A long hallway',
            features: ['tile floor'],
            navigationHints: ['door ahead'],
            confidence: 0.85,
          },
        });
      }),
    );

    loop = new SemanticMapLoop(
      mockSemanticMap,
      mockVisionLoop as unknown as VisionLoop,
      mockInfer as InferenceFunction,
      compiler,
      mockTransmitter,
      { analyzeIntervalSec: 0 },
    );
    loop.start();

    const start = Date.now();

    // Emit many bytecode events rapidly — none should block
    for (let i = 0; i < 10; i++) {
      mockVisionLoop.emit('bytecode', Buffer.alloc(6), 'FORWARD 100 100');
    }

    const elapsed = Date.now() - start;
    // All events should process nearly instantly (fire-and-forget)
    expect(elapsed).toBeLessThan(50);

    // Clean up: resolve the pending analysis so it doesn't log after test
    loop.stop();
    resolveSlowAnalysis();
    await new Promise(r => setTimeout(r, 10));
  });

  // ===========================================================================
  // getSemanticMap()
  // ===========================================================================

  test('getSemanticMap() returns the underlying map', () => {
    expect(loop.getSemanticMap()).toBe(mockSemanticMap);
  });

  // ===========================================================================
  // Events
  // ===========================================================================

  test('emits analysis event with node data', async () => {
    const events: unknown[] = [];
    loop.on('analysis', (data) => events.push(data));

    await loop.analyzeNow();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      nodeId: 'loc_0',
      isNew: true,
      analysis: expect.objectContaining({ locationLabel: 'hallway' }),
    });
  });
});
