/**
 * Integration tests: VisionLoop works with both PerceptionPolicy implementations.
 *
 * VisionLoop.processSingleFrame() uses `this.infer` directly (does NOT delegate
 * to the policy). The private processFrame() (streaming path) delegates to
 * the policy. So these tests verify:
 *
 *   - setPolicy() accepts both policy types without throwing
 *   - VLMMotorPolicy.processFrame() works standalone
 *   - SceneGraphPolicy.processFrame() works standalone
 *   - Both produce valid 6-byte frames
 */

import { VisionLoop } from '../../src/2_qwen_cerebellum/vision_loop';
import { BytecodeCompiler, Opcode, decodeFrame, FRAME_SIZE } from '../../src/2_qwen_cerebellum/bytecode_compiler';
import { UDPTransmitter } from '../../src/2_qwen_cerebellum/udp_transmitter';
import { VLMMotorPolicy } from '../../src/2_qwen_cerebellum/vlm_motor_policy';
import { SceneGraphPolicy } from '../../src/2_qwen_cerebellum/scene_graph_policy';
import { SceneGraph } from '../../src/3_llmunix_memory/scene_graph';
import { ReactiveController } from '../../src/1_openclaw_cortex/reactive_controller';
import type { InferenceFunction } from '../../src/llmunix-core/interfaces';
import type { ArenaConfig } from '../../src/2_qwen_cerebellum/vision_projector';

// =============================================================================
// Shared fixtures
// =============================================================================

const ARENA: ArenaConfig = { widthCm: 300, heightCm: 200 };

/** Standard scene: robot facing right, target to the right. */
const STANDARD_SCENE_JSON = JSON.stringify({
  objects: [
    { label: 'roclaw', box_2d: [400, 100, 600, 200], heading_estimate: 'RIGHT' },
    { label: 'red cube', box_2d: [400, 700, 600, 800] },
  ],
});

