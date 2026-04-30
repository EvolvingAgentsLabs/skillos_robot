/**
 * Tests for StrategyStore (Phase 2)
 */

import * as fs from 'fs';
import * as path from 'path';
import { StrategyStore } from '../../src/brain/memory/strategy_store';
import { HierarchyLevel, type Strategy, type NegativeConstraint } from '../../src/brain/memory/trace_types';

const TEST_STRATEGIES_DIR = path.join(__dirname, '__test_strategies__');

function cleanup(): void {
  if (fs.existsSync(TEST_STRATEGIES_DIR)) {
    fs.rmSync(TEST_STRATEGIES_DIR, { recursive: true, force: true });
  }
}

function makeStore(): StrategyStore {
  return new StrategyStore(TEST_STRATEGIES_DIR);
}

function createDirStructure(): void {
  for (const dir of ['level_1_goals', 'level_2_routes', 'level_3_tactical', 'level_4_motor', '_seeds']) {
    fs.mkdirSync(path.join(TEST_STRATEGIES_DIR, dir), { recursive: true });
  }
  // Create constraint and journal files
  fs.writeFileSync(path.join(TEST_STRATEGIES_DIR, '_negative_constraints.md'), '# Negative Constraints\n');
  fs.writeFileSync(path.join(TEST_STRATEGIES_DIR, '_dream_journal.md'), '# Dream Journal\n');
}

function writeSeedStrategy(): void {
  const content = `---
id: seed_4_obstacle-avoidance
version: 1
level: 4
title: Obstacle Avoidance
trigger_goals: ["avoid", "obstacle", "dodge"]
preconditions: ["camera active"]
confidence: 0.3
success_count: 0
failure_count: 0
source_traces: []
deprecated: false
---

# Obstacle Avoidance

## Steps

1. Detect obstacle in camera frame
2. Stop forward motion
3. Turn away from obstacle
4. Resume forward motion

## Negative Constraints

- Do not reverse blindly without checking rear clearance
`;
  fs.writeFileSync(
    path.join(TEST_STRATEGIES_DIR, '_seeds', 'seed_4_obstacle-avoidance.md'),
    content,
  );
}

