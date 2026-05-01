/**
 * Tests for HierarchicalPlanner (Phase 3)
 */

import * as fs from 'fs';
import * as path from 'path';
import { HierarchicalPlanner } from '../../src/brain/planning/planner';
import { MemoryManager } from '../../src/brain/memory/memory_manager';
import { HierarchyLevel, type Strategy } from '../../src/brain/memory/trace_types';
import type { InferenceFunction } from '../../src/brain/inference/inference';

// =============================================================================
// Test fixtures
// =============================================================================

const TEST_DIR = path.join(__dirname, '__test_planner__');
const STRATEGIES_DIR = path.join(TEST_DIR, 'strategies');
const SYSTEM_DIR = path.join(TEST_DIR, 'system');
const SKILLS_DIR = path.join(TEST_DIR, 'skills');
const TRACES_DIR = path.join(TEST_DIR, 'traces');

function cleanup(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function createDirs(): void {
  for (const dir of [
    path.join(STRATEGIES_DIR, 'level_1_goals'),
    path.join(STRATEGIES_DIR, 'level_2_routes'),
    path.join(STRATEGIES_DIR, 'level_3_tactical'),
    path.join(STRATEGIES_DIR, 'level_4_motor'),
    path.join(STRATEGIES_DIR, '_seeds'),
    SYSTEM_DIR,
    SKILLS_DIR,
    TRACES_DIR,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(STRATEGIES_DIR, '_negative_constraints.md'), '# Negative Constraints\n');
  fs.writeFileSync(path.join(STRATEGIES_DIR, '_dream_journal.md'), '# Dream Journal\n');
}

function writeStrategy(level: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(STRATEGIES_DIR, level, filename), content);
}

// =============================================================================
// Mock inference
// =============================================================================

function createMockInfer(response: string): InferenceFunction {
  return jest.fn().mockResolvedValue(response);
}

function createMemoryManager(): MemoryManager {
  return new MemoryManager({
    systemDir: SYSTEM_DIR,
    skillsDir: SKILLS_DIR,
    tracesDir: TRACES_DIR,
    strategiesDir: STRATEGIES_DIR,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('HierarchicalPlanner', () => {
  beforeEach(() => {
    cleanup();
    createDirs();
  });

  afterAll(cleanup);

  // ---------------------------------------------------------------------------
  // Graceful degradation (no strategies)
  // ---------------------------------------------------------------------------

  describe('cold start (no strategies)', () => {
    it('should return a single exploratory step when no strategies exist', async () => {
      const infer = createMockInfer('{}');
      const mm = createMemoryManager();
      const planner = new HierarchicalPlanner(infer, mm);

      const plan = await planner.planGoal('the kitchen');

      expect(plan.mainGoal).toBe('the kitchen');
      expect(plan.traceId).toMatch(/^tr_/);
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].description).toContain('Explore toward');
      expect(plan.steps[0].targetLabel).toBe('the kitchen');
      // Should NOT have called the inference API (no strategies = skip LLM)
      expect(infer).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // With strategies
  // ---------------------------------------------------------------------------

  describe('with strategies available', () => {
    beforeEach(() => {
      // Write a route strategy
      writeStrategy('level_2_routes', 'strat_2_hallway.md', `---
id: strat_2_hallway
version: 1
level: 2
title: Hallway Navigation
trigger_goals: ["kitchen", "hallway", "navigate"]
preconditions: ["camera active"]
confidence: 0.7
success_count: 5
failure_count: 1
source_traces: ["tr_001"]
deprecated: false
---

# Hallway Navigation

## Steps

1. Enter the hallway
2. Follow the hallway forward
3. Turn at the end toward the kitchen
`);

      // Write a negative constraint
      fs.appendFileSync(
        path.join(STRATEGIES_DIR, '_negative_constraints.md'),
        `
### Do not reverse in narrow hallways
**Context:** hallway
**Severity:** high
**Learned from:** tr_002
`,
      );
    });

    it('should call LLM to decompose goal when strategies are available', async () => {
      const infer = createMockInfer(JSON.stringify({
        steps: [
          { description: 'Navigate through hallway', targetLabel: 'hallway' },
          { description: 'Enter the kitchen', targetLabel: 'kitchen' },
        ],
      }));
      const mm = createMemoryManager();
      const planner = new HierarchicalPlanner(infer, mm);

      const plan = await planner.planGoal('the kitchen');

      expect(plan.steps).toHaveLength(2);
      expect(plan.steps[0].description).toBe('Navigate through hallway');
      expect(plan.steps[0].targetLabel).toBe('hallway');
      expect(plan.steps[1].description).toBe('Enter the kitchen');
      expect(plan.negativeConstraints.length).toBeGreaterThan(0);
      expect(infer).toHaveBeenCalledTimes(1);
    });

    it('should include negative constraints in plan', async () => {
      const infer = createMockInfer(JSON.stringify({
        steps: [{ description: 'Go to kitchen', targetLabel: 'kitchen' }],
      }));
      const mm = createMemoryManager();
      const planner = new HierarchicalPlanner(infer, mm);

      const plan = await planner.planGoal('the kitchen');

      expect(plan.negativeConstraints).toHaveLength(1);
      expect(plan.negativeConstraints[0].description).toBe('Do not reverse in narrow hallways');
      expect(plan.steps[0].constraints).toContain('Do not reverse in narrow hallways');
    });

    it('should fall back to exploratory step on LLM parse failure', async () => {
      const infer = createMockInfer('This is not valid JSON at all');
      const mm = createMemoryManager();
      const planner = new HierarchicalPlanner(infer, mm);

      const plan = await planner.planGoal('the kitchen');

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].description).toContain('Explore toward');
    });

    it('should fall back to exploratory step on LLM error', async () => {
      const infer = jest.fn().mockRejectedValue(new Error('API timeout'));
      const mm = createMemoryManager();
      const planner = new HierarchicalPlanner(infer, mm);

      const plan = await planner.planGoal('the kitchen');

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].description).toContain('Explore toward');
    });
  });

  // ---------------------------------------------------------------------------
  // planStrategicStep
  // ---------------------------------------------------------------------------

  describe('planStrategicStep', () => {
    it('should return tactical detail when no tactical strategies exist', async () => {
      const infer = createMockInfer('{}');
      const mm = createMemoryManager();
      const planner = new HierarchicalPlanner(infer, mm);

      const result = await planner.planStrategicStep(
        {
          level: HierarchyLevel.STRATEGY,
          description: 'Navigate through hallway',
          constraints: ['stay centered'],
        },
        'A long hallway with doors on both sides',
        'tr_parent_123',
      );

      expect(result.traceId).toMatch(/^tr_/);
      expect(result.tacticalGoal).toBe('Navigate through hallway');
      expect(result.constraints).toContain('stay centered');
    });

    it('should enrich tactical goal when tactical strategies exist', async () => {
      writeStrategy('level_3_tactical', 'strat_3_hallway.md', `---
id: strat_3_hallway_traverse
version: 1
level: 3
title: Hallway Traversal
trigger_goals: ["hallway", "navigate", "corridor"]
confidence: 0.6
deprecated: false
---

# Hallway Traversal

## Steps

1. Align with center of hallway
2. Move forward at moderate speed
3. Check for obstacles at intersections
`);

      const infer = createMockInfer(JSON.stringify({
        tacticalGoal: 'Align with hallway center and move forward at 60% speed',
        constraints: ['check intersections', 'maintain center'],
        strategyHint: 'Use hallway traversal pattern',
      }));
      const mm = createMemoryManager();
      const planner = new HierarchicalPlanner(infer, mm);

      const result = await planner.planStrategicStep(
        {
          level: HierarchyLevel.STRATEGY,
          description: 'Navigate through hallway',
          constraints: [],
        },
        'A long hallway',
        'tr_parent_123',
      );

      expect(result.tacticalGoal).toBe('Align with hallway center and move forward at 60% speed');
      expect(result.strategyHint).toBe('Use hallway traversal pattern');
      expect(result.constraints).toContain('check intersections');
    });
  });
});
