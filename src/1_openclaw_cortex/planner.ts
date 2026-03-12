/**
 * Hierarchical Planner — Multi-step goal decomposition with strategy injection
 *
 * Level 1 (Goal): Breaks a high-level goal into strategic steps
 * Level 2 (Strategy): Plans navigation using tactical strategies
 *
 * Gracefully degrades: if no strategies/map exist, returns a single
 * exploratory step identical to the old behavior.
 */

import { logger } from '../shared/logger';
import type { InferenceFunction } from '../llmunix-core/interfaces';
import { MemoryManager } from '../3_llmunix_memory/memory_manager';
import { HierarchyLevel, type Strategy, type NegativeConstraint } from '../3_llmunix_memory/trace_types';
import { TraceSource } from '../llmunix-core/types';
import { parseJSONSafe } from '../llmunix-core/utils';
import { traceLogger } from '../3_llmunix_memory/trace_logger';

// =============================================================================
// Types
// =============================================================================

export interface PlanStep {
  level: HierarchyLevel;
  description: string;
  targetLabel?: string;
  strategy?: Strategy;
  constraints: string[];
}

export interface ExecutionPlan {
  mainGoal: string;
  traceId: string;
  steps: PlanStep[];
  negativeConstraints: NegativeConstraint[];
}

// =============================================================================
// Prompts
// =============================================================================

const GOAL_DECOMPOSITION_SYSTEM = `You are a robot planning system. Given a high-level goal, the robot's known map, and available strategies, decompose the goal into ordered navigation steps.

Each step should be a specific location or action the robot can execute.

Output ONLY valid JSON (no markdown, no explanation):
{
  "steps": [
    {"description": "Navigate to hallway", "targetLabel": "hallway"},
    {"description": "Navigate through hallway to kitchen", "targetLabel": "kitchen"},
    {"description": "Search for target object", "targetLabel": null}
  ]
}

If you don't have enough information to plan, output a single exploratory step:
{
  "steps": [
    {"description": "Explore toward target", "targetLabel": null}
  ]
}`;

const STRATEGIC_PLANNING_SYSTEM = `You are a robot tactical planner. Given a navigation step, available strategies, and constraints, produce a tactical goal with specific instructions.

Output ONLY valid JSON (no markdown, no explanation):
{
  "tacticalGoal": "Navigate through the doorway ahead, maintaining center alignment",
  "constraints": ["slow down near doorway", "check clearance before proceeding"],
  "strategyHint": "Use doorway approach pattern: slow, center, proceed"
}`;

// =============================================================================
// HierarchicalPlanner
// =============================================================================

export class HierarchicalPlanner {
  private infer: InferenceFunction;
  private memoryManager: MemoryManager;
  private traceSource: TraceSource;

  constructor(infer: InferenceFunction, memoryManager: MemoryManager, traceSource?: TraceSource) {
    this.infer = infer;
    this.memoryManager = memoryManager;
    this.traceSource = traceSource ?? TraceSource.UNKNOWN_SOURCE;
  }