describe('StrategyStore', () => {
  beforeEach(() => {
    cleanup();
    createDirStructure();
  });

  afterAll(cleanup);

  // ---------------------------------------------------------------------------
  // isAvailable
  // ---------------------------------------------------------------------------

  it('should report available when directory exists', () => {
    const store = makeStore();
    expect(store.isAvailable()).toBe(true);
  });

  it('should report unavailable when directory missing', () => {
    cleanup();
    const store = makeStore();
    expect(store.isAvailable()).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // getStrategiesForLevel
  // ---------------------------------------------------------------------------

  it('should return empty array when no strategies exist', () => {
    const store = makeStore();
    expect(store.getStrategiesForLevel(HierarchyLevel.GOAL)).toEqual([]);
  });

  it('should read seed strategies', () => {
    writeSeedStrategy();
    const store = makeStore();
    const strategies = store.getStrategiesForLevel(HierarchyLevel.REACTIVE);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].id).toBe('seed_4_obstacle-avoidance');
    expect(strategies[0].title).toBe('Obstacle Avoidance');
    expect(strategies[0].confidence).toBe(0.3);
    expect(strategies[0].steps).toHaveLength(4);
    expect(strategies[0].negativeConstraints).toHaveLength(1);
    expect(strategies[0].triggerGoals).toEqual(['avoid', 'obstacle', 'dodge']);
  });

  it('should filter out deprecated strategies', () => {
    const content = `---
id: old_strat
version: 1
level: 4
title: Old Strategy
trigger_goals: ["test"]
confidence: 0.1
deprecated: true
---

# Old Strategy

## Steps

1. Do something old
`;
    fs.writeFileSync(path.join(TEST_STRATEGIES_DIR, 'level_4_motor', 'old_strat.md'), content);

    const store = makeStore();
    const strategies = store.getStrategiesForLevel(HierarchyLevel.REACTIVE);
    expect(strategies).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // findStrategies
  // ---------------------------------------------------------------------------

  it('should find strategies by keyword match', () => {
    writeSeedStrategy();
    const store = makeStore();
    const found = store.findStrategies('avoid the obstacle ahead', HierarchyLevel.REACTIVE);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('seed_4_obstacle-avoidance');
  });

  it('should return empty for non-matching goal', () => {
    writeSeedStrategy();
    const store = makeStore();
    const found = store.findStrategies('dance in a circle', HierarchyLevel.REACTIVE);
    expect(found).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // saveStrategy
  // ---------------------------------------------------------------------------

  it('should save and reload a strategy', () => {
    const store = makeStore();
    const strategy: Strategy = {
      id: 'strat_3_test',
      version: 1,
      hierarchyLevel: HierarchyLevel.TACTICAL,
      title: 'Test Strategy',
      preconditions: ['path clear'],
      triggerGoals: ['navigate', 'move'],
      steps: ['Check path', 'Move forward', 'Verify arrival'],
      negativeConstraints: ['Do not bump walls'],
      confidence: 0.7,
      successCount: 3,
      failureCount: 1,
      sourceTraceIds: ['tr_abc', 'tr_def'],
      deprecated: false,
    };

    store.saveStrategy(strategy);

    // Re-read
    const reloaded = store.getStrategiesForLevel(HierarchyLevel.TACTICAL);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe('strat_3_test');
    expect(reloaded[0].title).toBe('Test Strategy');
    expect(reloaded[0].steps).toHaveLength(3);
    expect(reloaded[0].confidence).toBe(0.7);
    expect(reloaded[0].triggerGoals).toContain('navigate');
  });

  // ---------------------------------------------------------------------------
  // Negative Constraints
  // ---------------------------------------------------------------------------

  it('should save and read negative constraints', () => {
    const store = makeStore();
    const constraint: NegativeConstraint = {
      description: 'Do not reverse into unknown areas',
      context: 'navigation',
      learnedFrom: ['tr_123'],
      severity: 'high',
    };

    store.saveNegativeConstraint(constraint);

    const loaded = store.getNegativeConstraints();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].description).toBe('Do not reverse into unknown areas');
    expect(loaded[0].severity).toBe('high');
  });

  it('should filter constraints by context', () => {
    const store = makeStore();
    store.saveNegativeConstraint({
      description: 'Avoid tight spaces',
      context: 'doorway',
      learnedFrom: [],
      severity: 'medium',
    });
    store.saveNegativeConstraint({
      description: 'General caution',
      context: 'general',
      learnedFrom: [],
      severity: 'low',
    });

    const doorway = store.getNegativeConstraints('doorway');
    expect(doorway).toHaveLength(2); // doorway + general
    expect(doorway.some(c => c.description === 'Avoid tight spaces')).toBe(true);
    expect(doorway.some(c => c.description === 'General caution')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // reinforceStrategy
  // ---------------------------------------------------------------------------

  it('should reinforce strategy by increasing success count and confidence', () => {
    writeSeedStrategy();
    const store = makeStore();

    store.reinforceStrategy('seed_4_obstacle-avoidance');

    const strategies = store.getStrategiesForLevel(HierarchyLevel.REACTIVE);
    const reinforced = strategies.find(s => s.id === 'seed_4_obstacle-avoidance');
    expect(reinforced).toBeDefined();
    expect(reinforced!.successCount).toBe(1);
    expect(reinforced!.confidence).toBeGreaterThan(0.3);
  });

  // ---------------------------------------------------------------------------
  // getSummaryForLevel
  // ---------------------------------------------------------------------------

  it('should return a summary string for populated levels', () => {
    writeSeedStrategy();
    const store = makeStore();
    const summary = store.getSummaryForLevel(HierarchyLevel.REACTIVE);
    expect(summary).toContain('Obstacle Avoidance');
    expect(summary).toContain('confidence');
  });

  it('should return empty string for empty levels', () => {
    const store = makeStore();
    const summary = store.getSummaryForLevel(HierarchyLevel.GOAL);
    expect(summary).toBe('');
  });

  // ---------------------------------------------------------------------------
  // Dream Journal
  // ---------------------------------------------------------------------------

  it('should append and read dream journal entries', () => {
    const store = makeStore();
    store.appendDreamJournal({
      timestamp: '2026-02-22T10:00:00.000Z',
      tracesProcessed: 15,
      strategiesCreated: 2,
      strategiesUpdated: 1,
      constraintsLearned: 3,
      tracesPruned: 10,
      summary: 'Learned obstacle avoidance and wall following patterns.',
    });

    const lastTs = store.getLastDreamTimestamp();
    expect(lastTs).toBe('2026-02-22T10:00:00.000Z');
  });

  // ---------------------------------------------------------------------------
  // findStrategyById
  // ---------------------------------------------------------------------------

  it('should find strategy by ID across levels', () => {
    writeSeedStrategy();
    const store = makeStore();
    const found = store.findStrategyById('seed_4_obstacle-avoidance');
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Obstacle Avoidance');
  });

  it('should return null for unknown ID', () => {
    const store = makeStore();
    expect(store.findStrategyById('nonexistent')).toBeNull();
  });
});
