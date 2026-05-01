import sharp from 'sharp';
import {
  computeVisualDelta,
  interpretDelta,
  SelfPerceptionMonitor,
  DEFAULT_SELF_PERCEPTION_CONFIG,
} from '../../src/brain/perception/self_perception';
import { Opcode } from '../../src/control/bytecode_compiler';

// =============================================================================
// Helper: create a solid-color JPEG buffer
// =============================================================================

async function makeFrame(color: number, width = 80, height = 60): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3, color);
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

// =============================================================================
// computeVisualDelta
// =============================================================================

describe('computeVisualDelta', () => {
  test('identical frames yield delta near 0', async () => {
    const frame = await makeFrame(128);
    const delta = await computeVisualDelta(frame, frame, 80, 60);
    expect(delta).toBeLessThan(0.01);
  });

  test('maximally different frames yield high delta', async () => {
    const black = await makeFrame(0);
    const white = await makeFrame(255);
    const delta = await computeVisualDelta(black, white, 80, 60);
    expect(delta).toBeGreaterThan(0.8);
  });

  test('slightly different frames yield small delta', async () => {
    const frame1 = await makeFrame(128);
    const frame2 = await makeFrame(140);
    const delta = await computeVisualDelta(frame1, frame2, 80, 60);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(0.1);
  });
});

// =============================================================================
// interpretDelta
// =============================================================================

describe('interpretDelta', () => {
  const config = DEFAULT_SELF_PERCEPTION_CONFIG;

  test('motion command + low delta = stuck', () => {
    expect(interpretDelta(0.005, Opcode.MOVE_FORWARD, config)).toBe('stuck');
    expect(interpretDelta(0.01, Opcode.TURN_LEFT, config)).toBe('stuck');
    expect(interpretDelta(0.015, Opcode.ROTATE_CW, config)).toBe('stuck');
  });

  test('motion command + high delta = coherent', () => {
    expect(interpretDelta(0.05, Opcode.MOVE_FORWARD, config)).toBe('coherent');
    expect(interpretDelta(0.15, Opcode.TURN_RIGHT, config)).toBe('coherent');
    expect(interpretDelta(0.3, Opcode.MOVE_BACKWARD, config)).toBe('coherent');
  });

  test('motion command at exact threshold = coherent', () => {
    expect(interpretDelta(0.02, Opcode.MOVE_FORWARD, config)).toBe('coherent');
  });

  test('STOP + low delta = coherent', () => {
    expect(interpretDelta(0.01, Opcode.STOP, config)).toBe('coherent');
    expect(interpretDelta(0.0, Opcode.STOP, config)).toBe('coherent');
  });

  test('STOP + high delta = anomaly', () => {
    expect(interpretDelta(0.1, Opcode.STOP, config)).toBe('anomaly');
    expect(interpretDelta(0.05, Opcode.STOP, config)).toBe('anomaly');
  });

  test('non-motion opcode (GET_STATUS) + low delta = coherent', () => {
    expect(interpretDelta(0.01, Opcode.GET_STATUS, config)).toBe('coherent');
  });
});

// =============================================================================
// SelfPerceptionMonitor
// =============================================================================

