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
import type { InferenceFunction } from '../2_qwen_cerebellum/inference';
import { MemoryManager } from '../3_llmunix_memory/memory_manager';
import { PoseMap, SemanticMap } from '../3_llmunix_memory/semantic_map';
import { SemanticMapLoop } from '../3_llmunix_memory/semantic_map_loop';

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
}

// Module-level singletons — avoids changing ToolContext interface
const memoryManager = new MemoryManager();
const poseMap = new PoseMap();

// Lazy-initialized — requires InferenceFunction which isn't available at module load
let topoMap: SemanticMap | null = null;
let topoMapLoop: SemanticMapLoop | null = null;

function ensureTopoMap(ctx: ToolContext): SemanticMap {
  if (!topoMap) {
    topoMap = new SemanticMap(ctx.infer);
  }
  return topoMap;
}

function ensureTopoMapLoop(ctx: ToolContext): SemanticMapLoop {
  if (!topoMapLoop) {
    const sm = ensureTopoMap(ctx);
    topoMapLoop = new SemanticMapLoop(
      sm,
      ctx.visionLoop,
      ctx.infer,
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

/** Exposed for testing — reset lazy singletons */
export function _resetTopoMap(): void {
  topoMapLoop?.stop();
  topoMapLoop = null;
  topoMap = null;
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
// Individual handlers
// ---------------------------------------------------------------------------

async function handleReadMemory(): Promise<ToolResult> {
  logger.info('Tools', 'robot.read_memory invoked');

  const content = memoryManager.getFullContext();
  return {
    success: true,
    message: content || 'No memory files found.',
    data: { type: 'memory' },
  };
}

async function handleExplore(ctx: ToolContext, constraints?: string): Promise<ToolResult> {
  logger.info('Tools', 'robot.explore invoked', constraints ? { constraints } : undefined);

  const baseGoal = 'Explore the environment. Move forward when the path is clear. Turn to avoid obstacles. Look for interesting objects.';
  const goal = constraints ? `${baseGoal}\nConstraints: ${constraints}` : baseGoal;

  try {
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

  // Try VLM-powered topological navigation first
  let topoNavHint = '';
  try {
    const sm = ensureTopoMap(ctx);
    if (sm.getAllNodes().length > 0) {
      const frameBase64 = ctx.visionLoop.getLatestFrameBase64();
      if (frameBase64) {
        const sceneDesc = await ctx.infer(
          'You are a robot with a camera. Briefly describe what you see.',
          'Describe the current scene.',
          [frameBase64],
        );
        const decision = await sm.planNavigation(sceneDesc, location);
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

  // Fall back to PoseMap for coordinate-based hint
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

  const goal = constraints ? `${baseGoal}\nConstraints: ${constraints}` : baseGoal;

  try {
    await ctx.visionLoop.start(goal);

    // Start topological mapping alongside navigation
    try {
      ensureTopoMapLoop(ctx).start();
    } catch (err) {
      logger.warn('Tools', 'Failed to start topo map loop', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      success: true,
      message: `Navigation started toward "${location}".${navHint}${topoNavHint}`,
    };
  } catch (error) {
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
