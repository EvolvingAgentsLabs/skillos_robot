/**
 * Text Scene Simulator — Text-only environment for dream simulation
 *
 * Generates text descriptions of what the robot's camera would "see" based on
 * a virtual world state and robot pose. No 3D engine or physics needed —
 * the scene is described entirely in text, frame by frame.
 *
 * Each "frame" is a text description like:
 *   "You see a long corridor ahead. The left wall is about 30cm away.
 *    A doorway is visible on the right side, approximately 2m ahead.
 *    The floor is tiled. No obstacles detected in the immediate path."
 *
 * The robot's kinematics are simulated using the same StepperKinematics
 * and applyCommand() logic from virtual_roclaw.ts.
 */

import { StepperKinematics } from '../../shared/stepper-kinematics';
import { Opcode, type BytecodeFrame, decodeFrame } from '../../2_qwen_cerebellum/bytecode_compiler';

// =============================================================================
// World Types
// =============================================================================

export interface Vec2 {
  x: number;
  y: number;
}

export interface WorldObject {
  id: string;
  label: string;
  position: Vec2;
  /** Bounding radius in cm */
  radius: number;
  /** Visual description */
  description: string;
  /** Color for visual identification */
  color?: string;
  /** Whether this object is the goal target */
  isTarget?: boolean;
}

export interface Wall {
  /** Start point in cm */
  from: Vec2;
  /** End point in cm */
  to: Vec2;
  label?: string;
}

export interface Doorway {
  position: Vec2;
  /** Width in cm */
  width: number;
  /** Heading direction of doorway opening in degrees */
  facing: number;
  label?: string;
  /** Connects to which room */
  leadsTo?: string;
}

export interface Room {
  id: string;
  label: string;
  /** Room bounds: axis-aligned bounding box */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Floor description */
  floor?: string;
  /** General atmosphere */
  description?: string;
}

export interface DreamWorld {
  rooms: Room[];
  walls: Wall[];
  doorways: Doorway[];
  objects: WorldObject[];
  /** World description for context */
  description?: string;
}

// =============================================================================
// Robot State (same model as virtual_roclaw.ts)
// =============================================================================

export interface DreamRobotState {
  x: number;
  y: number;
  heading: number; // degrees, 0 = north
  motorRunning: boolean;
  leftSpeed: number;
  rightSpeed: number;
}

// =============================================================================
// Scene Frame (text representation of one camera frame)
// =============================================================================

export interface TextFrame {
  /** Frame number in the dream sequence */
  frameIndex: number;
  /** Text description of what the camera sees */
  sceneText: string;
  /** Robot pose at this frame */
  pose: { x: number; y: number; heading: number };
  /** Current room ID */
  roomId: string | null;
  /** Distance to target if one exists */
  targetDistance: number | null;
  /** Whether goal is reached */
  goalReached: boolean;
  /** Collision detected */
  collision: boolean;
}

// =============================================================================
// Prebuilt Scenarios
// =============================================================================

export interface DreamScenario {
  id: string;
  title: string;
  description: string;
  world: DreamWorld;
  /** Robot starting pose */
  startPose: { x: number; y: number; heading: number };
  /** Goal description for the VLM */
  goal: string;
  /** Target object ID (if navigating to an object) */
  targetObjectId?: string;
  /** Max frames before timeout */
  maxFrames: number;
  /** Distance threshold to consider goal reached (cm) */
  goalThresholdCm: number;
}

// =============================================================================
// Text Scene Simulator
// =============================================================================

const PULSE_DURATION_S = 0.5;
const ROBOT_RADIUS_CM = 10; // Robot collision radius
const FOV_DEGREES = 65; // Camera field of view

export class TextSceneSimulator {
  private world: DreamWorld;
  private state: DreamRobotState;
  private kin: StepperKinematics;
  private frameCount: number = 0;
  private targetId: string | null;
  private goalThresholdCm: number;

  constructor(scenario: DreamScenario) {
    this.world = scenario.world;
    this.state = {
      x: scenario.startPose.x,
      y: scenario.startPose.y,
      heading: scenario.startPose.heading,
      motorRunning: false,
      leftSpeed: 0,
      rightSpeed: 0,
    };
    this.kin = new StepperKinematics();
    this.targetId = scenario.targetObjectId ?? null;
    this.goalThresholdCm = scenario.goalThresholdCm;
  }