  /**
   * Plan a high-level goal (Level 1).
   *
   * If strategies and map info are available, decomposes into multi-step plan.
   * Otherwise, returns a single exploratory step (graceful degradation).
   */
  async planGoal(mainGoal: string, currentScene?: string): Promise<ExecutionPlan> {
    const traceId = traceLogger.startTrace(HierarchyLevel.GOAL, mainGoal, {
      sceneDescription: currentScene,
      source: this.traceSource,
    });

    // Gather context
    const goalStrategies = this.memoryManager.findRelevantStrategies(mainGoal, HierarchyLevel.GOAL);
    const routeStrategies = this.memoryManager.findRelevantStrategies(mainGoal, HierarchyLevel.STRATEGY);
    const negativeConstraints = this.memoryManager.getNegativeConstraints();

    // If no strategies or map info available, return single exploratory step
    if (goalStrategies.length === 0 && routeStrategies.length === 0) {
      logger.debug('Planner', 'No strategies found, returning exploratory step');
      return {
        mainGoal,
        traceId,
        steps: [{
          level: HierarchyLevel.STRATEGY,
          description: `Explore toward: ${mainGoal}`,
          targetLabel: mainGoal,
          constraints: negativeConstraints.map(nc => nc.description),
        }],
        negativeConstraints,
      };
    }

    // Build prompt with context
    const strategyText = [...goalStrategies, ...routeStrategies]
      .slice(0, 5)
      .map(s => `- ${s.title}: ${s.steps.join(' → ')} (confidence: ${s.confidence.toFixed(2)})`)
      .join('\n');

    const constraintText = negativeConstraints
      .slice(0, 10)
      .map(nc => `- [${nc.severity}] ${nc.description}`)
      .join('\n');

    const prompt = [
      `Goal: ${mainGoal}`,
      currentScene ? `Current scene: ${currentScene}` : '',
      '',
      strategyText ? `Available strategies:\n${strategyText}` : '',
      constraintText ? `Constraints (things to avoid):\n${constraintText}` : '',
      '',
      'Decompose this goal into ordered navigation steps.',
    ].filter(Boolean).join('\n');

    try {
      const response = await this.infer(GOAL_DECOMPOSITION_SYSTEM, prompt);
      const parsed = parseJSONSafe<{ steps: Array<{ description: string; targetLabel?: string | null }> }>(response);

      if (!parsed || !parsed.steps || parsed.steps.length === 0) {
        logger.warn('Planner', 'LLM returned unparseable plan, falling back to single step');
        return {
          mainGoal,
          traceId,
          steps: [{
            level: HierarchyLevel.STRATEGY,
            description: `Explore toward: ${mainGoal}`,
            targetLabel: mainGoal,
            constraints: negativeConstraints.map(nc => nc.description),
          }],
          negativeConstraints,
        };
      }

      const steps: PlanStep[] = parsed.steps.map(s => {
        // Find best strategy for THIS step's description (not the main goal)
        const stepStrategies = this.memoryManager.findRelevantStrategies(
          s.description, HierarchyLevel.STRATEGY,
        );
        return {
          level: HierarchyLevel.STRATEGY,
          description: s.description,
          targetLabel: s.targetLabel ?? undefined,
          strategy: stepStrategies.length > 0 ? stepStrategies[0] : undefined,
          constraints: negativeConstraints.map(nc => nc.description),
        };
      });

      logger.info('Planner', `Planned ${steps.length} steps for "${mainGoal}"`);
      return { mainGoal, traceId, steps, negativeConstraints };
    } catch (err) {
      logger.error('Planner', 'Goal planning failed, falling back', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        mainGoal,
        traceId,
        steps: [{
          level: HierarchyLevel.STRATEGY,
          description: `Explore toward: ${mainGoal}`,
          targetLabel: mainGoal,
          constraints: negativeConstraints.map(nc => nc.description),
        }],
        negativeConstraints,
      };
    }
  }

  /**
   * Plan a strategic step (Level 2).
   *
   * Takes a step from planGoal() and adds tactical detail using strategies.
   */
  async planStrategicStep(
    step: PlanStep,
    currentScene: string,
    parentTraceId: string,
  ): Promise<{ traceId: string; tacticalGoal: string; constraints: string[]; strategyHint: string }> {
    const traceId = traceLogger.startTrace(HierarchyLevel.STRATEGY, step.description, {
      parentTraceId,
      sceneDescription: currentScene,
      activeStrategyId: step.strategy?.id,
      source: this.traceSource,
    });

    // Gather tactical strategies
    const tacticalStrategies = this.memoryManager.findRelevantStrategies(
      step.description, HierarchyLevel.TACTICAL,
    );

    if (tacticalStrategies.length === 0 && !step.strategy) {
      return {
        traceId,
        tacticalGoal: step.description,
        constraints: step.constraints,
        strategyHint: '',
      };
    }

    const strategyText = tacticalStrategies
      .slice(0, 3)
      .map(s => `- ${s.title}: ${s.steps.join(' → ')}`)
      .join('\n');

    const prompt = [
      `Step: ${step.description}`,
      `Current scene: ${currentScene}`,
      strategyText ? `Available tactical strategies:\n${strategyText}` : '',
      step.constraints.length > 0 ? `Constraints: ${step.constraints.join('; ')}` : '',
    ].filter(Boolean).join('\n');

    try {
      const response = await this.infer(STRATEGIC_PLANNING_SYSTEM, prompt);
      const parsed = parseJSONSafe<{
        tacticalGoal: string;
        constraints: string[];
        strategyHint: string;
      }>(response);

      if (!parsed) {
        return {
          traceId,
          tacticalGoal: step.description,
          constraints: step.constraints,
          strategyHint: '',
        };
      }

      return {
        traceId,
        tacticalGoal: parsed.tacticalGoal,
        constraints: [...step.constraints, ...(parsed.constraints || [])],
        strategyHint: parsed.strategyHint || '',
      };
    } catch {
      return {
        traceId,
        tacticalGoal: step.description,
        constraints: step.constraints,
        strategyHint: '',
      };
    }
  }
}