describe('SelfPerceptionMonitor', () => {
  let monitor: SelfPerceptionMonitor;

  beforeEach(() => {
    // Disable timing gate for unit tests
    monitor = new SelfPerceptionMonitor({ minTimeDeltaMs: 0 });
  });

  test('returns null when no pre-frame recorded', async () => {
    const frame = await makeFrame(128);
    const result = await monitor.comparePostFrame(frame.toString('base64'));
    expect(result).toBeNull();
  });

  test('detects stuck when frames are identical', async () => {
    const frame = await makeFrame(128);
    const b64 = frame.toString('base64');
    monitor.recordPreCommandFrame(b64, Opcode.MOVE_FORWARD);
    const result = await monitor.comparePostFrame(b64);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('stuck');
    expect(result!.opcode).toBe(Opcode.MOVE_FORWARD);
    expect(result!.opcodeName).toBe('MOVE_FORWARD');
    expect(result!.delta).toBeLessThan(0.01);
  });

  test('detects coherent when frames differ significantly', async () => {
    const pre = await makeFrame(50);
    const post = await makeFrame(200);
    monitor.recordPreCommandFrame(pre.toString('base64'), Opcode.MOVE_FORWARD);
    const result = await monitor.comparePostFrame(post.toString('base64'));
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('coherent');
    expect(result!.delta).toBeGreaterThan(0.1);
  });

  test('detects anomaly on STOP with scene change', async () => {
    const pre = await makeFrame(100);
    const post = await makeFrame(200);
    monitor.recordPreCommandFrame(pre.toString('base64'), Opcode.STOP);
    const result = await monitor.comparePostFrame(post.toString('base64'));
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('anomaly');
  });

  test('consecutive stuck tracking', async () => {
    const frame = await makeFrame(128);
    const b64 = frame.toString('base64');

    // First stuck — not confirmed yet
    monitor.recordPreCommandFrame(b64, Opcode.MOVE_FORWARD);
    await monitor.comparePostFrame(b64);
    expect(monitor.isConfirmedStuck()).toBe(false);
    expect(monitor.getConsecutiveStuck()).toBe(1);

    // Second stuck — now confirmed
    monitor.recordPreCommandFrame(b64, Opcode.MOVE_FORWARD);
    await monitor.comparePostFrame(b64);
    expect(monitor.isConfirmedStuck()).toBe(true);
    expect(monitor.getConsecutiveStuck()).toBe(2);
  });

  test('consecutive stuck resets on coherent', async () => {
    const frame = await makeFrame(128);
    const b64 = frame.toString('base64');

    // Build up stuck count
    monitor.recordPreCommandFrame(b64, Opcode.MOVE_FORWARD);
    await monitor.comparePostFrame(b64);
    expect(monitor.getConsecutiveStuck()).toBe(1);

    // Coherent result resets counter
    const different = await makeFrame(200);
    monitor.recordPreCommandFrame(b64, Opcode.MOVE_FORWARD);
    await monitor.comparePostFrame(different.toString('base64'));
    expect(monitor.getConsecutiveStuck()).toBe(0);
    expect(monitor.isConfirmedStuck()).toBe(false);
  });

  test('manual reset clears consecutive counter', async () => {
    const frame = await makeFrame(128);
    const b64 = frame.toString('base64');

    monitor.recordPreCommandFrame(b64, Opcode.MOVE_FORWARD);
    await monitor.comparePostFrame(b64);
    monitor.recordPreCommandFrame(b64, Opcode.MOVE_FORWARD);
    await monitor.comparePostFrame(b64);
    expect(monitor.isConfirmedStuck()).toBe(true);

    monitor.resetStuckCounter();
    expect(monitor.isConfirmedStuck()).toBe(false);
    expect(monitor.getConsecutiveStuck()).toBe(0);
  });

  test('disabled monitor returns null', async () => {
    const disabled = new SelfPerceptionMonitor({ enabled: false });
    const frame = await makeFrame(128);
    disabled.recordPreCommandFrame(frame.toString('base64'), Opcode.MOVE_FORWARD);
    const result = await disabled.comparePostFrame(frame.toString('base64'));
    expect(result).toBeNull();
  });

  test('consumes pre-frame after comparison (single use)', async () => {
    const frame = await makeFrame(128);
    const b64 = frame.toString('base64');

    monitor.recordPreCommandFrame(b64, Opcode.MOVE_FORWARD);
    const result1 = await monitor.comparePostFrame(b64);
    expect(result1).not.toBeNull();

    // Second call without new recordPreCommandFrame → null
    const result2 = await monitor.comparePostFrame(b64);
    expect(result2).toBeNull();
  });

  test('stats are tracked correctly', async () => {
    const frame = await makeFrame(128);
    const b64 = frame.toString('base64');

    monitor.recordPreCommandFrame(b64, Opcode.MOVE_FORWARD);
    await monitor.comparePostFrame(b64);

    const stats = monitor.getStats();
    expect(stats.comparisons).toBe(1);
    expect(stats.stuckDetections).toBe(1);
    expect(stats.anomalyDetections).toBe(0);
  });

  test('updateConfig changes thresholds at runtime', () => {
    const original = monitor.getConfig();
    expect(original.stuckThreshold).toBe(0.02);

    monitor.updateConfig({ stuckThreshold: 0.05 });
    expect(monitor.getConfig().stuckThreshold).toBe(0.05);
  });
});
