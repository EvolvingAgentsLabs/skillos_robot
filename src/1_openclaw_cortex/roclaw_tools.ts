/**
 * RoClaw Tools — OpenClaw tool handler implementations
 *
 * Maps high-level OpenClaw tool invocations to Cerebellum actions.
 * Each tool translates a human intent into a motor control goal.
 */

import { logger } from '../shared/logger';
import { BytecodeCompiler, Opcode, formatHex } from '../2_qwen_cerebellum/bytecode_compiler';
import { UDPTransmitter } from '../2_qwen_cerebellum/udp_transmitter';
import { VisionLoop } from '../2_qwen_cerebellum/vision_loop';
import { CerebellumInference } from '../2_qwen_cerebellum/inference';
import type { InferenceFunction } from '../llmunix-core/interfaces';
import { GeminiRoboticsInference } from '../2_qwen_cerebellum/gemini_robotics';
import { MemoryManager } from '../3_llmunix_memory/memory_manager';
import { PoseMap, SemanticMap } from '../3_llmunix_memory/semantic_map';
import { SemanticMapLoop } from '../3_llmunix_memory/semantic_map_loop';
import { HierarchicalPlanner, type ExecutionPlan } from './planner';
import { HierarchyLevel, TraceOutcome } from '../3_llmunix_memory/trace_types';
import { TraceSource } from '../llmunix-core/types';
import { traceLogger } from '../3_llmunix_memory/trace_logger';

// =============================================================================
// Types
// =============================================================================

export interface ToolResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export interface ToolContext {
  compiler: BytecodeCompiler;
  transmitter: UDPTransmitter;
  visionLoop: VisionLoop;
  infer: InferenceFunction;
  /** Trace source for memory fidelity (defaults to REAL_WORLD) */
  traceSource?: TraceSource;
}

// Module-level singletons — avoids changing ToolContext interface
const memoryManager = new MemoryManager();
const poseMap = new PoseMap();

// Lazy-initialized — requires InferenceFunction which isn't available at module load
let topoMap: SemanticMap | null = null;
let topoMapLoop: SemanticMapLoop | null = null;
let planner: HierarchicalPlanner | null = null;

// Dedicated inference for scene analysis — higher token limit and longer timeout than bytecode inference
let mapInferenceFunc: InferenceFunction | null = null;

// Navigation session state for multi-step plan execution
interface NavigationSession {
  plan: ExecutionPlan;
  currentStepIndex: number;
  currentStepTraceId: string | null;
  ctx: ToolContext;
  arrivalListener: (vlmOutput: string) => void;
  stuckListener: (vlmOutput: string) => void;
  stepTimeoutListener: (elapsed: number) => void;
  retryCount: number;
}

let activeSession: NavigationSession | null = null;
let activeExploreTraceId: string | null = null;

function ensureMapInfer(): InferenceFunction {
  if (!mapInferenceFunc) {
    const googleApiKey = process.env.GOOGLE_API_KEY;
    if (googleApiKey) {
      // Use Gemini for scene analysis (no tool calling — text analysis only)
      const gemini = new GeminiRoboticsInference({
        apiKey: googleApiKey,
        model: process.env.GEMINI_MODEL || 'gemini-robotics-er-1.5-preview',
        maxOutputTokens: 1024,
        timeoutMs: 30000,
        temperature: 0.3,
        thinkingBudget: 0,
        useToolCalling: false,
      });
      mapInferenceFunc = gemini.createInferenceFunction();
    } else {
      const cerebellum = new CerebellumInference({
        apiKey: process.env.OPENROUTER_API_KEY || '',
        model: process.env.QWEN_MODEL || 'qwen/qwen-2.5-vl-72b-instruct',
        maxTokens: 512,
        timeoutMs: 30000,
        temperature: 0.3,
        ...(process.env.LOCAL_INFERENCE_URL ? { apiBaseUrl: process.env.LOCAL_INFERENCE_URL } : {}),
      });
      mapInferenceFunc = cerebellum.createInferenceFunction();
    }
  }
  return mapInferenceFunc;
}

