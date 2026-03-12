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

export interface ClearanceResult {
  distanceCm: number;
  blockedBy: string | null;
}

export class TextSceneSimulator {
  private world: DreamWorld;
  private state: DreamRobotState;
  private kin: StepperKinematics;
  private frameCount: number = 0;
  private targetId: string | null;
  private goalThresholdCm: number;
  private previousTargetDistance: number | null = null;

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
    this.previousTargetDistance = this.getTargetDistance();
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
  // Ray-Cast Clearance
  // ---------------------------------------------------------------------------

  /**
   * Cast a ray from robot position at the given bearing (degrees, 0=north CW)
   * at 2cm resolution. Returns distance to first obstacle and what blocked it.
   */
  rayCastClearance(bearingDeg: number, maxDist: number = 300): ClearanceResult {
    const rad = bearingDeg * Math.PI / 180;
    const stepSize = 2; // cm resolution
    const sinB = Math.sin(rad);
    const cosB = Math.cos(rad);

    for (let d = stepSize; d <= maxDist; d += stepSize) {
      const px = this.state.x + d * sinB;
      const py = this.state.y + d * cosB;

      // Check walls
      for (const wall of this.world.walls) {
        const dist = this.pointToSegmentDistance({ x: px, y: py }, wall.from, wall.to);
        if (dist < ROBOT_RADIUS_CM) {
          return { distanceCm: Math.round(d), blockedBy: wall.label || 'wall' };
        }
      }

      // Check non-target objects
      for (const obj of this.world.objects) {
        if (obj.id === this.targetId) continue;
        const dx = obj.position.x - px;
        const dy = obj.position.y - py;
        const objDist = Math.sqrt(dx * dx + dy * dy);
        if (objDist < ROBOT_RADIUS_CM + obj.radius) {
          return { distanceCm: Math.round(d), blockedBy: obj.label };
        }
      }
    }

    return { distanceCm: maxDist, blockedBy: null };
  }

  /**
   * Get clearance in 6 directions relative to current heading.
   */
  private getSixDirectionClearance(): Record<string, ClearanceResult> {
    const h = this.state.heading;
    return {
      forward: this.rayCastClearance(h),
      'forward-left': this.rayCastClearance(this.normalizeDeg(h - 30)),
      left: this.rayCastClearance(this.normalizeDeg(h - 90)),
      'forward-right': this.rayCastClearance(this.normalizeDeg(h + 30)),
      right: this.rayCastClearance(this.normalizeDeg(h + 90)),
      backward: this.rayCastClearance(this.normalizeDeg(h + 180)),
    };
  }

  // ---------------------------------------------------------------------------
  // Scene Description Engine — Two-Pass Output
  // ---------------------------------------------------------------------------