  /** Get current robot state */
  getState(): Readonly<DreamRobotState> {
    return { ...this.state };
  }

  /** Get current frame count */
  getFrameCount(): number {
    return this.frameCount;
  }

  /**
   * Apply a bytecode command and advance the simulation by one step.
   * Returns a TextFrame describing the new scene.
   */
  step(bytecodeBuffer: Buffer): TextFrame {
    const frame = decodeFrame(bytecodeBuffer);
    if (frame) {
      this.applyCommand(frame);
    }

    this.frameCount++;
    return this.renderFrame();
  }

  /**
   * Render the current scene as a TextFrame without applying a command.
   * Useful for getting the initial frame.
   */
  renderFrame(): TextFrame {
    const currentRoom = this.getCurrentRoom();
    const collision = this.checkCollision();
    const targetDist = this.getTargetDistance();
    const goalReached = targetDist !== null && targetDist <= this.goalThresholdCm;

    const sceneText = this.describeScene(currentRoom, collision, targetDist);

    return {
      frameIndex: this.frameCount,
      sceneText,
      pose: {
        x: Math.round(this.state.x * 10) / 10,
        y: Math.round(this.state.y * 10) / 10,
        heading: Math.round(this.state.heading * 10) / 10,
      },
      roomId: currentRoom?.id ?? null,
      targetDistance: targetDist !== null ? Math.round(targetDist * 10) / 10 : null,
      goalReached,
      collision,
    };
  }

  // ---------------------------------------------------------------------------
  // Kinematics (mirrors virtual_roclaw.ts logic)
  // ---------------------------------------------------------------------------

  private applyCommand(frame: BytecodeFrame): void {
    const wheelBase = this.kin.getSpec().wheelBaseCm;

    switch (frame.opcode) {
      case Opcode.MOVE_FORWARD: {
        const l = this.speedToCm(frame.paramLeft);
        const r = this.speedToCm(frame.paramRight);
        this.applyDrive(l, r, wheelBase);
        this.state.leftSpeed = frame.paramLeft;
        this.state.rightSpeed = frame.paramRight;
        this.state.motorRunning = true;
        break;
      }
      case Opcode.MOVE_BACKWARD: {
        const l = this.speedToCm(frame.paramLeft);
        const r = this.speedToCm(frame.paramRight);
        this.applyDrive(-l, -r, wheelBase);
        this.state.leftSpeed = frame.paramLeft;
        this.state.rightSpeed = frame.paramRight;
        this.state.motorRunning = true;
        break;
      }
      case Opcode.TURN_LEFT:
      case Opcode.TURN_RIGHT: {
        const l = this.speedToCm(frame.paramLeft);
        const r = this.speedToCm(frame.paramRight);
        this.applyDrive(l, r, wheelBase);
        this.state.leftSpeed = frame.paramLeft;
        this.state.rightSpeed = frame.paramRight;
        this.state.motorRunning = true;
        break;
      }
      case Opcode.ROTATE_CW: {
        this.state.heading = this.normalizeDeg(this.state.heading + frame.paramLeft);
        this.state.motorRunning = true;
        break;
      }
      case Opcode.ROTATE_CCW: {
        this.state.heading = this.normalizeDeg(this.state.heading - frame.paramLeft);
        this.state.motorRunning = true;
        break;
      }
      case Opcode.STOP: {
        this.state.motorRunning = false;
        this.state.leftSpeed = 0;
        this.state.rightSpeed = 0;
        break;
      }
    }
  }

  private speedToCm(speed: number): number {
    const fraction = speed / 255;
    const stepsPerPulse = fraction * this.kin.getSpec().maxStepsPerSecond * PULSE_DURATION_S;
    return this.kin.stepsToDistance(stepsPerPulse);
  }

  private applyDrive(leftCm: number, rightCm: number, wheelBase: number): void {
    const headingRad = this.state.heading * Math.PI / 180;
    const avgCm = (leftCm + rightCm) / 2;
    const dTheta = (rightCm - leftCm) / wheelBase;

    this.state.x += avgCm * Math.sin(headingRad);
    this.state.y += avgCm * Math.cos(headingRad);
    this.state.heading = this.normalizeDeg(this.state.heading + dTheta * 180 / Math.PI);
  }

  private normalizeDeg(deg: number): number {
    return ((deg % 360) + 360) % 360;
  }