function ensurePlanner(ctx: ToolContext): HierarchicalPlanner {
  if (!planner) {
    planner = new HierarchicalPlanner(ctx.infer, memoryManager, ctx.traceSource);
  }
  return planner;
}

function ensureTopoMap(): SemanticMap {
  if (!topoMap) {
    topoMap = new SemanticMap(ensureMapInfer());
  }
  return topoMap;
}

function ensureTopoMapLoop(ctx: ToolContext): SemanticMapLoop {
  if (!topoMapLoop) {
    const sm = ensureTopoMap();
    topoMapLoop = new SemanticMapLoop(
      sm,
      ctx.visionLoop,
      ensureMapInfer(),
      ctx.compiler,
      ctx.transmitter,
    );
  }
  return topoMapLoop;
}

/** Exposed for testing — allows injecting a mock MemoryManager */
export function _getMemoryManager(): MemoryManager {
  return memoryManager;
}

/** Exposed for testing — allows accessing the PoseMap */
export function _getPoseMap(): PoseMap {
  return poseMap;
}

/** Exposed for testing — allows accessing the topological SemanticMap */
export function _getTopoMap(): SemanticMap | null {
  return topoMap;
}

/** Exposed for testing — allows accessing the SemanticMapLoop */
export function _getTopoMapLoop(): SemanticMapLoop | null {
  return topoMapLoop;
}

/** Abort the active navigation session and close its traces. */
function abortActiveSession(outcome: TraceOutcome, reason: string): void {
  if (!activeSession) return;

  const session = activeSession;
  activeSession = null;

  // Remove all listeners
  session.ctx.visionLoop.removeListener('arrival', session.arrivalListener);
  session.ctx.visionLoop.removeListener('stuck', session.stuckListener);
  session.ctx.visionLoop.removeListener('stepTimeout', session.stepTimeoutListener);

  // Close current step trace
  if (session.currentStepTraceId) {
    traceLogger.endTrace(session.currentStepTraceId, outcome, reason);
  }

  // Close GOAL-level trace
  traceLogger.endTrace(session.plan.traceId, outcome, reason);

  // Clear VisionLoop hierarchical state
  session.ctx.visionLoop.setActiveTraceId(null);
  session.ctx.visionLoop.setConstraints([]);
}

/** Exposed for testing — reset navigation session state */
export function _resetNavigationSession(): void {
  if (activeSession) {
    activeSession.ctx.visionLoop.removeListener('arrival', activeSession.arrivalListener);
    activeSession.ctx.visionLoop.removeListener('stuck', activeSession.stuckListener);
    activeSession.ctx.visionLoop.removeListener('stepTimeout', activeSession.stepTimeoutListener);
  }
  activeSession = null;
  activeExploreTraceId = null;
}

/** Exposed for testing — reset lazy singletons */
export function _resetTopoMap(): void {
  _resetNavigationSession();
  topoMapLoop?.stop();
  topoMapLoop = null;
  topoMap = null;
  planner = null;
  mapInferenceFunc = null;
}

// =============================================================================
// Tool Definitions
// =============================================================================

export const TOOL_DEFINITIONS = [
  {
    name: 'robot.read_memory',
    description: 'Read the robot\'s memory (hardware profile, identity, skills, recent traces). Use this to understand physical capabilities and distill constraints before issuing movement commands.',
  },
  {
    name: 'robot.explore',
    description: 'Start exploring the environment, avoiding obstacles',
    parameters: { constraints: 'string (optional)' },
  },
  {
    name: 'robot.go_to',
    description: 'Navigate to a described location (e.g., "the kitchen", "the door")',
    parameters: { location: 'string', constraints: 'string (optional)' },
  },
  {
    name: 'robot.describe_scene',
    description: 'Take a photo and describe what the robot currently sees',
  },
  {
    name: 'robot.stop',
    description: 'Immediately stop all motor movement',
  },
  {
    name: 'robot.status',
    description: 'Get current robot status (pose, motor state, battery)',
  },
  {
    name: 'robot.record_observation',
    description: 'Record what the robot sees at its current pose to build a semantic map. Call this when the robot identifies a notable location (kitchen, door, hallway, etc.)',
    parameters: { label: 'string', confidence: 'number (optional, 0-1)' },
  },
  {
    name: 'robot.analyze_scene',
    description: 'Run an on-demand VLM-powered scene analysis. Returns structured location data including label, features, navigation hints, and confidence.',
  },
  {
    name: 'robot.get_map',
    description: 'Get the robot\'s map of known locations. Returns both the PoseMap (label+coordinates) and the topological graph (nodes, edges, navigation context) if available.',
  },
] as const;

