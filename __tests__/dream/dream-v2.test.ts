/**
 * Tests for Dreaming Engine v2 components (Phase 4)
 *
 * Tests the strategy store integration, trace parsing, and consolidation
 * logic. Does NOT call the actual LLM — uses mock inference.
 */

import * as fs from 'fs';
import * as path from 'path';
import { StrategyStore } from '../../src/brain/memory/strategy_store';
import { HierarchicalTraceLogger } from '../../src/brain/memory/trace_logger';
import {
  HierarchyLevel,
  TraceOutcome,
  type Strategy,
} from '../../src/brain/memory/trace_types';

const TEST_DIR = path.join(__dirname, '__test_dream__');
const TRACES_DIR = path.join(TEST_DIR, 'traces');
const STRATEGIES_DIR = path.join(TEST_DIR, 'strategies');

function cleanup(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function createDirs(): void {
  fs.mkdirSync(TRACES_DIR, { recursive: true });
  for (const dir of ['level_1_goals', 'level_2_routes', 'level_3_tactical', 'level_4_motor', '_seeds']) {
    fs.mkdirSync(path.join(STRATEGIES_DIR, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(STRATEGIES_DIR, '_negative_constraints.md'), '# Negative Constraints\n');
  fs.writeFileSync(path.join(STRATEGIES_DIR, '_dream_journal.md'), '# Dream Journal\n');
}

describe('Dream Engine v2', () => {
  beforeEach(() => {
    cleanup();
    createDirs();
  });

  afterAll(cleanup);

  // ---------------------------------------------------------------------------
  // Trace generation and reading
  // ---------------------------------------------------------------------------

  describe('trace generation for dream processing', () => {
    it('should generate v2 traces that can be read back', () => {
      const traceLogger = new HierarchicalTraceLogger(TRACES_DIR);

      // Simulate a successful navigation
      const goalId = traceLogger.startTrace(HierarchyLevel.GOAL, 'Navigate to kitchen', {
        locationNode: 'hallway',
      });

      const bytecode = Buffer.from([0xAA, 0x01, 0x80, 0x80, 0x01, 0xFF]);
      traceLogger.appendBytecode(goalId, 'Clear path, moving forward', bytecode);
      traceLogger.appendBytecode(goalId, 'Door visible ahead', bytecode);
      traceLogger.endTrace(goalId, TraceOutcome.SUCCESS, 'Reached kitchen', 0.85);

      // Verify trace file exists and has v2 format
      const files = fs.readdirSync(TRACES_DIR).filter(f => f.startsWith('trace_'));
      expect(files.length).toBeGreaterThan(0);

      const content = fs.readFileSync(path.join(TRACES_DIR, files[0]), 'utf-8');
      expect(content).toContain('**Trace ID:**');
      expect(content).toContain('**Level:** 1');
      expect(content).toContain('**Outcome:** SUCCESS');
      expect(content).toContain('**Goal:** Navigate to kitchen');
      expect(content).toContain('**Location:** hallway');
      expect(content).toContain('AA 01 80 80 01 FF');
    });

    it('should generate v1-compatible traces with bytecodes', () => {
      const traceLogger = new HierarchicalTraceLogger(TRACES_DIR);

      // Legacy format still works
      const bytecode = Buffer.from([0xAA, 0x07, 0x00, 0x00, 0x07, 0xFF]);
      traceLogger.appendTraceLegacy('Explore', 'Obstacle detected', bytecode);

      // v1 traces get written to the default traces dir, not our test dir
      // This just verifies it doesn't throw
      expect(true).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Strategy creation from dream results
  // ---------------------------------------------------------------------------

  describe('strategy creation (simulated dream output)', () => {
    it('should save a dream-generated strategy and read it back', () => {
      const store = new StrategyStore(STRATEGIES_DIR);

      const strategy: Strategy = {
        id: 'strat_4_forward-stop-turn',
        version: 1,
        hierarchyLevel: HierarchyLevel.REACTIVE,
        title: 'Forward Stop Turn',
        preconditions: ['camera active'],
        triggerGoals: ['explore', 'navigate', 'avoid'],
        steps: [
          'Move forward when path is clear',
          'Stop when obstacle detected',
          'Turn away from obstacle',
        ],
        negativeConstraints: ['Do not reverse blindly'],
        confidence: 0.5,
        successCount: 1,
        failureCount: 0,
        sourceTraceIds: ['tr_abc123'],
        deprecated: false,
      };

      store.saveStrategy(strategy);

      // Read back
      const strategies = store.getStrategiesForLevel(HierarchyLevel.REACTIVE);
      expect(strategies.length).toBeGreaterThanOrEqual(1);
      const found = strategies.find(s => s.id === 'strat_4_forward-stop-turn');
      expect(found).toBeDefined();
      expect(found!.title).toBe('Forward Stop Turn');
      expect(found!.steps).toHaveLength(3);
      expect(found!.confidence).toBe(0.5);
    });

    it('should save negative constraints from failure analysis', () => {
      const store = new StrategyStore(STRATEGIES_DIR);

      store.saveNegativeConstraint({
        description: 'Do not attempt U-turns in narrow spaces',
        context: 'narrow corridor',
        learnedFrom: ['tr_fail_001'],
        severity: 'high',
      });

      store.saveNegativeConstraint({
        description: 'Avoid high-speed turns near walls',
        context: 'wall proximity',
        learnedFrom: ['tr_fail_002'],
        severity: 'medium',
      });

      const constraints = store.getNegativeConstraints();
      expect(constraints).toHaveLength(2);
      expect(constraints[0].description).toBe('Do not attempt U-turns in narrow spaces');
      expect(constraints[1].severity).toBe('medium');
    });
  });

  // ---------------------------------------------------------------------------
  // Dream journal
  // ---------------------------------------------------------------------------

  describe('dream journal', () => {
    it('should append and track dream sessions', () => {
      const store = new StrategyStore(STRATEGIES_DIR);

      store.appendDreamJournal({
        timestamp: '2026-02-20T10:00:00.000Z',
        tracesProcessed: 10,
        strategiesCreated: 1,
        strategiesUpdated: 0,
        constraintsLearned: 2,
        tracesPruned: 5,
        summary: 'First dream: learned basic obstacle avoidance.',
      });

      store.appendDreamJournal({
        timestamp: '2026-02-22T10:00:00.000Z',
        tracesProcessed: 20,
        strategiesCreated: 2,
        strategiesUpdated: 1,
        constraintsLearned: 1,
        tracesPruned: 8,
        summary: 'Second dream: improved wall following.',
      });

      const lastTs = store.getLastDreamTimestamp();
      expect(lastTs).toBe('2026-02-22T10:00:00.000Z');
    });
  });

  // ---------------------------------------------------------------------------
  // Strategy reinforcement
  // ---------------------------------------------------------------------------

  describe('strategy reinforcement and decay', () => {
    it('should increase confidence on reinforcement', () => {
      const store = new StrategyStore(STRATEGIES_DIR);

      const strategy: Strategy = {
        id: 'strat_4_test',
        version: 1,
        hierarchyLevel: HierarchyLevel.REACTIVE,
        title: 'Test',
        preconditions: [],
        triggerGoals: ['test'],
        steps: ['Do test'],
        negativeConstraints: [],
        confidence: 0.5,
        successCount: 0,
        failureCount: 0,
        sourceTraceIds: ['tr_x'],
        deprecated: false,
      };

      store.saveStrategy(strategy);
      store.reinforceStrategy('strat_4_test');

      const updated = store.findStrategyById('strat_4_test');
      expect(updated).toBeDefined();
      expect(updated!.successCount).toBe(1);
      expect(updated!.confidence).toBeGreaterThan(0.5);
    });

    it('should decay unused strategies', () => {
      const store = new StrategyStore(STRATEGIES_DIR);

      const strategy: Strategy = {
        id: 'strat_4_decay',
        version: 1,
        hierarchyLevel: HierarchyLevel.REACTIVE,
        title: 'Decay Test',
        preconditions: [],
        triggerGoals: ['decay'],
        steps: ['Decay step'],
        negativeConstraints: [],
        confidence: 0.8,
        successCount: 2,
        failureCount: 0,
        sourceTraceIds: ['tr_evidence'], // Has trace evidence, so it can decay
        deprecated: false,
      };

      store.saveStrategy(strategy);
      const decayed = store.decayUnusedStrategies(30);
      expect(decayed).toBeGreaterThanOrEqual(1);

      const updated = store.findStrategyById('strat_4_decay');
      expect(updated!.confidence).toBeLessThan(0.8);
    });
  });

  // ---------------------------------------------------------------------------
  // Seed strategy handling
  // ---------------------------------------------------------------------------

  describe('seed strategies', () => {
    it('should read seed strategies at the correct level', () => {
      // Write a seed
      fs.writeFileSync(path.join(STRATEGIES_DIR, '_seeds', 'seed_3_doorway.md'), `---
id: seed_3_doorway-approach
version: 1
level: 3
title: Doorway Approach
trigger_goals: ["door", "doorway", "entrance"]
preconditions: ["camera active"]
confidence: 0.3
success_count: 0
failure_count: 0
source_traces: []
deprecated: false
---

# Doorway Approach

## Steps

1. Slow down when approaching doorway
2. Center robot in doorway frame
3. Proceed through at reduced speed
`);

      const store = new StrategyStore(STRATEGIES_DIR);
      const tactical = store.getStrategiesForLevel(HierarchyLevel.TACTICAL);
      expect(tactical.length).toBeGreaterThanOrEqual(1);
      expect(tactical.some(s => s.id === 'seed_3_doorway-approach')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // End-to-end dream simulation
  // ---------------------------------------------------------------------------

  describe('end-to-end dream simulation', () => {
    it('should simulate a full dream cycle: traces → strategies', () => {
      const traceLogger = new HierarchicalTraceLogger(TRACES_DIR);
      const store = new StrategyStore(STRATEGIES_DIR);

      // Step 1: Generate synthetic traces
      for (let i = 0; i < 5; i++) {
        const id = traceLogger.startTrace(HierarchyLevel.REACTIVE, 'Explore and avoid obstacles');
        const fwdBytecode = Buffer.from([0xAA, 0x01, 0x80, 0x80, 0x01, 0xFF]);
        const turnBytecode = Buffer.from([0xAA, 0x04, 0x60, 0x80, 0xE4, 0xFF]);
        const stopBytecode = Buffer.from([0xAA, 0x07, 0x00, 0x00, 0x07, 0xFF]);

        traceLogger.appendBytecode(id, 'Path clear, moving forward', fwdBytecode);
        traceLogger.appendBytecode(id, 'Obstacle detected, turning right', turnBytecode);
        traceLogger.appendBytecode(id, 'Too close, stopping', stopBytecode);
        traceLogger.endTrace(id, TraceOutcome.SUCCESS, 'Avoided obstacle', 0.8);
      }

      // Step 2: Verify traces were written
      const traceFiles = fs.readdirSync(TRACES_DIR).filter(f => f.startsWith('trace_'));
      expect(traceFiles.length).toBeGreaterThan(0);

      const content = fs.readFileSync(path.join(TRACES_DIR, traceFiles[0]), 'utf-8');
      // Should have multiple trace blocks
      expect((content.match(/### Time:/g) || []).length).toBeGreaterThanOrEqual(5);

      // Step 3: Simulate dream output (strategy creation)
      const dreamStrategy: Strategy = {
        id: 'strat_4_fwd-turn-stop',
        version: 1,
        hierarchyLevel: HierarchyLevel.REACTIVE,
        title: 'Forward Turn Stop Pattern',
        preconditions: ['camera active'],
        triggerGoals: ['explore', 'avoid', 'obstacle'],
        steps: ['Move forward when clear', 'Turn right on obstacle', 'Stop if too close'],
        negativeConstraints: ['Do not maintain high speed near obstacles'],
        confidence: 0.6,
        successCount: 5,
        failureCount: 0,
        sourceTraceIds: [],
        deprecated: false,
      };

      store.saveStrategy(dreamStrategy);

      // Step 4: Verify strategy is findable
      const found = store.findStrategies('avoid obstacles ahead', HierarchyLevel.REACTIVE);
      expect(found.length).toBeGreaterThan(0);
      expect(found[0].title).toBe('Forward Turn Stop Pattern');

      // Step 5: Verify strategy appears in summary
      const summary = store.getSummaryForLevel(HierarchyLevel.REACTIVE);
      expect(summary).toContain('Forward Turn Stop Pattern');
    });
  });
});