describe('Policy switch — VisionLoop integration', () => {
  let compiler: BytecodeCompiler;
  let transmitter: UDPTransmitter;
  let mockInfer: jest.Mock;
  let mockSend: jest.Mock;
  let visionLoop: VisionLoop;

  beforeEach(() => {
    compiler = new BytecodeCompiler('fewshot');
    transmitter = new UDPTransmitter({ host: '127.0.0.1', port: 4210 });
    mockInfer = jest.fn<Promise<string>, [string, string, string[] | undefined]>();
    mockInfer.mockResolvedValue('AA 07 00 00 07 FF');

    mockSend = jest.fn().mockResolvedValue(undefined);
    (transmitter as any).connected = true;
    (transmitter as any).socket = { send: jest.fn() };
    transmitter.send = mockSend;

    visionLoop = new VisionLoop(
      { cameraUrl: 'http://127.0.0.1:80/stream', targetFPS: 2, stopSettleMs: 0 },
      compiler,
      transmitter,
      mockInfer as InferenceFunction,
    );
  });

  afterEach(() => {
    visionLoop.stop();
  });

  // ===========================================================================
  // 1. VisionLoop defaults to VLMMotorPolicy behavior (processSingleFrame works)
  // ===========================================================================

  test('VisionLoop defaults to VLMMotorPolicy behavior (processSingleFrame works)', async () => {
    mockInfer.mockResolvedValue('FORWARD 150 150');

    const result = await visionLoop.processSingleFrame('base64frame');

    expect(result).not.toBeNull();
    expect(result!.length).toBe(FRAME_SIZE);
    const decoded = decodeFrame(result!);
    expect(decoded).not.toBeNull();
    expect(decoded!.opcode).toBe(Opcode.MOVE_FORWARD);
    expect(mockInfer).toHaveBeenCalledTimes(1);
  });

  // ===========================================================================
  // 2. setPolicy(sceneGraphPolicy) switches to scene-graph path
  // ===========================================================================

  test('setPolicy(sceneGraphPolicy) switches to scene-graph path without throwing', () => {
    const graph = new SceneGraph();
    const controller = new ReactiveController();
    const sceneGraphInfer = jest.fn().mockResolvedValue(STANDARD_SCENE_JSON);
    const sceneGraphPolicy = new SceneGraphPolicy(
      graph, controller, sceneGraphInfer as InferenceFunction, compiler, ARENA,
    );

    // setPolicy should not throw
    expect(() => visionLoop.setPolicy(sceneGraphPolicy)).not.toThrow();
  });

  // ===========================================================================
  // 3. processSingleFrame with VLMMotorPolicy returns compiled bytecode
  // ===========================================================================

  test('processSingleFrame with VLMMotorPolicy returns compiled bytecode', async () => {
    // Explicitly set VLMMotorPolicy
    const vlmPolicy = new VLMMotorPolicy(compiler, mockInfer as InferenceFunction);
    visionLoop.setPolicy(vlmPolicy);

    mockInfer.mockResolvedValue('AA 01 C8 C8 09 FF'); // MOVE_FORWARD 200 200

    const result = await visionLoop.processSingleFrame('base64frame');

    // processSingleFrame uses this.infer directly, not the policy,
    // so it should still produce a valid frame
    expect(result).not.toBeNull();
    expect(result!.length).toBe(FRAME_SIZE);
    expect(result![0]).toBe(0xAA);
    expect(result![5]).toBe(0xFF);
  });

  // ===========================================================================
  // 4. processSingleFrame with SceneGraphPolicy returns controller's bytecode
  // ===========================================================================

  test('SceneGraphPolicy.processFrame returns controller bytecode standalone', async () => {
    const graph = new SceneGraph();
    const controller = new ReactiveController();
    const sceneGraphInfer = jest.fn().mockResolvedValue(STANDARD_SCENE_JSON);
    const sceneGraphPolicy = new SceneGraphPolicy(
      graph, controller, sceneGraphInfer as InferenceFunction, compiler, ARENA,
    );

    // Call the policy directly (since processSingleFrame doesn't delegate)
    const result = await sceneGraphPolicy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    expect(result.bytecode).not.toBeNull();
    expect(result.bytecode!.length).toBe(FRAME_SIZE);
    const decoded = decodeFrame(result.bytecode!);
    expect(decoded).not.toBeNull();
    // Standard scene: robot facing right, target to the right -> MOVE_FORWARD
    expect(decoded!.opcode).toBe(Opcode.MOVE_FORWARD);
    expect(result.metadata?.action).toBe('move_forward');
  });

  // ===========================================================================
  // 5. Can switch back to VLMMotorPolicy after using SceneGraphPolicy
  // ===========================================================================

  test('can switch back to VLMMotorPolicy after using SceneGraphPolicy', async () => {
    // Start with SceneGraphPolicy
    const graph = new SceneGraph();
    const controller = new ReactiveController();
    const sceneGraphInfer = jest.fn().mockResolvedValue(STANDARD_SCENE_JSON);
    const sceneGraphPolicy = new SceneGraphPolicy(
      graph, controller, sceneGraphInfer as InferenceFunction, compiler, ARENA,
    );
    visionLoop.setPolicy(sceneGraphPolicy);

    // Switch back to VLMMotorPolicy
    const vlmPolicy = new VLMMotorPolicy(compiler, mockInfer as InferenceFunction);
    expect(() => visionLoop.setPolicy(vlmPolicy)).not.toThrow();

    // processSingleFrame should still work (it uses this.infer directly)
    mockInfer.mockResolvedValue('STOP');
    const result = await visionLoop.processSingleFrame('base64frame');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(FRAME_SIZE);
    const decoded = decodeFrame(result!);
    expect(decoded!.opcode).toBe(Opcode.STOP);
  });

  // ===========================================================================
  // 6. Both policies produce valid 6-byte frames
  // ===========================================================================

  test('both policies produce valid 6-byte frames', async () => {
    // --- VLMMotorPolicy ---
    const vlmPolicy = new VLMMotorPolicy(compiler, mockInfer as InferenceFunction);
    mockInfer.mockResolvedValue('FORWARD 100 100');

    const vlmResult = await vlmPolicy.processFrame(
      ['base64frame'],
      'navigate forward',
      null,
      [],
    );

    expect(vlmResult.bytecode).not.toBeNull();
    expect(vlmResult.bytecode!.length).toBe(FRAME_SIZE);
    expect(vlmResult.bytecode![0]).toBe(0xAA);  // start marker
    expect(vlmResult.bytecode![5]).toBe(0xFF);   // end marker
    const vlmDecoded = decodeFrame(vlmResult.bytecode!);
    expect(vlmDecoded).not.toBeNull();

    // --- SceneGraphPolicy ---
    const graph = new SceneGraph();
    const controller = new ReactiveController();
    const sceneGraphInfer = jest.fn().mockResolvedValue(STANDARD_SCENE_JSON);
    const sceneGraphPolicy = new SceneGraphPolicy(
      graph, controller, sceneGraphInfer as InferenceFunction, compiler, ARENA,
    );

    const sgResult = await sceneGraphPolicy.processFrame(
      ['base64frame'],
      'navigate to the red cube',
      null,
      [],
    );

    expect(sgResult.bytecode).not.toBeNull();
    expect(sgResult.bytecode!.length).toBe(FRAME_SIZE);
    expect(sgResult.bytecode![0]).toBe(0xAA);  // start marker
    expect(sgResult.bytecode![5]).toBe(0xFF);   // end marker
    const sgDecoded = decodeFrame(sgResult.bytecode!);
    expect(sgDecoded).not.toBeNull();

    // Both frames are decodable with valid opcodes
    expect(Object.values(Opcode)).toContain(vlmDecoded!.opcode);
    expect(Object.values(Opcode)).toContain(sgDecoded!.opcode);
  });
});