  private describeScene(
    currentRoom: Room | null,
    collision: boolean,
    targetDist: number | null,
  ): string {
    const parts: string[] = [];
    const clearance = this.getSixDirectionClearance();

    // =========== PASS 1: SPATIAL ANALYSIS (DECISION DATA — read first) ===========
    parts.push('=== SPATIAL ANALYSIS ===');

    // Pose
    parts.push(
      `POSE: x=${this.state.x.toFixed(1)} y=${this.state.y.toFixed(1)} heading=${this.state.heading.toFixed(1)}deg`
    );

    // Progress tracking
    if (this.targetId && targetDist !== null) {
      const target = this.world.objects.find(o => o.id === this.targetId);
      if (target) {
        const bearing = this.getBearing(target.position);
        const relAngle = this.normalizeDeg(bearing - this.state.heading + 180) - 180;

        let progressStatus: string;
        if (this.previousTargetDistance !== null) {
          const delta = targetDist - this.previousTargetDistance;
          if (delta < -0.5) {
            progressStatus = `approaching delta=${delta.toFixed(1)}cm`;
          } else if (delta > 0.5) {
            progressStatus = `receding delta=+${delta.toFixed(1)}cm`;
          } else {
            progressStatus = `stuck delta=${delta.toFixed(1)}cm`;
          }
        } else {
          progressStatus = 'initial';
        }
        parts.push(
          `PROGRESS: ${progressStatus} | target=${Math.round(targetDist)}cm at ${Math.round(relAngle)}deg relative | frame ${this.frameCount}`
        );

        // Update previous distance for next frame
        this.previousTargetDistance = targetDist;
      }
    }

    // Clearance
    parts.push('CLEARANCE:');
    for (const [dir, cl] of Object.entries(clearance)) {
      const status = cl.blockedBy ? `BLOCKED by ${cl.blockedBy}` : 'clear';
      parts.push(`  ${dir}: ${cl.distanceCm}cm ${status}`);
    }

    // Navigation options
    parts.push('OPTIONS:');
    const fwd = clearance.forward;
    const fwdLabel = fwd.blockedBy ? `BLOCKED by ${fwd.blockedBy} at ${fwd.distanceCm}cm` : `clear for ${fwd.distanceCm}cm`;
    let fwdNote = '';
    if (this.targetId) {
      const target = this.world.objects.find(o => o.id === this.targetId);
      if (target) {
        const bearing = this.getBearing(target.position);
        const relAngle = Math.abs(this.normalizeDeg(bearing - this.state.heading + 180) - 180);
        if (relAngle < 15) fwdNote = ' [TARGET is FORWARD]';
      }
    }
    parts.push(`  - FORWARD: ${fwdLabel}${fwdNote}`);

    const left = clearance.left;
    parts.push(`  - LEFT: ${left.blockedBy ? `BLOCKED by ${left.blockedBy} at ${left.distanceCm}cm` : `clear for ${left.distanceCm}cm`}`);

    const right = clearance.right;
    parts.push(`  - RIGHT: ${right.blockedBy ? `BLOCKED by ${right.blockedBy} at ${right.distanceCm}cm` : `clear for ${right.distanceCm}cm`}`);

    // Target recommendation
    if (this.targetId && targetDist !== null) {
      const target = this.world.objects.find(o => o.id === this.targetId);
      if (target) {
        const bearing = this.getBearing(target.position);
        const relAngle = this.normalizeDeg(bearing - this.state.heading + 180) - 180;
        const absAngle = Math.abs(relAngle);

        let recommendation: string;
        if (targetDist < this.goalThresholdCm) {
          recommendation = 'stop() — target reached';
        } else if (absAngle < 10 && !fwd.blockedBy) {
          recommendation = 'move_forward recommended';
        } else if (relAngle > 10) {
          recommendation = 'turn_right or rotate_cw recommended';
        } else if (relAngle < -10) {
          recommendation = 'turn_left or rotate_ccw recommended';
        } else {
          recommendation = 'move_forward recommended';
        }
        parts.push(`  - TARGET: ${relAngle >= 0 ? 'right' : 'left'} ${absAngle}deg, ${Math.round(targetDist)}cm away -> ${recommendation}`);
      }
    }

    // =========== PASS 2: SCENE PERCEPTION ===========
    parts.push('');
    parts.push('=== SCENE PERCEPTION ===');

    // Location context
    if (currentRoom) {
      let locLine = `Location: ${currentRoom.label}.`;
      if (currentRoom.description) locLine += ` ${currentRoom.description}`;
      if (currentRoom.floor) locLine += ` Floor: ${currentRoom.floor}.`;
      parts.push(locLine);
    }

    // Contextual collision — differentiate frontal vs lateral
    if (collision) {
      const fwdClear = clearance.forward.distanceCm;
      if (fwdClear < 15) {
        parts.push('COLLISION WARNING: Obstacle or wall directly ahead. Do NOT move forward.');
      } else {
        parts.push('WALL NEARBY: Close to a wall on the side. Forward path is clear.');
      }
    }

    // Visible walls (compact)
    const wallDescs = this.describeVisibleWalls();
    if (wallDescs.length > 0) {
      parts.push('Walls: ' + wallDescs.join(' '));
    }

    // Visible objects
    const objectDescs = this.describeVisibleObjects();
    if (objectDescs.length > 0) {
      for (const od of objectDescs) parts.push('Object: ' + od);
    }

    // Visible doorways
    const doorwayDescs = this.describeVisibleDoorways();
    if (doorwayDescs.length > 0) {
      for (const dd of doorwayDescs) parts.push(dd);
    }

    // Target status
    if (this.targetId) {
      const target = this.world.objects.find(o => o.id === this.targetId);
      if (target && targetDist !== null) {
        const bearing = this.getBearing(target.position);
        const relAngle = this.normalizeDeg(bearing - this.state.heading + 180) - 180;
        const relativeDir = this.relativeDirection(bearing);

        if (this.isInFOV(bearing)) {
          parts.push(
            `TARGET VISIBLE: ${target.label} is ${Math.round(targetDist)}cm ${relativeDir} ` +
            `(bearing ${relAngle >= 0 ? '+' : ''}${Math.round(relAngle)}deg relative).`
          );
          if (targetDist < this.goalThresholdCm * 2) {
            parts.push(`Target is very close! Approaching arrival.`);
          }
        } else {
          parts.push(
            `Target "${target.label}" is not visible in the current field of view. ` +
            `It should be ${relativeDir} from your current heading (${relAngle >= 0 ? '+' : ''}${Math.round(relAngle)}deg relative).`
          );
        }
      }
    }

    return parts.join('\n');
  }

  private describeVisibleWalls(): string[] {
    const descriptions: string[] = [];

    for (const wall of this.world.walls) {
      // Use closest point on wall segment to robot, not midpoint
      const closestDist = this.pointToSegmentDistance(
        { x: this.state.x, y: this.state.y },
        wall.from, wall.to,
      );
      if (closestDist > 300) continue;

      const midpoint: Vec2 = {
        x: (wall.from.x + wall.to.x) / 2,
        y: (wall.from.y + wall.to.y) / 2,
      };
      const bearing = this.getBearing(midpoint);
      if (!this.isInFOV(bearing, 90)) continue;

      const relDir = this.relativeDirection(bearing);
      const label = wall.label || 'wall';
      descriptions.push(`${label} ${Math.round(closestDist)}cm ${relDir}.`);
    }

    return descriptions.slice(0, 3);
  }