  // ---------------------------------------------------------------------------
  // Scene Description Engine
  // ---------------------------------------------------------------------------

  private describeScene(
    currentRoom: Room | null,
    collision: boolean,
    targetDist: number | null,
  ): string {
    const parts: string[] = [];

    // Location context
    if (currentRoom) {
      parts.push(`Location: ${currentRoom.label}.`);
      if (currentRoom.description) parts.push(currentRoom.description);
      if (currentRoom.floor) parts.push(`Floor: ${currentRoom.floor}.`);
    }

    // Collision warning
    if (collision) {
      parts.push('WARNING: Very close to a wall or obstacle. Risk of collision.');
    }

    // Visible walls and distance estimates
    const wallDescs = this.describeVisibleWalls();
    if (wallDescs.length > 0) parts.push(...wallDescs);

    // Visible objects
    const objectDescs = this.describeVisibleObjects();
    if (objectDescs.length > 0) parts.push(...objectDescs);

    // Visible doorways
    const doorwayDescs = this.describeVisibleDoorways();
    if (doorwayDescs.length > 0) parts.push(...doorwayDescs);

    // Target status
    if (this.targetId) {
      const target = this.world.objects.find(o => o.id === this.targetId);
      if (target && targetDist !== null) {
        const bearing = this.getBearing(target.position);
        const relativeDir = this.relativeDirection(bearing);

        if (this.isInFOV(bearing)) {
          parts.push(
            `TARGET VISIBLE: ${target.label} (${target.description}) is ${relativeDir}, ` +
            `approximately ${Math.round(targetDist)}cm away.`
          );
          if (targetDist < this.goalThresholdCm * 2) {
            parts.push(`Target is very close! Approaching arrival.`);
          }
        } else {
          parts.push(
            `Target "${target.label}" is not visible in the current field of view. ` +
            `It should be ${relativeDir} from your current heading.`
          );
        }
      }
    }

    // Path assessment
    const pathClear = this.isPathClear();
    if (pathClear) {
      parts.push('The path ahead appears clear for forward movement.');
    } else {
      parts.push('The path ahead is blocked. Consider turning or rotating to find a clear path.');
    }

    return parts.join('\n');
  }

  private describeVisibleWalls(): string[] {
    const descriptions: string[] = [];
    const headingRad = this.state.heading * Math.PI / 180;

    for (const wall of this.world.walls) {
      const midpoint: Vec2 = {
        x: (wall.from.x + wall.to.x) / 2,
        y: (wall.from.y + wall.to.y) / 2,
      };
      const dist = this.distanceTo(midpoint);
      if (dist > 300) continue; // Only describe nearby walls

      const bearing = this.getBearing(midpoint);
      if (!this.isInFOV(bearing, 90)) continue; // Wider FOV for wall awareness

      const relDir = this.relativeDirection(bearing);
      const label = wall.label || 'wall';
      descriptions.push(`A ${label} is visible ${relDir}, approximately ${Math.round(dist)}cm away.`);
    }

    return descriptions.slice(0, 3); // Limit to 3 wall descriptions
  }

  private describeVisibleObjects(): string[] {
    const descriptions: string[] = [];

    for (const obj of this.world.objects) {
      if (obj.id === this.targetId) continue; // Target described separately
      const dist = this.distanceTo(obj.position);
      if (dist > 300) continue;

      const bearing = this.getBearing(obj.position);
      if (!this.isInFOV(bearing)) continue;

      const relDir = this.relativeDirection(bearing);
      descriptions.push(
        `${obj.label}${obj.color ? ` (${obj.color})` : ''}: ${obj.description}, ` +
        `${relDir}, ~${Math.round(dist)}cm away.`
      );
    }

    return descriptions.slice(0, 4);
  }

  private describeVisibleDoorways(): string[] {
    const descriptions: string[] = [];

    for (const door of this.world.doorways) {
      const dist = this.distanceTo(door.position);
      if (dist > 400) continue;

      const bearing = this.getBearing(door.position);
      if (!this.isInFOV(bearing, 90)) continue;

      const relDir = this.relativeDirection(bearing);
      const label = door.label || 'doorway';
      const leadsTo = door.leadsTo ? ` (leads to ${door.leadsTo})` : '';
      descriptions.push(
        `A ${label}${leadsTo} is visible ${relDir}, approximately ${Math.round(dist)}cm away, ` +
        `${door.width}cm wide.`
      );
    }

    return descriptions.slice(0, 3);
  }

