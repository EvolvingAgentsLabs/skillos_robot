/**
 * Scenario Generator — Randomized dream scenario creation for distillation
 *
 * Generates DreamScenarios with randomized arenas, obstacles, targets,
 * and robot starting positions for the distillation flywheel.
 *
 * Difficulty tiers:
 *   - easy: straight corridor, 0-1 obstacles
 *   - medium: open arena + 2-4 obstacles
 *   - hard: multi-room with doorways + 3-6 obstacles
 */

import type { DreamScenario, DreamWorld, Room, Wall, WorldObject, Doorway, Vec2 } from './text_scene';

// =============================================================================
// Types
// =============================================================================

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface GeneratorConfig {
  /** Difficulty distribution weights [easy, medium, hard] */
  difficultyWeights?: [number, number, number];
}

// =============================================================================
// Seedable PRNG (xoshiro128**)
// =============================================================================

class SeededRandom {
  private s: Uint32Array;

  constructor(seed: number) {
    // SplitMix32 to initialize state from a single seed
    this.s = new Uint32Array(4);
    for (let i = 0; i < 4; i++) {
      seed += 0x9e3779b9;
      let t = seed;
      t = Math.imul(t ^ (t >>> 16), 0x85ebca6b);
      t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
      this.s[i] = (t ^ (t >>> 16)) >>> 0;
    }
  }

  /** Returns float in [0, 1) */
  next(): number {
    const s = this.s;
    const result = Math.imul(s[1] * 5, 0) >>> 0;
    // Simplified: use a basic LCG-like approach for reliability
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = (s[3] << 11) | (s[3] >>> 21);
    return (result >>> 0) / 0x100000000;
  }

