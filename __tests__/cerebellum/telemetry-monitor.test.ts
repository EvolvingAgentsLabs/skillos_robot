import { TelemetryMonitor } from '../../src/2_qwen_cerebellum/telemetry_monitor';
import { encodeFrame, Opcode } from '../../src/2_qwen_cerebellum/bytecode_compiler';

function makeTelemetry(overrides: Record<string, any> = {}): Buffer {
  const msg = {
    telemetry: true,
    pose: { x: 0.5, y: -0.3, h: 1.57 },
    vel: { left: 0.789, right: 0.789 },
    stall: false,
    ts: Date.now(),
    ...overrides,
  };
  return Buffer.from(JSON.stringify(msg));
}

describe('TelemetryMonitor', () => {
  let monitor: TelemetryMonitor;

  beforeEach(() => {
    monitor = new TelemetryMonitor();
  });

  // ===========================================================================
  // Message discrimination
  // ===========================================================================

  test('ignores bytecode frames (0xAA prefix)', () => {
    const frame = encodeFrame({ opcode: Opcode.MOVE_FORWARD, paramLeft: 128, paramRight: 128 });
    const result = monitor.processMessage(frame);
    expect(result).toBe(false);
    expect(monitor.getLastTelemetry()).toBeNull();
  });

  test('parses valid telemetry JSON', () => {
    const handler = jest.fn();
    monitor.on('telemetry', handler);

    const result = monitor.processMessage(makeTelemetry());
    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    const data = monitor.getLastTelemetry();
    expect(data).not.toBeNull();
    expect(data!.pose.x).toBe(0.5);
    expect(data!.pose.y).toBe(-0.3);
    expect(data!.vel.left).toBe(0.789);
    expect(data!.stall).toBe(false);
  });

  test('ignores non-telemetry JSON', () => {
    const msg = Buffer.from(JSON.stringify({ type: 'ctrl', left: 0, right: 0 }));
    const result = monitor.processMessage(msg);
    expect(result).toBe(false);
    expect(monitor.getLastTelemetry()).toBeNull();
  });

  test('ignores malformed data', () => {
    const result = monitor.processMessage(Buffer.from('not json at all'));
    expect(result).toBe(false);
  });

  test('ignores empty buffer', () => {
    const result = monitor.processMessage(Buffer.alloc(0));
    expect(result).toBe(false);
  });

  // ===========================================================================
  // Stall detection
  // ===========================================================================

  test('emits stall on rising edge only', () => {
    const stallHandler = jest.fn();
    monitor.on('stall', stallHandler);

    // First: not stalled
    monitor.processMessage(makeTelemetry({ stall: false }));
    expect(stallHandler).not.toHaveBeenCalled();

    // Rising edge: stall detected
    monitor.processMessage(makeTelemetry({ stall: true }));
    expect(stallHandler).toHaveBeenCalledTimes(1);

    // Still stalled — should NOT emit again
    monitor.processMessage(makeTelemetry({ stall: true }));
    expect(stallHandler).toHaveBeenCalledTimes(1);
  });

  test('resets stall state when cleared', () => {
    const stallHandler = jest.fn();
    monitor.on('stall', stallHandler);

    // Stall detected
    monitor.processMessage(makeTelemetry({ stall: true }));
    expect(stallHandler).toHaveBeenCalledTimes(1);
    expect(monitor.isStalled()).toBe(true);

    // Stall cleared
    monitor.processMessage(makeTelemetry({ stall: false }));
    expect(monitor.isStalled()).toBe(false);

    // Stall detected again — should emit again (new rising edge)
    monitor.processMessage(makeTelemetry({ stall: true }));
    expect(stallHandler).toHaveBeenCalledTimes(2);
    expect(monitor.isStalled()).toBe(true);
  });

  // ===========================================================================
  // Accessors
  // ===========================================================================

  test('isStalled returns false when no telemetry received', () => {
    expect(monitor.isStalled()).toBe(false);
  });

  test('getLastTelemetry updates with each message', () => {
    monitor.processMessage(makeTelemetry({ pose: { x: 1, y: 2, h: 3 } }));
    expect(monitor.getLastTelemetry()!.pose.x).toBe(1);

    monitor.processMessage(makeTelemetry({ pose: { x: 5, y: 6, h: 7 } }));
    expect(monitor.getLastTelemetry()!.pose.x).toBe(5);
  });
});