  private describeVisibleObjects(): string[] {
    const descriptions: string[] = [];

    for (const obj of this.world.objects) {
      if (obj.id === this.targetId) continue;
      const dist = this.distanceTo(obj.position);
      if (dist > 300) continue;

      const bearing = this.getBearing(obj.position);
      if (!this.isInFOV(bearing)) continue;

      const relDir = this.relativeDirection(bearing);
      descriptions.push(
        `${obj.label}${obj.color ? ` (${obj.color})` : ''} — ${obj.description}, ` +
        `${Math.round(dist)}cm ${relDir}.`
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
        { id: 'red-cube', label: 'Red Cube', position: { x: 0, y: 280 }, radius: 5, description: 'A bright red plastic cube (5cm sides) sitting on the tiled floor', color: 'red', isTarget: true },
      ],
    },
    startPose: { x: 0, y: 20, heading: 0 },
    goal: 'Navigate to the red cube at the end of the corridor',
    targetObjectId: 'red-cube',
    maxFrames: 150,
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
        { id: 'table', label: 'Wooden table', position: { x: 100, y: 100 }, radius: 30, description: 'A large oak dining table with four chairs', color: 'brown' },
        { id: 'blue-box', label: 'Blue Box', position: { x: 300, y: 100 }, radius: 5, description: 'A small blue cardboard box (8cm sides) on the carpeted floor', color: 'blue', isTarget: true },
      ],
    },
    startPose: { x: 30, y: 30, heading: 0 },
    goal: 'Explore the room and find the blue box',
    targetObjectId: 'blue-box',
    maxFrames: 200,
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
        { from: { x: 0, y: 0 }, to: { x: 250, y: 0 }, label: 'south wall' },
        { from: { x: 0, y: 0 }, to: { x: 0, y: 250 }, label: 'west wall' },
        { from: { x: 250, y: 0 }, to: { x: 250, y: 250 }, label: 'east wall' },
        { from: { x: 0, y: 250 }, to: { x: 250, y: 250 }, label: 'north wall' },
      ],
      doorways: [],
      objects: [
        { id: 'box1', label: 'Cardboard box', position: { x: 125, y: 80 }, radius: 20, description: 'A large brown cardboard shipping box (40cm wide) blocking part of the path', color: 'brown' },
        { id: 'box2', label: 'Plastic crate', position: { x: 80, y: 150 }, radius: 15, description: 'A blue plastic storage crate (30cm wide) with a lid', color: 'blue' },
        { id: 'box3', label: 'Stack of books', position: { x: 170, y: 140 }, radius: 12, description: 'A tall stack of hardcover books (24cm wide) piled on the floor' },
        { id: 'green-ball', label: 'Green Ball', position: { x: 125, y: 220 }, radius: 5, description: 'A bright green tennis ball on the concrete floor', color: 'green', isTarget: true },
      ],
    },
    startPose: { x: 125, y: 20, heading: 0 },
    goal: 'Navigate around the obstacles to reach the green ball',
    targetObjectId: 'green-ball',
    maxFrames: 200,
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
        { id: 'marker', label: 'Yellow Marker', position: { x: 180, y: 220 }, radius: 5, description: 'A small yellow rubber traffic cone (10cm tall) on the tiled floor', color: 'yellow', isTarget: true },
      ],
    },
    startPose: { x: 20, y: 20, heading: 0 },
    goal: 'Follow the corridor walls to reach the yellow marker at the end',
    targetObjectId: 'marker',
    maxFrames: 200,
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
        { from: { x: 0, y: 0 }, to: { x: 150, y: 0 }, label: 'south wall' },
        { from: { x: 0, y: 0 }, to: { x: 0, y: 300 }, label: 'west wall' },
        { from: { x: 150, y: 0 }, to: { x: 150, y: 300 }, label: 'east wall' },
        { from: { x: 0, y: 300 }, to: { x: 150, y: 300 }, label: 'north wall' },
        // Dividing wall with doorway gap
        { from: { x: 0, y: 150 }, to: { x: 55, y: 150 }, label: 'dividing wall (left)' },
        { from: { x: 95, y: 150 }, to: { x: 150, y: 150 }, label: 'dividing wall (right)' },
      ],
      doorways: [
        { position: { x: 75, y: 150 }, width: 40, facing: 0, label: 'kitchen doorway', leadsTo: 'Kitchen (Room B)' },
      ],
      objects: [
        { id: 'couch', label: 'Couch', position: { x: 30, y: 70 }, radius: 25, description: 'A large grey fabric couch against the west wall' },
        { id: 'orange', label: 'Orange', position: { x: 75, y: 250 }, radius: 4, description: 'A round orange fruit sitting on the white tile kitchen floor', color: 'orange', isTarget: true },
      ],
    },
    startPose: { x: 100, y: 50, heading: 0 },
    goal: 'Go through the doorway into the kitchen and find the orange',
    targetObjectId: 'orange',
    maxFrames: 200,
    goalThresholdCm: 25,
  },
];
