// src/cartridge/state.ts
// Shared subsystem references the cartridge methods read from. The CLI
// (or a host process embedding the adapter) populates this before
// starting the adapter; methods consult it per-call.
//
// Intentionally a global mutable — there is exactly one robot per host
// process. If you find yourself wanting two transmitters or two scene
// graphs, that's a deeper architectural change, not a state.ts change.

import type { UDPTransmitter } from '../bridge/udp_transmitter';
import type { SceneGraph } from '../brain/memory/scene_graph';
import type { ReactiveController } from '../control/reactive_controller';
import type { HierarchicalPlanner } from '../brain/planning/planner';
import type { VisionLoop } from '../brain/perception/vision_loop';
import type { IOAdapter } from '../orchestrator/io';

export interface RobotState {
  /** UDP transmitter to the ESP32. Unset → cartridge methods that need
   *  motor control return HARDWARE_UNAVAILABLE. */
  transmitter?: UDPTransmitter;
  /** Shared SceneGraph instance. The semantic loop writes; the cartridge
   *  observe method reads. Must be the SAME instance the running
   *  perception loop is updating, otherwise observe returns stale data. */
  sceneGraph?: SceneGraph;
  /** Shared ReactiveController. set_speed mutates its tier; the running
   *  reactive loop (if any) reads its config each tick. Must be the same
   *  instance the loop uses. */
  reactiveController?: ReactiveController;
  /** Most recent VLM textual scene description, refreshed by the semantic
   *  loop. The cartridge describe method reads this; if unset, describe
   *  returns BACKEND_UNAVAILABLE. */
  lastDescription?: { text: string; timestamp: number };
  /** Hierarchical planner for navigate. The cartridge calls planGoal()
   *  and, if visionLoop is registered, starts physical execution. */
  planner?: HierarchicalPlanner;
  /** Live VisionLoop instance. When registered, navigate starts physical
   *  execution (dual-loop perception + motor control) after planning.
   *  Must be the SAME instance with enableDualLoop() already called. */
  visionLoop?: VisionLoop;
  /** I/O adapter for speak/listen methods. Set by the orchestrator or
   *  by the CLI when speech is enabled. */
  ioAdapter?: IOAdapter;
}

let state: RobotState = {};

export function getRobotState(): Readonly<RobotState> {
  return state;
}

export function setRobotState(next: Partial<RobotState>): void {
  state = { ...state, ...next };
}

export function clearRobotState(): void {
  state = {};
}
