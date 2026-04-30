/**
 * Dream Simulator — Text-based dream simulation for RoClaw
 *
 * Barrel export for the dream simulation subsystem:
 *
 * - TextSceneSimulator: Text-only environment engine (no 3D needed)
 * - DreamInferenceRouter: Gemini Robotics inference for dream scenarios
 * - DreamScenarioRunner: Runs scenarios, produces traces for DreamEngine
 * - SCENARIOS: Prebuilt dream scenarios
 */

export { TextSceneSimulator, SCENARIOS } from './text_scene';
export type {
  DreamWorld,
  DreamRobotState,
  DreamScenario,
  TextFrame,
  Room,
  Wall,
  Doorway,
  WorldObject,
  Vec2,
} from './text_scene';

export { DreamInferenceRouter } from './dream_inference_router';
export type {
  DreamInferenceMode,
  DreamInferenceRouterConfig,
  InferenceStats,
} from './dream_inference_router';

export { DreamScenarioRunner, generateDreamReport } from './scenario_runner';
export type {
  ScenarioResult,
  FrameLogEntry,
  RunnerConfig,
} from './scenario_runner';