export type ToolName = typeof TOOL_DEFINITIONS[number]['name'];

// =============================================================================
// Tool Handlers
// =============================================================================

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  switch (toolName) {
    case 'robot.read_memory':
      return handleReadMemory();

    case 'robot.explore':
      return handleExplore(ctx, args.constraints as string | undefined);

    case 'robot.go_to':
      return handleGoTo(args.location as string, ctx, args.constraints as string | undefined);

    case 'robot.describe_scene':
      return handleDescribeScene(ctx);

    case 'robot.stop':
      return handleStop(ctx);

    case 'robot.status':
      return handleStatus(ctx);

    case 'robot.record_observation':
      return handleRecordObservation(args.label as string, ctx, args.confidence as number | undefined);

    case 'robot.analyze_scene':
      return handleAnalyzeScene(ctx);

    case 'robot.get_map':
      return handleGetMap(ctx);

    default:
      return { success: false, message: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// Step retry on stuck/timeout
// ---------------------------------------------------------------------------

async function handleStepRetry(session: NavigationSession, reason: string): Promise<void> {
  const MAX_RETRIES = 2;
  if (session.retryCount >= MAX_RETRIES) {
    abortActiveSession(TraceOutcome.FAILURE, `${reason} after ${MAX_RETRIES} retries`);
    return;
  }
  session.retryCount++;

  // Close current step trace as PARTIAL
  if (session.currentStepTraceId) {
    traceLogger.endTrace(session.currentStepTraceId, TraceOutcome.PARTIAL, reason);
  }

  // Re-plan the current step with fresh scene context
  const step = session.plan.steps[session.currentStepIndex];
  const hp = ensurePlanner(session.ctx);
  try {
    let scene = 'Robot appears stuck';
    const frame = session.ctx.visionLoop.getLatestFrameBase64();
    if (frame) {
      try {
        scene = await session.ctx.infer(
          'You are a stuck robot. Describe what you see and why you might be stuck.',
          'Describe the scene.', [frame]);
      } catch { /* optional */ }
    }
    const tactical = await hp.planStrategicStep(step, scene, session.plan.traceId);
    session.currentStepTraceId = tactical.traceId;
    const goal = tactical.constraints.length > 0
      ? `${tactical.tacticalGoal}\nConstraints: ${tactical.constraints.join('; ')}`
      : tactical.tacticalGoal;
    session.ctx.visionLoop.setGoal(goal);
    session.ctx.visionLoop.resetStepTimer();
  } catch (err) {
    abortActiveSession(TraceOutcome.FAILURE, `Re-plan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Multi-step plan advancement
// ---------------------------------------------------------------------------

async function advanceToNextStep(session: NavigationSession, vlmOutput: string): Promise<void> {
  const { plan, ctx } = session;

  // Close current step trace as SUCCESS
  if (session.currentStepTraceId) {
    traceLogger.endTrace(session.currentStepTraceId, TraceOutcome.SUCCESS, vlmOutput);
    session.currentStepTraceId = null;
  }

  // Move to next step
  session.currentStepIndex++;

  if (session.currentStepIndex >= plan.steps.length) {
    // All steps complete — close GOAL trace as SUCCESS
    traceLogger.endTrace(plan.traceId, TraceOutcome.SUCCESS, 'All steps completed');
    ctx.visionLoop.removeListener('arrival', session.arrivalListener);
    ctx.visionLoop.removeListener('stuck', session.stuckListener);
    ctx.visionLoop.removeListener('stepTimeout', session.stepTimeoutListener);
    ctx.visionLoop.stop();
    ctx.visionLoop.setActiveTraceId(null);
    ctx.visionLoop.setConstraints([]);
    activeSession = null;
    logger.info('Tools', `Navigation plan completed: "${plan.mainGoal}"`);
    return;
  }

  // More steps remain — reset retry count and step timer
  session.retryCount = 0;
  ctx.visionLoop.resetStepTimer();

  // More steps remain — plan the next one
  const nextStep = plan.steps[session.currentStepIndex];
  logger.info('Tools', `Advancing to step ${session.currentStepIndex + 1}/${plan.steps.length}: "${nextStep.description}"`);

  // Level 2→3 decomposition via planStrategicStep
  const hp = ensurePlanner(ctx);
  let tacticalGoal = nextStep.description;
  let stepConstraints = nextStep.constraints;
  let strategyHint = '';
  let currentScene = 'Unknown scene';

  try {
    const frameBase64 = ctx.visionLoop.getLatestFrameBase64();
    if (frameBase64) {
      try {
        currentScene = await ctx.infer(
          'You are a robot with a camera. Briefly describe what you see.',
          'Describe the current scene.',
          [frameBase64],
        );
      } catch { /* scene description is optional */ }
    }

    const tactical = await hp.planStrategicStep(nextStep, currentScene, plan.traceId);
    session.currentStepTraceId = tactical.traceId;
    tacticalGoal = tactical.tacticalGoal;
    stepConstraints = tactical.constraints;
    strategyHint = tactical.strategyHint;
  } catch (err) {
    // Fall back to using the step description directly
    session.currentStepTraceId = traceLogger.startTrace(
      HierarchyLevel.STRATEGY, nextStep.description, {
        parentTraceId: plan.traceId,
        source: ctx.traceSource ?? TraceSource.REAL_WORLD,
      },
    );
    logger.debug('Tools', 'Strategic planning for next step failed, using description', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Use topo map for navigation if available — reuse currentScene to avoid duplicate VLM call
  let navGoal = tacticalGoal;
  try {
    const sm = ensureTopoMap();
    if (sm.getAllNodes().length > 0 && nextStep.targetLabel && currentScene !== 'Unknown scene') {
      const decision = await sm.planNavigation(currentScene, nextStep.targetLabel, strategyHint, stepConstraints);
      if (decision && decision.confidence > 0.5) {
        navGoal = `${tacticalGoal} [TopoMap: "${decision.reasoning}"]`;
      }
    }
  } catch {
    // Topo navigation is optional
  }

  const goalWithConstraints = stepConstraints.length > 0
    ? `${navGoal}\nConstraints: ${stepConstraints.join('; ')}`
    : navGoal;

  // Update VisionLoop goal (no stop/restart — just update for next frame)
  ctx.visionLoop.setGoal(goalWithConstraints);
  if (session.currentStepTraceId) {
    ctx.visionLoop.setActiveTraceId(session.currentStepTraceId);
  }
}

// ---------------------------------------------------------------------------
// Individual handlers
// ---------------------------------------------------------------------------

async function handleReadMemory(): Promise<ToolResult> {
  logger.info('Tools', 'robot.read_memory invoked');

  const content = memoryManager.getFullContext();

  // Check which strategy levels are populated
  const hasStrategicSkills = memoryManager.getStrategiesForLevel(HierarchyLevel.STRATEGY).length > 0;
  const hasTacticalSkills = memoryManager.getStrategiesForLevel(HierarchyLevel.TACTICAL).length > 0;
  const hasReactiveSkills = memoryManager.getStrategiesForLevel(HierarchyLevel.REACTIVE).length > 0;

  return {
    success: true,
    message: content || 'No memory files found.',
    data: {
      type: 'memory',
      hasStrategicSkills,
      hasTacticalSkills,
      hasReactiveSkills,
    },
  };
}

async function handleExplore(ctx: ToolContext, constraints?: string): Promise<ToolResult> {
  logger.info('Tools', 'robot.explore invoked', constraints ? { constraints } : undefined);

  const baseGoal = 'Explore the environment. Move forward when the path is clear. Turn to avoid obstacles. Look for interesting objects.';

  // Inject reactive strategies and constraints from memory
  const memoryConstraints: string[] = [];
  try {
    const reactiveStrategies = memoryManager.findRelevantStrategies('explore', HierarchyLevel.REACTIVE);
    if (reactiveStrategies.length > 0) {
      for (const strat of reactiveStrategies.slice(0, 3)) {
        memoryConstraints.push(`[${strat.title}]: ${strat.steps.join(', ')}`);
        if (strat.spatialRules && strat.spatialRules.length > 0) {
          for (const rule of strat.spatialRules) {
            memoryConstraints.push(`[SPATIAL] ${rule}`);
          }
        }
      }
    }
    const negConstraints = memoryManager.getNegativeConstraints();
    for (const nc of negConstraints.slice(0, 5)) {
      memoryConstraints.push(`AVOID: ${nc.description}`);
    }
  } catch {
    // Memory is optional
  }

  const allConstraints = constraints
    ? [...memoryConstraints, constraints]
    : memoryConstraints;
  const goal = allConstraints.length > 0
    ? `${baseGoal}\nConstraints: ${allConstraints.join('; ')}`
    : baseGoal;

  // Abort any active navigation session or previous explore
  abortActiveSession(TraceOutcome.ABORTED, 'New explore started');
  if (activeExploreTraceId) {
    traceLogger.endTrace(activeExploreTraceId, TraceOutcome.ABORTED, 'New explore started');
  }

  // Create GOAL-level trace for this exploration
  activeExploreTraceId = traceLogger.startTrace(HierarchyLevel.GOAL, `Explore: ${constraints || 'autonomous'}`, {
    source: ctx.traceSource ?? TraceSource.REAL_WORLD,
  });

  try {
    if (memoryConstraints.length > 0) {
      ctx.visionLoop.setConstraints(memoryConstraints);
    }

    ctx.visionLoop.setActiveTraceId(activeExploreTraceId);
    await ctx.visionLoop.start(goal);

    // Start topological mapping in the background
    try {
      ensureTopoMapLoop(ctx).start();
    } catch (err) {
      logger.warn('Tools', 'Failed to start topo map loop', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      success: true,
      message: 'Exploration started. The robot is now autonomously navigating.',
    };
  } catch (error) {
    // Close explore trace on failure
    if (activeExploreTraceId) {
      traceLogger.endTrace(activeExploreTraceId, TraceOutcome.FAILURE,
        error instanceof Error ? error.message : String(error));
      activeExploreTraceId = null;
    }
    return {
      success: false,
      message: `Failed to start exploration: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function handleGoTo(location: string, ctx: ToolContext, constraints?: string): Promise<ToolResult> {
  if (!location) {
    return { success: false, message: 'No location specified' };
  }

  logger.info('Tools', `robot.go_to: ${location}`, constraints ? { constraints } : undefined);

  // --- Hierarchical Planning (v2) ---
  // Try to plan via the hierarchical planner first. If it produces a multi-step
  // plan with strategies, inject them. Otherwise fall through to existing logic.
  let plannerHint = '';
  let planConstraints: string[] = [];
  let activeTraceId: string | null = null;
  let plan: ExecutionPlan | null = null;
  let strategyHintForNav = '';

  try {
    const hp = ensurePlanner(ctx);

    // Get current scene for planning context
    let currentScene: string | undefined;
    const frameBase64 = ctx.visionLoop.getLatestFrameBase64();
    if (frameBase64) {
      try {
        currentScene = await ctx.infer(
          'You are a robot with a camera. Briefly describe what you see.',
          'Describe the current scene.',
          [frameBase64],
        );
      } catch { /* scene description is optional */ }
    }

    plan = await hp.planGoal(location, currentScene);
    activeTraceId = plan.traceId;

    if (plan.steps.length > 0) {
      // Collect constraints from all steps
      for (const step of plan.steps) {
        planConstraints.push(...step.constraints);
      }

      // Build strategy hint from first step
      const firstStep = plan.steps[0];
      if (firstStep.strategy) {
        strategyHintForNav = `${firstStep.strategy.title}: ${firstStep.strategy.steps.join(' → ')}`;
        plannerHint = ` [Strategy: "${firstStep.strategy.title}" — ${firstStep.strategy.steps.join(' → ')}]`;
        // Inject spatial rules from strategy
        if (firstStep.strategy.spatialRules && firstStep.strategy.spatialRules.length > 0) {
          for (const rule of firstStep.strategy.spatialRules) {
            planConstraints.push(`[SPATIAL] ${rule}`);
          }
        }
      }

      // Deduplicate
      planConstraints = [...new Set(planConstraints)];
      if (plan.steps.length > 1) {
        const stepDescs = plan.steps.map((s, i) => `${i + 1}. ${s.description}`).join(', ');
        plannerHint += ` [Plan: ${stepDescs}]`;
      }
    }
  } catch (err) {
    logger.debug('Tools', 'Hierarchical planning unavailable, falling back', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // --- PoseMap fallback (existing) ---
  const knownLocation = poseMap.findNearest(location);
  let baseGoal: string;
  let navHint = '';

  if (knownLocation) {
    const { x, y, heading } = knownLocation.pose;
    navHint = ` (Previously seen "${knownLocation.label}" near pose [${x.toFixed(1)}, ${y.toFixed(1)}], heading ${heading.toFixed(0)}°)`;
    baseGoal = `Navigate to: ${location}. Known location from memory: "${knownLocation.label}" was seen at coordinates (${x.toFixed(1)}, ${y.toFixed(1)}). Head toward those coordinates. Use visual cues to confirm arrival. Stop when you arrive.`;
    logger.info('Tools', `Semantic map hit: "${knownLocation.label}" at (${x.toFixed(1)}, ${y.toFixed(1)})`);
  } else {
    baseGoal = `Navigate to: ${location}. No prior memory of this location. Explore and look for visual cues that indicate this location. Move toward it. Stop when you arrive.`;
    logger.info('Tools', `No semantic map entry for "${location}", exploring`);
  }

  // Merge constraints from planner + user
  const allConstraints = constraints
    ? [...planConstraints, constraints]
    : planConstraints;
  let goal = allConstraints.length > 0
    ? `${baseGoal}\nConstraints: ${allConstraints.join('; ')}`
    : baseGoal;

  // Abort any previous navigation session or explore trace before starting new one
  abortActiveSession(TraceOutcome.ABORTED, 'New navigation started');
  if (activeExploreTraceId) {
    traceLogger.endTrace(activeExploreTraceId, TraceOutcome.ABORTED, 'New navigation started');
    activeExploreTraceId = null;
  }

  try {
    // Set hierarchical tracing on VisionLoop
    if (activeTraceId) {
      ctx.visionLoop.setActiveTraceId(activeTraceId);
    }
    if (planConstraints.length > 0) {
      ctx.visionLoop.setConstraints(planConstraints);
    }

    await ctx.visionLoop.start(goal);

    // --- Seed topo map BEFORE planning navigation ---
    // Start SemanticMapLoop and run immediate analysis so the topo map
    // has at least one node for planNavigation() to work with.
    try {
      const mapLoop = ensureTopoMapLoop(ctx);
      mapLoop.start();
      await mapLoop.analyzeNow();
    } catch {
      // Topo seeding is best-effort
    }

    // --- Topo Navigation (uses seeded map) ---
    let topoNavHint = '';
    try {
      const sm = ensureTopoMap();
      if (sm.getAllNodes().length > 0) {
        const frameBase64 = ctx.visionLoop.getLatestFrameBase64();
        if (frameBase64) {
          const sceneDesc = await ensureMapInfer()(
            'You are a robot with a camera. Briefly describe what you see.',
            'Describe the current scene.',
            [frameBase64],
          );
          const decision = await sm.planNavigation(sceneDesc, location, strategyHintForNav, planConstraints);
          if (decision && decision.confidence > 0.5) {
            topoNavHint = ` [TopoMap: "${decision.reasoning}" (confidence: ${decision.confidence.toFixed(2)})]`;
            logger.info('Tools', `Topo navigation plan: ${decision.action} — ${decision.reasoning}`);
          }
        }
      }
    } catch (err) {
      logger.debug('Tools', 'Topo navigation planning failed, falling back to PoseMap', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Update VisionLoop goal with topo hint if available
    if (topoNavHint) {
      goal = `${goal}${topoNavHint}`;
      ctx.visionLoop.setGoal(goal);
    }

    // Create NavigationSession with arrival/stuck/timeout listeners
    if (plan) {
      const arrivalListener = (vlmOutput: string) => {
        if (activeSession) {
          advanceToNextStep(activeSession, vlmOutput).catch(err => {
            abortActiveSession(TraceOutcome.FAILURE, err instanceof Error ? err.message : String(err));
          });
        }
      };
      const stuckListener = (vlmOutput: string) => {
        if (activeSession) {
          handleStepRetry(activeSession, 'Stuck: repeated identical commands').catch(err => {
            abortActiveSession(TraceOutcome.FAILURE, err instanceof Error ? err.message : String(err));
          });
        }
      };
      const stepTimeoutListener = (elapsed: number) => {
        if (activeSession) {
          handleStepRetry(activeSession, `Step timeout (${Math.round(elapsed / 1000)}s)`).catch(err => {
            abortActiveSession(TraceOutcome.FAILURE, err instanceof Error ? err.message : String(err));
          });
        }
      };
      activeSession = {
        plan,
        currentStepIndex: 0,
        currentStepTraceId: null,
        ctx,
        arrivalListener,
        stuckListener,
        stepTimeoutListener,
        retryCount: 0,
      };
      ctx.visionLoop.on('arrival', arrivalListener);
      ctx.visionLoop.on('stuck', stuckListener);
      ctx.visionLoop.on('stepTimeout', stepTimeoutListener);
    }

    return {
      success: true,
      message: `Navigation started toward "${location}".${navHint}${topoNavHint}${plannerHint}`,
    };
  } catch (error) {
    // End trace as failed if we started one
    if (activeTraceId) {
      traceLogger.endTrace(activeTraceId, TraceOutcome.FAILURE,
        error instanceof Error ? error.message : String(error));
    }
    return {
      success: false,
      message: `Failed to start navigation: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function handleDescribeScene(ctx: ToolContext): Promise<ToolResult> {
  logger.info('Tools', 'robot.describe_scene invoked');

  try {
    // Grab the latest camera frame for visual context
    const frameBase64 = ctx.visionLoop.getLatestFrameBase64();
    const images = frameBase64 ? [frameBase64] : undefined;

    const description = await ctx.infer(
      'You are a robot with a camera. Describe what you see in detail. Focus on objects, distances, and spatial layout.',
      'Describe the current scene.',
      images,
    );

    return {
      success: true,
      message: description,
      data: { type: 'scene_description' },
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to describe scene: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function handleAnalyzeScene(ctx: ToolContext): Promise<ToolResult> {
  logger.info('Tools', 'robot.analyze_scene invoked');

  try {
    const loop = ensureTopoMapLoop(ctx);
    const analysis = await loop.analyzeNow();

    if (!analysis) {
      return {
        success: false,
        message: 'Scene analysis returned no results (no camera frame available or VLM failure)',
      };
    }

    return {
      success: true,
      message: `Location: ${analysis.locationLabel} — ${analysis.description}`,
      data: {
        label: analysis.locationLabel,
        features: analysis.features,
        navigationHints: analysis.navigationHints,
        confidence: analysis.confidence,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: `Scene analysis failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function handleStop(ctx: ToolContext): Promise<ToolResult> {
  logger.info('Tools', 'robot.stop invoked');

  // Abort any active navigation session or explore trace
  abortActiveSession(TraceOutcome.ABORTED, 'User-initiated stop');
  if (activeExploreTraceId) {
    traceLogger.endTrace(activeExploreTraceId, TraceOutcome.ABORTED, 'User-initiated stop');
    activeExploreTraceId = null;
  }

  try {
    // Stop the vision loop and topo map loop
    ctx.visionLoop.stop();
    topoMapLoop?.stop();

    // Send STOP bytecode
    const stopFrame = ctx.compiler.createFrame(Opcode.STOP);
    await ctx.transmitter.send(stopFrame);

    return {
      success: true,
      message: `Stopped. Sent ${formatHex(stopFrame)}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to stop: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function handleRecordObservation(label: string, ctx: ToolContext, confidence?: number): Promise<ToolResult> {
  if (!label) {
    return { success: false, message: 'No observation label specified' };
  }

  logger.info('Tools', `robot.record_observation: "${label}"`);

  try {
    // Get current pose from the ESP32-S3
    const statusFrame = ctx.compiler.createFrame(Opcode.GET_STATUS);
    const response = await ctx.transmitter.sendAndReceive(statusFrame, 2000);
    const status = JSON.parse(response.toString());

    const pose = {
      x: status.pose?.x ?? 0,
      y: status.pose?.y ?? 0,
      heading: (status.pose?.h ?? 0) * 180 / Math.PI,
    };

    poseMap.record(label, pose, confidence);

    return {
      success: true,
      message: `Recorded "${label}" at pose (${pose.x.toFixed(1)}, ${pose.y.toFixed(1)}), heading ${pose.heading.toFixed(0)}°`,
      data: { label, pose },
    };
  } catch (error) {
    // If we can't get the pose, record at origin
    logger.warn('Tools', 'Could not get pose for observation, recording at (0,0)');
    poseMap.record(label, { x: 0, y: 0, heading: 0 }, confidence);

    return {
      success: true,
      message: `Recorded "${label}" (pose unavailable, stored at origin)`,
      data: { label, pose: { x: 0, y: 0, heading: 0 } },
    };
  }
}

async function handleGetMap(ctx: ToolContext): Promise<ToolResult> {
  logger.info('Tools', 'robot.get_map invoked');

  const poseSummary = poseMap.getSummary();
  const entries = poseMap.getAll();

  // Include topological graph if available
  let topoSummary = '';
  let topoData: Record<string, unknown> = {};
  if (topoMap && topoMap.getAllNodes().length > 0) {
    topoSummary = '\n\nTopological graph:\n' + topoMap.getMapSummary();
    const json = topoMap.toJSON();
    topoData = {
      topoNodes: json.nodes,
      topoEdges: json.edges,
      topoStats: topoMap.getStats(),
    };
  }

  return {
    success: true,
    message: poseSummary + topoSummary,
    data: { entryCount: entries.length, entries, ...topoData },
  };
}

async function handleStatus(ctx: ToolContext): Promise<ToolResult> {
  logger.info('Tools', 'robot.status invoked');

  try {
    // Send GET_STATUS bytecode and wait for response
    const statusFrame = ctx.compiler.createFrame(Opcode.GET_STATUS);
    const response = await ctx.transmitter.sendAndReceive(statusFrame, 2000);

    // Parse JSON response from firmware
    const statusJson = response.toString();
    const status = JSON.parse(statusJson);

    return {
      success: true,
      message: `Robot status: position (${status.pose?.x?.toFixed(1)}, ${status.pose?.y?.toFixed(1)}), heading ${((status.pose?.h || 0) * 180 / Math.PI).toFixed(0)} deg, ${status.run ? 'moving' : 'idle'}`,
      data: status,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get status: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
