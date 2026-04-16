import { resolveGoalFromText, ResolvedGoal } from '../../src/1_openclaw_cortex/goal_resolver';
import { SceneGraph } from '../../src/3_llmunix_memory/scene_graph';

function makeGraph(...nodes: { id: string; label: string; x: number; y: number }[]): SceneGraph {
  const g = new SceneGraph();
  for (const n of nodes) {
    g.addOrUpdateNode(n);
  }
  return g;
}

describe('resolveGoalFromText', () => {
  // -------------------------------------------------------------------------
  // 1. Coordinate pattern
  // -------------------------------------------------------------------------
  it('parses "go to (50, 120)" as a point goal', () => {
    const result = resolveGoalFromText('go to (50, 120)', new SceneGraph());
    expect(result).toEqual({ kind: 'point', x: 50, y: 120 });
  });

  // -------------------------------------------------------------------------
  // 2. Exact label match
  // -------------------------------------------------------------------------
  it('matches an exact node label after stripping navigation prefix', () => {
    const g = makeGraph({ id: 'n1', label: 'red cube', x: 100, y: 200 });
    const result = resolveGoalFromText('navigate to the red cube', g);
    expect(result).toEqual({ kind: 'node', id: 'n1' });
  });

  // -------------------------------------------------------------------------
  // 3. Goal contains label
  // -------------------------------------------------------------------------
  it('matches when the full goal text contains the node label', () => {
    const g = makeGraph({ id: 'n1', label: 'red cube', x: 10, y: 20 });
    const result = resolveGoalFromText('find the red cube near the wall', g);
    expect(result).toEqual({ kind: 'node', id: 'n1' });
  });

  // -------------------------------------------------------------------------
  // 4. Label contains stripped goal words
  // -------------------------------------------------------------------------
  it('matches when the label contains the stripped goal text', () => {
    const g = makeGraph({ id: 'n1', label: 'red cube', x: 10, y: 20 });
    const result = resolveGoalFromText('go to cube', g);
    expect(result).toEqual({ kind: 'node', id: 'n1' });
  });

  // -------------------------------------------------------------------------
  // 5. Word overlap scoring
  // -------------------------------------------------------------------------
  it('uses word overlap to partially match "large red box" against "red cube"', () => {
    const g = makeGraph({ id: 'n1', label: 'red cube', x: 10, y: 20 });
    // "large red box" shares the word "red" with "red cube"
    const result = resolveGoalFromText('go to large red box', g);
    expect(result).toEqual({ kind: 'node', id: 'n1' });
  });

  // -------------------------------------------------------------------------
  // 6. Empty graph (no obstacles)
  // -------------------------------------------------------------------------
  it('returns explore when the graph has no obstacle nodes', () => {
    const result = resolveGoalFromText('navigate to the red cube', new SceneGraph());
    expect(result).toEqual({ kind: 'explore' });
  });

  // -------------------------------------------------------------------------
  // 7. No matching labels
  // -------------------------------------------------------------------------
  it('returns explore when no label matches the goal text', () => {
    const g = makeGraph({ id: 'n1', label: 'blue sphere', x: 10, y: 20 });
    const result = resolveGoalFromText('go to the green pyramid', g);
    expect(result).toEqual({ kind: 'explore' });
  });

  // -------------------------------------------------------------------------
  // 8. Empty / null goal text
  // -------------------------------------------------------------------------
  it('returns explore for empty goal text', () => {
    const g = makeGraph({ id: 'n1', label: 'red cube', x: 10, y: 20 });
    expect(resolveGoalFromText('', g)).toEqual({ kind: 'explore' });
  });

  it('returns explore for null/undefined goal text', () => {
    const g = makeGraph({ id: 'n1', label: 'red cube', x: 10, y: 20 });
    // Cast to any to test the runtime guard
    expect(resolveGoalFromText(null as any, g)).toEqual({ kind: 'explore' });
    expect(resolveGoalFromText(undefined as any, g)).toEqual({ kind: 'explore' });
  });

  // -------------------------------------------------------------------------
  // 9. Multiple nodes, best match wins
  // -------------------------------------------------------------------------
  it('selects the node with the longest matching label when multiple nodes match', () => {
    const g = makeGraph(
      { id: 'short', label: 'cube', x: 10, y: 10 },
      { id: 'long', label: 'red cube', x: 20, y: 20 },
    );
    // Goal contains both "cube" (len 4) and "red cube" (len 8) — longer wins
    const result = resolveGoalFromText('find the red cube', g);
    expect(result).toEqual({ kind: 'node', id: 'long' });
  });

  // -------------------------------------------------------------------------
  // 10. Coordinate pattern without navigation prefix does not match
  // -------------------------------------------------------------------------
  it('does not parse bare coordinates without a navigation verb', () => {
    const g = new SceneGraph();
    // "(50, 120)" alone lacks a navigation prefix like "go to"
    const result = resolveGoalFromText('(50, 120)', g);
    expect(result).toEqual({ kind: 'explore' });
  });
});