  /** Integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Float in [min, max) */
  float(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  /** Pick random element from array */
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Shuffle array in place */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// =============================================================================
// Constants
// =============================================================================

const COLORS = ['red', 'blue', 'green', 'yellow', 'orange', 'purple', 'white', 'pink'];
const OBJECTS = ['cube', 'ball', 'box', 'cone', 'cylinder', 'marker', 'bottle', 'block'];
const OBJECT_DESCRIPTIONS: Record<string, string> = {
  cube: 'A small plastic cube (5cm sides) sitting on the floor',
  ball: 'A round ball resting on the floor',
  box: 'A small cardboard box (8cm sides) on the floor',
  cone: 'A small rubber traffic cone (10cm tall) on the floor',
  cylinder: 'A short plastic cylinder (6cm diameter) on the floor',
  marker: 'A colored marker cone on the floor',
  bottle: 'A small plastic bottle lying on the floor',
  block: 'A rectangular wooden block on the floor',
};
const OBSTACLE_ITEMS = [
  { label: 'Cardboard box', radius: 15, desc: 'A large brown cardboard box blocking part of the path' },
  { label: 'Plastic crate', radius: 12, desc: 'A blue plastic storage crate with a lid' },
  { label: 'Stack of books', radius: 10, desc: 'A tall stack of hardcover books piled on the floor' },
  { label: 'Trash bin', radius: 14, desc: 'A cylindrical metal trash bin' },
  { label: 'Backpack', radius: 11, desc: 'A stuffed backpack on the floor' },
  { label: 'Chair', radius: 18, desc: 'A folding chair placed in the way' },
  { label: 'Toolbox', radius: 13, desc: 'A heavy metal toolbox on the floor' },
  { label: 'Plant pot', radius: 10, desc: 'A ceramic plant pot with a small fern' },
];
const GOAL_TEMPLATES = [
  'Navigate to the {color} {object}',
  'Find the {color} {object}',
  'Reach the {color} {object}',
  'Go to the {color} {object}',
  'Move toward the {color} {object} and stop near it',
];
const FLOOR_TYPES = ['tiled', 'concrete', 'hardwood', 'carpet', 'linoleum'];

// =============================================================================
// ScenarioGenerator
// =============================================================================

export class ScenarioGenerator {
  private config: GeneratorConfig;

  constructor(config: GeneratorConfig = {}) {
    this.config = config;
  }

  /**
   * Generate a random DreamScenario.
   * @param seed — Deterministic seed for reproducibility. If omitted, uses Date.now().
   */
  generate(seed?: number): DreamScenario {
    const s = seed ?? Date.now();
    const rng = new SeededRandom(s);

    // Pick difficulty
    const weights = this.config.difficultyWeights ?? [0.3, 0.5, 0.2];
    const difficulty = this.pickDifficulty(rng, weights);

    switch (difficulty) {
      case 'easy':
        return this.generateEasy(rng, s);
      case 'medium':
        return this.generateMedium(rng, s);
      case 'hard':
        return this.generateHard(rng, s);
    }
  }

  // ---------------------------------------------------------------------------
  // Easy: Straight corridor
  // ---------------------------------------------------------------------------

  private generateEasy(rng: SeededRandom, seed: number): DreamScenario {
    const width = rng.int(30, 50); // corridor width
    const length = rng.int(150, 350); // corridor length
    const halfW = width / 2;

    const room: Room = {
      id: 'corridor',
      label: 'Corridor',
      bounds: { minX: -halfW, minY: 0, maxX: halfW, maxY: length },
      floor: rng.pick(FLOOR_TYPES),
      description: 'A narrow corridor with walls on both sides.',
    };

    const walls: Wall[] = [
      { from: { x: -halfW, y: 0 }, to: { x: -halfW, y: length }, label: 'left wall' },
      { from: { x: halfW, y: 0 }, to: { x: halfW, y: length }, label: 'right wall' },
      { from: { x: -halfW, y: 0 }, to: { x: halfW, y: 0 }, label: 'back wall' },
      { from: { x: -halfW, y: length }, to: { x: halfW, y: length }, label: 'far wall' },
    ];

    // Target at far end
    const color = rng.pick(COLORS);
    const objType = rng.pick(OBJECTS);
    const target: WorldObject = {
      id: 'target',
      label: `${color.charAt(0).toUpperCase() + color.slice(1)} ${objType.charAt(0).toUpperCase() + objType.slice(1)}`,
      position: { x: rng.float(-halfW + 10, halfW - 10), y: length - rng.int(15, 40) },
      radius: 5,
      description: `A bright ${color} ${OBJECT_DESCRIPTIONS[objType] || objType}`,
      color,
      isTarget: true,
    };

    // Maybe one obstacle
    const obstacles: WorldObject[] = [];
    if (rng.next() < 0.4) {
      const obs = rng.pick(OBSTACLE_ITEMS);
      const obsY = rng.float(length * 0.3, length * 0.6);
      const obsX = rng.float(-halfW + obs.radius + 5, halfW - obs.radius - 5);
      obstacles.push({
        id: 'obs_0',
        label: obs.label,
        position: { x: obsX, y: obsY },
        radius: obs.radius,
        description: obs.desc,
      });
    }

    const goal = rng.pick(GOAL_TEMPLATES).replace('{color}', color).replace('{object}', objType);
    const startY = rng.int(15, 30);

    return {
      id: `gen_easy_${seed}`,
      title: `[Easy] ${goal}`,
      description: `Corridor ${width}x${length}cm, ${obstacles.length} obstacles`,
      world: {
        rooms: [room],
        walls,
        doorways: [],
        objects: [target, ...obstacles],
      },
      startPose: { x: 0, y: startY, heading: rng.int(-10, 10) },
      goal,
      targetObjectId: 'target',
      maxFrames: Math.min(200, Math.ceil(length / 2) + 50),
      goalThresholdCm: 20,
    };
  }

  // ---------------------------------------------------------------------------
  // Medium: Open arena + obstacles
  // ---------------------------------------------------------------------------

  private generateMedium(rng: SeededRandom, seed: number): DreamScenario {
    const sizeX = rng.int(200, 400);
    const sizeY = rng.int(200, 400);

    const room: Room = {
      id: 'arena',
      label: 'Open Arena',
      bounds: { minX: 0, minY: 0, maxX: sizeX, maxY: sizeY },
      floor: rng.pick(FLOOR_TYPES),
      description: 'A large open area with scattered obstacles.',
    };

    const walls: Wall[] = [
      { from: { x: 0, y: 0 }, to: { x: sizeX, y: 0 }, label: 'south wall' },
      { from: { x: 0, y: 0 }, to: { x: 0, y: sizeY }, label: 'west wall' },
      { from: { x: sizeX, y: 0 }, to: { x: sizeX, y: sizeY }, label: 'east wall' },
      { from: { x: 0, y: sizeY }, to: { x: sizeX, y: sizeY }, label: 'north wall' },
    ];

    // Target
    const color = rng.pick(COLORS);
    const objType = rng.pick(OBJECTS);
    const targetPos = this.randomInteriorPos(rng, 30, sizeX - 30, 30, sizeY - 30);
    const target: WorldObject = {
      id: 'target',
      label: `${color.charAt(0).toUpperCase() + color.slice(1)} ${objType.charAt(0).toUpperCase() + objType.slice(1)}`,
      position: targetPos,
      radius: 5,
      description: `A bright ${color} ${OBJECT_DESCRIPTIONS[objType] || objType}`,
      color,
      isTarget: true,
    };

    // Robot start — ensure minimum distance from target
    let startPos: Vec2;
    do {
      startPos = this.randomInteriorPos(rng, 30, sizeX - 30, 20, 60);
    } while (this.dist(startPos, targetPos) < 80);

    // Obstacles — ensure minimum separation from each other, target, and start
    const numObs = rng.int(2, 4);
    const obstacles: WorldObject[] = [];
    const placed: Vec2[] = [targetPos, startPos];

    for (let i = 0; i < numObs && i < 20; i++) {
      const obs = rng.pick(OBSTACLE_ITEMS);
      let pos: Vec2 | null = null;

      for (let attempt = 0; attempt < 30; attempt++) {
        const candidate = this.randomInteriorPos(rng, obs.radius + 10, sizeX - obs.radius - 10, obs.radius + 10, sizeY - obs.radius - 10);
        const minSep = placed.every(p => this.dist(p, candidate) > obs.radius + 25);
        if (minSep) {
          pos = candidate;
          break;
        }
      }
      if (!pos) continue;

      placed.push(pos);
      obstacles.push({
        id: `obs_${i}`,
        label: obs.label,
        position: pos,
        radius: obs.radius,
        description: obs.desc,
      });
    }

    const goal = rng.pick(GOAL_TEMPLATES).replace('{color}', color).replace('{object}', objType);

    return {
      id: `gen_medium_${seed}`,
      title: `[Medium] ${goal}`,
      description: `Arena ${sizeX}x${sizeY}cm, ${obstacles.length} obstacles`,
      world: {
        rooms: [room],
        walls,
        doorways: [],
        objects: [target, ...obstacles],
      },
      startPose: { x: startPos.x, y: startPos.y, heading: rng.int(0, 359) },
      goal,
      targetObjectId: 'target',
      maxFrames: 200,
      goalThresholdCm: 25,
    };
  }

  // ---------------------------------------------------------------------------
  // Hard: Multi-room with doorway
  // ---------------------------------------------------------------------------

  private generateHard(rng: SeededRandom, seed: number): DreamScenario {
    const roomAWidth = rng.int(150, 250);
    const roomAHeight = rng.int(150, 250);
    const roomBWidth = rng.int(150, 250);
    const roomBHeight = rng.int(150, 250);
    const doorWidth = rng.int(35, 55);

    // Room A: south, Room B: north (connected at y = roomAHeight)
    const totalWidth = Math.max(roomAWidth, roomBWidth);

    const roomA: Room = {
      id: 'room-a',
      label: 'Room A',
      bounds: { minX: 0, minY: 0, maxX: roomAWidth, maxY: roomAHeight },
      floor: rng.pick(FLOOR_TYPES),
      description: rng.pick(['A spacious room.', 'A room with light walls.', 'A well-lit room.']),
    };

    const roomB: Room = {
      id: 'room-b',
      label: 'Room B',
      bounds: { minX: 0, minY: roomAHeight, maxX: roomBWidth, maxY: roomAHeight + roomBHeight },
      floor: rng.pick(FLOOR_TYPES),
      description: rng.pick(['A smaller room.', 'A side room with dim lighting.', 'A second room.']),
    };

    // Door position along the dividing wall
    const doorCenterX = rng.float(doorWidth / 2 + 10, Math.min(roomAWidth, roomBWidth) - doorWidth / 2 - 10);
    const doorLeft = doorCenterX - doorWidth / 2;
    const doorRight = doorCenterX + doorWidth / 2;

    const walls: Wall[] = [
      // Room A outer walls
      { from: { x: 0, y: 0 }, to: { x: roomAWidth, y: 0 }, label: 'south wall' },
      { from: { x: 0, y: 0 }, to: { x: 0, y: roomAHeight + roomBHeight }, label: 'west wall' },
      { from: { x: roomAWidth, y: 0 }, to: { x: roomAWidth, y: roomAHeight }, label: 'east wall (Room A)' },
      // Dividing wall with gap
      { from: { x: 0, y: roomAHeight }, to: { x: doorLeft, y: roomAHeight }, label: 'dividing wall (left)' },
      { from: { x: doorRight, y: roomAHeight }, to: { x: Math.max(roomAWidth, roomBWidth), y: roomAHeight }, label: 'dividing wall (right)' },
      // Room B outer walls
      { from: { x: roomBWidth, y: roomAHeight }, to: { x: roomBWidth, y: roomAHeight + roomBHeight }, label: 'east wall (Room B)' },
      { from: { x: 0, y: roomAHeight + roomBHeight }, to: { x: roomBWidth, y: roomAHeight + roomBHeight }, label: 'north wall' },
    ];

    const doorways: Doorway[] = [
      {
        position: { x: doorCenterX, y: roomAHeight },
        width: doorWidth,
        facing: 0,
        label: 'doorway',
        leadsTo: 'Room B',
      },
    ];

    // Target in Room B
    const color = rng.pick(COLORS);
    const objType = rng.pick(OBJECTS);
    const target: WorldObject = {
      id: 'target',
      label: `${color.charAt(0).toUpperCase() + color.slice(1)} ${objType.charAt(0).toUpperCase() + objType.slice(1)}`,
      position: {
        x: rng.float(20, roomBWidth - 20),
        y: rng.float(roomAHeight + 30, roomAHeight + roomBHeight - 20),
      },
      radius: 5,
      description: `A bright ${color} ${OBJECT_DESCRIPTIONS[objType] || objType}`,
      color,
      isTarget: true,
    };

    // Robot starts in Room A
    const startPos: Vec2 = {
      x: rng.float(30, roomAWidth - 30),
      y: rng.float(20, roomAHeight * 0.4),
    };

    // Obstacles in both rooms
    const numObs = rng.int(3, 6);
    const obstacles: WorldObject[] = [];
    const placed: Vec2[] = [target.position, startPos, { x: doorCenterX, y: roomAHeight }];

    for (let i = 0; i < numObs; i++) {
      const obs = rng.pick(OBSTACLE_ITEMS);
      let pos: Vec2 | null = null;

      for (let attempt = 0; attempt < 30; attempt++) {
        // Place in either room
        const inRoomB = rng.next() < 0.4;
        let candidate: Vec2;
        if (inRoomB) {
          candidate = {
            x: rng.float(obs.radius + 10, roomBWidth - obs.radius - 10),
            y: rng.float(roomAHeight + obs.radius + 10, roomAHeight + roomBHeight - obs.radius - 10),
          };
        } else {
          candidate = {
            x: rng.float(obs.radius + 10, roomAWidth - obs.radius - 10),
            y: rng.float(obs.radius + 10, roomAHeight - obs.radius - 10),
          };
        }

        const minSep = placed.every(p => this.dist(p, candidate) > obs.radius + 25);
        if (minSep) {
          pos = candidate;
          break;
        }
      }
      if (!pos) continue;

      placed.push(pos);
      obstacles.push({
        id: `obs_${i}`,
        label: obs.label,
        position: pos,
        radius: obs.radius,
        description: obs.desc,
      });
    }

    const goal = rng.pick(GOAL_TEMPLATES).replace('{color}', color).replace('{object}', objType);

    return {
      id: `gen_hard_${seed}`,
      title: `[Hard] ${goal}`,
      description: `Two rooms (${roomAWidth}x${roomAHeight} + ${roomBWidth}x${roomBHeight}), doorway ${doorWidth}cm, ${obstacles.length} obstacles`,
      world: {
        rooms: [roomA, roomB],
        walls,
        doorways,
        objects: [target, ...obstacles],
      },
      startPose: { x: startPos.x, y: startPos.y, heading: rng.int(0, 359) },
      goal,
      targetObjectId: 'target',
      maxFrames: 250,
      goalThresholdCm: 25,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private pickDifficulty(rng: SeededRandom, weights: [number, number, number]): Difficulty {
    const total = weights[0] + weights[1] + weights[2];
    const r = rng.next() * total;
    if (r < weights[0]) return 'easy';
    if (r < weights[0] + weights[1]) return 'medium';
    return 'hard';
  }

  private randomInteriorPos(rng: SeededRandom, minX: number, maxX: number, minY: number, maxY: number): Vec2 {
    return { x: rng.float(minX, maxX), y: rng.float(minY, maxY) };
  }

  private dist(a: Vec2, b: Vec2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}
