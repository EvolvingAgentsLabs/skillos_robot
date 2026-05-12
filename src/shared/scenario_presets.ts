/**
 * Scenario presets — shared config used by both the bridge and the runner.
 *
 * Each preset defines a MuJoCo scene file, a default goal, and one or more
 * navigation targets that the bridge tracks for physics-based arrival detection.
 */

export interface ScenarioPreset {
  id: string;
  name: string;           // mjswan scene display name
  goal: string;           // Default --goal text
  target: string;         // Bridge target: "name:x:y:radius"
  targets?: string[];     // Multi-target (scavenger hunt)
  mjcfFile: string;       // Filename in sim/
}

export const SCENARIO_PRESETS: Record<string, ScenarioPreset> = {
  'nav-arena': {
    id: 'nav-arena',
    name: 'Navigation Arena',
    goal: 'navigate to the red cube',
    target: 'red_cube:-0.6:-0.5:0.25',
    mjcfFile: 'roclaw_robot.xml',
  },
  'multi-room': {
    id: 'multi-room',
    name: 'Multi-Room Doorway',
    goal: 'find and navigate through the doorway to reach the red cube in the other room',
    target: 'red_cube:-0.6:1.5:0.25',
    mjcfFile: 'roclaw_multiroom.xml',
  },
  'dense-obstacles': {
    id: 'dense-obstacles',
    name: 'Dense Obstacle Field',
    goal: 'navigate through the dense obstacle field to reach the red cube',
    target: 'red_cube:0.8:0.8:0.25',
    mjcfFile: 'roclaw_dense_obstacles.xml',
  },
  'corridor': {
    id: 'corridor',
    name: 'L-Shaped Corridor',
    goal: 'follow the L-shaped corridor to reach the red cube at the end',
    target: 'red_cube:1.5:0.5:0.25',
    mjcfFile: 'roclaw_corridor.xml',
  },
  'scavenger': {
    id: 'scavenger',
    name: 'Scavenger Hunt',
    goal: 'collect all three colored cubes: red, blue, then green',
    target: 'red_cube:-0.6:-0.5:0.25',
    targets: [
      'red_cube:-0.6:-0.5:0.25',
      'blue_cube:0.7:0.5:0.25',
      'green_cube:-0.5:0.8:0.25',
    ],
    mjcfFile: 'roclaw_scavenger.xml',
  },
  'care-assistant': {
    id: 'care-assistant',
    name: 'Care Assistant — Door Choice',
    goal: 'approach the nearest person, ask which door they want (blue or green), then navigate to that door',
    target: 'blue_door:-0.8:1.5:0.25',
    targets: [
      'person_1:-0.6:-0.5:0.25',
      'blue_door:-0.8:1.5:0.25',
      'green_door:0.8:1.5:0.25',
    ],
    mjcfFile: 'roclaw_care_assistant.xml',
  },
};
