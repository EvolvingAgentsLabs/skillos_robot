/**
 * Tests for HierarchicalTraceLogger (Phase 1)
 */

import * as fs from 'fs';
import * as path from 'path';
import { HierarchicalTraceLogger } from '../../src/brain/memory/trace_logger';
import { HierarchyLevel, TraceOutcome } from '../../src/brain/memory/trace_types';

const TEST_TRACES_DIR = path.join(__dirname, '__test_traces__');

function cleanup(): void {
  if (fs.existsSync(TEST_TRACES_DIR)) {
    fs.rmSync(TEST_TRACES_DIR, { recursive: true, force: true });
  }
}

describe('HierarchicalTraceLogger', () => {
  let traceLogger: HierarchicalTraceLogger;

  beforeEach(() => {
    cleanup();
    traceLogger = new HierarchicalTraceLogger(TEST_TRACES_DIR);
  });

  afterAll(cleanup);

  // ---------------------------------------------------------------------------
  // startTrace
  // ---------------------------------------------------------------------------

  it('should create a trace and return a valid ID', () => {
    const id = traceLogger.startTrace(HierarchyLevel.GOAL, 'Fetch a drink');
    expect(id).toMatch(/^tr_/);
    expect(traceLogger.getActiveTraceCount()).toBe(1);
  });

  it('should create traces at all hierarchy levels', () => {
    const id1 = traceLogger.startTrace(HierarchyLevel.GOAL, 'Main goal');
    const id2 = traceLogger.startTrace(HierarchyLevel.STRATEGY, 'Strategic step', {
      parentTraceId: id1,
    });
    const id3 = traceLogger.startTrace(HierarchyLevel.TACTICAL, 'Tactical step', {
      parentTraceId: id2,
    });
    const id4 = traceLogger.startTrace(HierarchyLevel.REACTIVE, 'Motor correction', {
      parentTraceId: id3,
    });

    expect(traceLogger.getActiveTraceCount()).toBe(4);

    const goalTrace = traceLogger.getActiveTrace(id1)!;
    expect(goalTrace.hierarchyLevel).toBe(HierarchyLevel.GOAL);
    expect(goalTrace.parentTraceId).toBeNull();

    const stratTrace = traceLogger.getActiveTrace(id2)!;
    expect(stratTrace.hierarchyLevel).toBe(HierarchyLevel.STRATEGY);
    expect(stratTrace.parentTraceId).toBe(id1);

    const tactTrace = traceLogger.getActiveTrace(id3)!;
    expect(tactTrace.parentTraceId).toBe(id2);

    const reactTrace = traceLogger.getActiveTrace(id4)!;
    expect(reactTrace.parentTraceId).toBe(id3);
  });

  it('should accept optional fields in startTrace', () => {
    const id = traceLogger.startTrace(HierarchyLevel.TACTICAL, 'Navigate kitchen', {
      locationNode: 'kitchen',
      sceneDescription: 'White cabinets, gas stove',
      activeStrategyId: 'strat_3_doorway-approach',
    });

    const trace = traceLogger.getActiveTrace(id)!;
    expect(trace.locationNode).toBe('kitchen');
    expect(trace.sceneDescription).toBe('White cabinets, gas stove');
    expect(trace.activeStrategyId).toBe('strat_3_doorway-approach');
  });

  // ---------------------------------------------------------------------------
  // appendBytecode
  // ---------------------------------------------------------------------------

  it('should append bytecode entries to an active trace', () => {
    const id = traceLogger.startTrace(HierarchyLevel.REACTIVE, 'Avoid obstacle');
    const bytecode = Buffer.from([0xAA, 0x01, 0x80, 0x80, 0x01, 0xFF]);

    traceLogger.appendBytecode(id, 'Clear path ahead, moving forward', bytecode);
    traceLogger.appendBytecode(id, 'Obstacle left, turning right', bytecode);

    const trace = traceLogger.getActiveTrace(id)!;
    expect(trace.bytecodeEntries).toHaveLength(2);
    expect(trace.bytecodeEntries[0].vlmOutput).toBe('Clear path ahead, moving forward');
    expect(trace.bytecodeEntries[0].bytecodeHex).toBe('AA 01 80 80 01 FF');
  });

  it('should fall back gracefully when appending to unknown trace', () => {
    // Should not throw
    const bytecode = Buffer.from([0xAA, 0x07, 0x00, 0x00, 0x07, 0xFF]);
    traceLogger.appendBytecode('tr_nonexistent', 'test', bytecode);
  });

  // ---------------------------------------------------------------------------
  // endTrace
  // ---------------------------------------------------------------------------

  it('should end a trace and write to disk', () => {
    const id = traceLogger.startTrace(HierarchyLevel.GOAL, 'Explore environment');
    const bytecode = Buffer.from([0xAA, 0x01, 0x80, 0x80, 0x01, 0xFF]);
    traceLogger.appendBytecode(id, 'Moving forward', bytecode);
    traceLogger.endTrace(id, TraceOutcome.SUCCESS, 'Reached target', 0.9);

    expect(traceLogger.getActiveTraceCount()).toBe(0);

    // Verify file was written
    const files = fs.readdirSync(TEST_TRACES_DIR).filter(f => f.startsWith('trace_'));
    expect(files.length).toBeGreaterThan(0);

    const content = fs.readFileSync(path.join(TEST_TRACES_DIR, files[0]), 'utf-8');
    expect(content).toContain('**Trace ID:**');
    expect(content).toContain('**Level:** 1');
    expect(content).toContain('**Goal:** Explore environment');
    expect(content).toContain('**Outcome:** SUCCESS');
    expect(content).toContain('**Reason:** Reached target');
    expect(content).toContain('**Confidence:** 0.9');
    expect(content).toContain('AA 01 80 80 01 FF');
  });

  it('should write v2 format with parent trace ID', () => {
    const parentId = traceLogger.startTrace(HierarchyLevel.GOAL, 'Main goal');
    traceLogger.endTrace(parentId, TraceOutcome.SUCCESS);

    const childId = traceLogger.startTrace(HierarchyLevel.STRATEGY, 'Sub goal', {
      parentTraceId: parentId,
    });
    traceLogger.endTrace(childId, TraceOutcome.PARTIAL, 'Blocked by obstacle');

    const files = fs.readdirSync(TEST_TRACES_DIR).filter(f => f.startsWith('trace_'));
    const content = fs.readFileSync(path.join(TEST_TRACES_DIR, files[0]), 'utf-8');
    expect(content).toContain(`**Parent:** ${parentId}`);
    expect(content).toContain('**Outcome:** PARTIAL');
  });

  it('should handle endTrace for unknown ID gracefully', () => {
    // Should not throw
    traceLogger.endTrace('tr_ghost', TraceOutcome.ABORTED);
  });

  it('should record duration on endTrace', () => {
    const id = traceLogger.startTrace(HierarchyLevel.REACTIVE, 'Quick action');

    // Small delay to ensure non-zero duration
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    traceLogger.endTrace(id, TraceOutcome.SUCCESS);

    const files = fs.readdirSync(TEST_TRACES_DIR).filter(f => f.startsWith('trace_'));
    const content = fs.readFileSync(path.join(TEST_TRACES_DIR, files[0]), 'utf-8');
    expect(content).toContain('**Duration:**');
  });

  // ---------------------------------------------------------------------------
  // appendTraceLegacy
  // ---------------------------------------------------------------------------

  it('should write legacy v1 format via appendTraceLegacy without throwing', () => {
    const bytecode = Buffer.from([0xAA, 0x07, 0x00, 0x00, 0x07, 0xFF]);
    // Legacy writes to the module-level TRACES_DIR, not our test dir.
    // This test just verifies the method exists and doesn't throw.
    expect(() => {
      traceLogger.appendTraceLegacy('Stop safely', 'Obstacle detected', bytecode);
    }).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Multiple traces
  // ---------------------------------------------------------------------------

  it('should handle multiple concurrent active traces', () => {
    const id1 = traceLogger.startTrace(HierarchyLevel.GOAL, 'Goal A');
    const id2 = traceLogger.startTrace(HierarchyLevel.GOAL, 'Goal B');

    const bytecodeA = Buffer.from([0xAA, 0x01, 0x64, 0x64, 0x01, 0xFF]);
    const bytecodeB = Buffer.from([0xAA, 0x03, 0x50, 0x80, 0xD3, 0xFF]);

    traceLogger.appendBytecode(id1, 'Forward for A', bytecodeA);
    traceLogger.appendBytecode(id2, 'Turn for B', bytecodeB);

    const traceA = traceLogger.getActiveTrace(id1)!;
    const traceB = traceLogger.getActiveTrace(id2)!;

    expect(traceA.bytecodeEntries).toHaveLength(1);
    expect(traceB.bytecodeEntries).toHaveLength(1);
    expect(traceA.bytecodeEntries[0].vlmOutput).toBe('Forward for A');
    expect(traceB.bytecodeEntries[0].vlmOutput).toBe('Turn for B');

    traceLogger.endTrace(id1, TraceOutcome.SUCCESS);
    traceLogger.endTrace(id2, TraceOutcome.FAILURE, 'Blocked');

    expect(traceLogger.getActiveTraceCount()).toBe(0);
  });
});