  // ---------------------------------------------------------------------------
  // Spatial helpers
  // ---------------------------------------------------------------------------

  private distanceTo(pos: Vec2): number {
    const dx = pos.x - this.state.x;
    const dy = pos.y - this.state.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Returns bearing to position in degrees (0 = north, clockwise) */
  private getBearing(pos: Vec2): number {
    const dx = pos.x - this.state.x;
    const dy = pos.y - this.state.y;
    const bearing = Math.atan2(dx, dy) * 180 / Math.PI;
    return this.normalizeDeg(bearing);
  }

  /** Check if a bearing is within the camera FOV */
  private isInFOV(bearing: number, fovOverride?: number): boolean {
    const fov = fovOverride ?? FOV_DEGREES;
    const relAngle = this.normalizeDeg(bearing - this.state.heading + 180) - 180;
    return Math.abs(relAngle) <= fov / 2;
  }

  /** Describe relative direction from current heading */
  private relativeDirection(bearing: number): string {
    const relAngle = this.normalizeDeg(bearing - this.state.heading + 180) - 180;
    if (Math.abs(relAngle) < 10) return 'directly ahead';
    if (relAngle >= 10 && relAngle < 45) return 'slightly to the right';
    if (relAngle >= 45 && relAngle < 90) return 'to the right';
    if (relAngle >= 90 && relAngle < 135) return 'far to the right';
    if (relAngle >= 135) return 'behind and to the right';
    if (relAngle <= -10 && relAngle > -45) return 'slightly to the left';
    if (relAngle <= -45 && relAngle > -90) return 'to the left';
    if (relAngle <= -90 && relAngle > -135) return 'far to the left';
    return 'behind and to the left';
  }

  private getCurrentRoom(): Room | null {
    for (const room of this.world.rooms) {
      if (
        this.state.x >= room.bounds.minX && this.state.x <= room.bounds.maxX &&
        this.state.y >= room.bounds.minY && this.state.y <= room.bounds.maxY
      ) {
        return room;
      }
    }
    return null;
  }

  private checkCollision(): boolean {
    // Check wall proximity
    for (const wall of this.world.walls) {
      const dist = this.pointToSegmentDistance(
        { x: this.state.x, y: this.state.y },
        wall.from, wall.to,
      );
      if (dist < ROBOT_RADIUS_CM) return true;
    }

    // Check object proximity
    for (const obj of this.world.objects) {
      const dist = this.distanceTo(obj.position);
      if (dist < ROBOT_RADIUS_CM + obj.radius) return true;
    }

    return false;
  }

  private isPathClear(): boolean {
    // Cast a ray forward and check for obstacles within 50cm
    const headingRad = this.state.heading * Math.PI / 180;
    const checkDist = 50;
    const ahead: Vec2 = {
      x: this.state.x + checkDist * Math.sin(headingRad),
      y: this.state.y + checkDist * Math.cos(headingRad),
    };

    // Check walls
    for (const wall of this.world.walls) {
      const dist = this.pointToSegmentDistance(ahead, wall.from, wall.to);
      if (dist < ROBOT_RADIUS_CM * 2) return false;
    }

    // Check objects
    for (const obj of this.world.objects) {
      const dx = obj.position.x - ahead.x;
      const dy = obj.position.y - ahead.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < ROBOT_RADIUS_CM + obj.radius) return false;
    }

    return true;
  }

  private getTargetDistance(): number | null {
    if (!this.targetId) return null;
    const target = this.world.objects.find(o => o.id === this.targetId);
    if (!target) return null;
    return this.distanceTo(target.position);
  }

  /** Distance from point P to line segment AB */
  private pointToSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
      // Segment is a point
      return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
    }

    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const closestX = a.x + t * dx;
    const closestY = a.y + t * dy;

    return Math.sqrt((p.x - closestX) ** 2 + (p.y - closestY) ** 2);
  }
}

// =============================================================================
// Prebuilt Scenarios
// =============================================================================

