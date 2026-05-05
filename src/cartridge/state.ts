// src/cartridge/state.ts
// Shared subsystem references the cartridge methods read from. The CLI
// (or a host process embedding the adapter) populates this before
// starting the adapter; methods consult it per-call.
//
// Intentionally a global mutable — there is exactly one robot per host
// process. If you find yourself wanting two transmitters or two scene
// graphs, that's a deeper architectural change, not a state.ts change.

import type { UDPTransmitter } from '../bridge/udp_transmitter';

export interface RobotState {
  /** UDP transmitter to the ESP32. Unset → cartridge methods that need
   *  motor control return HARDWARE_UNAVAILABLE. */
  transmitter?: UDPTransmitter;
  // Future fields land here as PRs B/C/D/E wire each method:
  //   sceneGraph?: SceneGraph;
  //   reactiveController?: ReactiveController;
  //   semanticLoop?: SemanticLoop;
  //   planner?: Planner;
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