export const SCENARIOS: DreamScenario[] = [
  {
    id: 'corridor-target',
    title: 'Corridor Target Seek',
    description: 'Navigate a straight corridor to find a red cube at the far end',
    world: {
      rooms: [
        { id: 'corridor', label: 'Long corridor', bounds: { minX: -30, minY: 0, maxX: 30, maxY: 300 }, floor: 'tiled', description: 'A narrow corridor with white walls.' },
      ],
      walls: [
        { from: { x: -30, y: 0 }, to: { x: -30, y: 300 }, label: 'left wall' },
        { from: { x: 30, y: 0 }, to: { x: 30, y: 300 }, label: 'right wall' },
        { from: { x: -30, y: 0 }, to: { x: 30, y: 0 }, label: 'back wall' },
        { from: { x: -30, y: 300 }, to: { x: 30, y: 300 }, label: 'far wall' },
      ],
      doorways: [],
      objects: [
        { id: 'red-cube', label: 'Red Cube', position: { x: 0, y: 280 }, radius: 5, description: 'A bright red cube on the floor', color: 'red', isTarget: true },
      ],
    },
    startPose: { x: 0, y: 20, heading: 0 },
    goal: 'Navigate to the red cube at the end of the corridor',
    targetObjectId: 'red-cube',
    maxFrames: 40,
    goalThresholdCm: 20,
  },
  {
    id: 'room-exploration',
    title: 'Room Exploration',
    description: 'Explore a room, finding a doorway on the right side',
    world: {
      rooms: [
        { id: 'main-room', label: 'Main room', bounds: { minX: 0, minY: 0, maxX: 200, maxY: 200 }, floor: 'hardwood', description: 'A spacious room with wooden furniture.' },
        { id: 'side-room', label: 'Side room', bounds: { minX: 200, minY: 70, maxX: 350, maxY: 130 }, floor: 'carpet', description: 'A smaller carpeted room.' },
      ],
      walls: [
        { from: { x: 0, y: 0 }, to: { x: 200, y: 0 }, label: 'south wall' },
        { from: { x: 0, y: 0 }, to: { x: 0, y: 200 }, label: 'west wall' },
        { from: { x: 0, y: 200 }, to: { x: 200, y: 200 }, label: 'north wall' },
        { from: { x: 200, y: 0 }, to: { x: 200, y: 70 }, label: 'east wall (south section)' },
        { from: { x: 200, y: 130 }, to: { x: 200, y: 200 }, label: 'east wall (north section)' },
        // Side room walls
        { from: { x: 200, y: 70 }, to: { x: 350, y: 70 }, label: 'side room south wall' },
        { from: { x: 200, y: 130 }, to: { x: 350, y: 130 }, label: 'side room north wall' },
        { from: { x: 350, y: 70 }, to: { x: 350, y: 130 }, label: 'side room east wall' },
      ],
      doorways: [
        { position: { x: 200, y: 100 }, width: 60, facing: 90, label: 'doorway to side room', leadsTo: 'Side room' },
      ],
      objects: [
        { id: 'table', label: 'Wooden table', position: { x: 100, y: 100 }, radius: 30, description: 'A large wooden dining table' },
        { id: 'blue-box', label: 'Blue Box', position: { x: 300, y: 100 }, radius: 5, description: 'A small blue box on the floor', color: 'blue', isTarget: true },
      ],
    },
    startPose: { x: 30, y: 30, heading: 0 },
    goal: 'Explore the room and find the blue box',
    targetObjectId: 'blue-box',
    maxFrames: 60,
    goalThresholdCm: 25,
  },
  {
    id: 'obstacle-avoidance',
    title: 'Obstacle Avoidance Course',
    description: 'Navigate around obstacles to reach a target behind them',
    world: {
      rooms: [
        { id: 'arena', label: 'Open arena', bounds: { minX: 0, minY: 0, maxX: 250, maxY: 250 }, floor: 'concrete', description: 'A large open area with scattered obstacles.' },
      ],
      walls: [
        { from: { x: 0, y: 0 }, to: { x: 250, y: 0 } },
        { from: { x: 0, y: 0 }, to: { x: 0, y: 250 } },
        { from: { x: 250, y: 0 }, to: { x: 250, y: 250 } },
        { from: { x: 0, y: 250 }, to: { x: 250, y: 250 } },
      ],
      doorways: [],
      objects: [
        { id: 'box1', label: 'Cardboard box', position: { x: 125, y: 80 }, radius: 20, description: 'A large cardboard box blocking part of the path' },
        { id: 'box2', label: 'Plastic crate', position: { x: 80, y: 150 }, radius: 15, description: 'A blue plastic crate' },
        { id: 'box3', label: 'Stack of books', position: { x: 170, y: 140 }, radius: 12, description: 'A tall stack of books on the floor' },
        { id: 'green-ball', label: 'Green Ball', position: { x: 125, y: 220 }, radius: 5, description: 'A bright green ball', color: 'green', isTarget: true },
      ],
    },
    startPose: { x: 125, y: 20, heading: 0 },
    goal: 'Navigate around the obstacles to reach the green ball',
    targetObjectId: 'green-ball',
    maxFrames: 50,
    goalThresholdCm: 20,
  },
  {
    id: 'wall-following',
    title: 'Wall Following',
    description: 'Follow the wall around an L-shaped corridor',
    world: {
      rooms: [
        { id: 'corridor-a', label: 'Corridor segment A', bounds: { minX: 0, minY: 0, maxX: 40, maxY: 200 }, floor: 'tiled' },
        { id: 'corridor-b', label: 'Corridor segment B', bounds: { minX: 0, minY: 200, maxX: 200, maxY: 240 }, floor: 'tiled' },
      ],
      walls: [
        // Segment A
        { from: { x: 0, y: 0 }, to: { x: 40, y: 0 }, label: 'start wall' },
        { from: { x: 0, y: 0 }, to: { x: 0, y: 240 }, label: 'left wall' },
        { from: { x: 40, y: 0 }, to: { x: 40, y: 200 }, label: 'right wall (segment A)' },
        // Corner + Segment B
        { from: { x: 40, y: 200 }, to: { x: 200, y: 200 }, label: 'inner corner wall' },
        { from: { x: 0, y: 240 }, to: { x: 200, y: 240 }, label: 'outer wall (segment B)' },
        { from: { x: 200, y: 200 }, to: { x: 200, y: 240 }, label: 'end wall' },
      ],
      doorways: [],
      objects: [
        { id: 'marker', label: 'Yellow Marker', position: { x: 180, y: 220 }, radius: 5, description: 'A small yellow marker cone', color: 'yellow', isTarget: true },
      ],
    },
    startPose: { x: 20, y: 20, heading: 0 },
    goal: 'Follow the corridor walls to reach the yellow marker at the end',
    targetObjectId: 'marker',
    maxFrames: 50,
    goalThresholdCm: 20,
  },
  {
    id: 'doorway-navigation',
    title: 'Doorway Navigation',
    description: 'Navigate through a doorway into another room to find a target',
    world: {
      rooms: [
        { id: 'room-a', label: 'Room A', bounds: { minX: 0, minY: 0, maxX: 150, maxY: 150 }, floor: 'carpet', description: 'A living room with a couch.' },
        { id: 'room-b', label: 'Room B', bounds: { minX: 0, minY: 150, maxX: 150, maxY: 300 }, floor: 'tile', description: 'A kitchen with counters along the walls.' },
      ],
      walls: [
        { from: { x: 0, y: 0 }, to: { x: 150, y: 0 } },
        { from: { x: 0, y: 0 }, to: { x: 0, y: 300 } },
        { from: { x: 150, y: 0 }, to: { x: 150, y: 300 } },
        { from: { x: 0, y: 300 }, to: { x: 150, y: 300 } },
        // Dividing wall with doorway gap
        { from: { x: 0, y: 150 }, to: { x: 55, y: 150 }, label: 'dividing wall (left)' },
        { from: { x: 95, y: 150 }, to: { x: 150, y: 150 }, label: 'dividing wall (right)' },
      ],
      doorways: [
        { position: { x: 75, y: 150 }, width: 40, facing: 0, label: 'kitchen doorway', leadsTo: 'Kitchen (Room B)' },
      ],
      objects: [
        { id: 'couch', label: 'Couch', position: { x: 30, y: 70 }, radius: 25, description: 'A large couch against the west wall' },
        { id: 'orange', label: 'Orange', position: { x: 75, y: 250 }, radius: 4, description: 'An orange on the kitchen counter', color: 'orange', isTarget: true },
      ],
    },
    startPose: { x: 100, y: 50, heading: 0 },
    goal: 'Go through the doorway into the kitchen and find the orange',
    targetObjectId: 'orange',
    maxFrames: 50,
    goalThresholdCm: 25,
  },
];
