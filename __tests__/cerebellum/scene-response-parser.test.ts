import { parseGeminiSceneResponse } from '../../src/2_qwen_cerebellum/scene_response_parser';

describe('parseGeminiSceneResponse — valid inputs', () => {
  test('valid JSON with multiple objects returns all', () => {
    const input = JSON.stringify({
      objects: [
        { label: 'roclaw', box_2d: [400, 400, 600, 600] },
        { label: 'red cube', box_2d: [100, 200, 300, 400] },
        { label: 'blue sphere', box_2d: [50, 50, 150, 150] },
      ],
    });
    const result = parseGeminiSceneResponse(input);
    expect(result).toHaveLength(3);
    expect(result[0].label).toBe('roclaw');
    expect(result[1].label).toBe('red cube');
    expect(result[2].label).toBe('blue sphere');
    expect(result[0].box_2d).toEqual([400, 400, 600, 600]);
    expect(result[1].box_2d).toEqual([100, 200, 300, 400]);
  });

  test('valid JSON with heading_estimate is parsed correctly', () => {
    const input = JSON.stringify({
      objects: [
        { label: 'roclaw', box_2d: [400, 400, 600, 600], heading_estimate: 'RIGHT' },
        { label: 'cube', box_2d: [100, 100, 200, 200], heading_estimate: 'UP' },
      ],
    });
    const result = parseGeminiSceneResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0].heading_estimate).toBe('RIGHT');
    expect(result[1].heading_estimate).toBe('UP');
  });

  test('JSON wrapped in markdown fences is parsed', () => {
    const input = [
      '```json',
      JSON.stringify({
        objects: [
          { label: 'wall', box_2d: [0, 0, 100, 1000] },
        ],
      }),
      '```',
    ].join('\n');
    const result = parseGeminiSceneResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('wall');
    expect(result[0].box_2d).toEqual([0, 0, 100, 1000]);
  });

  test('JSON embedded in surrounding text is extracted', () => {
    const input = [
      'Here is the scene analysis:',
      '',
      '{"objects": [{"label": "red cube", "box_2d": [100, 200, 300, 400]}]}',
      '',
      'I detected one object in the scene.',
    ].join('\n');
    const result = parseGeminiSceneResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('red cube');
  });

  test('empty objects array returns []', () => {
    const input = JSON.stringify({ objects: [] });
    const result = parseGeminiSceneResponse(input);
    expect(result).toEqual([]);
  });
});

describe('parseGeminiSceneResponse — invalid object fields', () => {
  test('object missing label is skipped', () => {
    const input = JSON.stringify({
      objects: [
        { box_2d: [100, 200, 300, 400] },
        { label: 'cube', box_2d: [0, 0, 100, 100] },
      ],
    });
    const result = parseGeminiSceneResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('cube');
  });

  test('object missing box_2d is skipped', () => {
    const input = JSON.stringify({
      objects: [
        { label: 'orphan' },
        { label: 'cube', box_2d: [10, 20, 30, 40] },
      ],
    });
    const result = parseGeminiSceneResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('cube');
  });

  test('invalid box_2d with wrong length is skipped', () => {
    const input = JSON.stringify({
      objects: [
        { label: 'too-short', box_2d: [100, 200, 300] },
        { label: 'too-long', box_2d: [100, 200, 300, 400, 500] },
        { label: 'valid', box_2d: [10, 20, 30, 40] },
      ],
    });
    const result = parseGeminiSceneResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('valid');
  });

  test('non-numeric box_2d values are skipped', () => {
    // String values are valid JSON but Number("a") → NaN, which is not finite.
    // null coerces to 0 via Number(), so it passes — only truly non-numeric
    // strings trigger the guard.
    const input = JSON.stringify({
      objects: [
        { label: 'string-box', box_2d: ['a', 'b', 'c', 'd'] },
        { label: 'valid', box_2d: [10, 20, 30, 40] },
      ],
    });
    const result = parseGeminiSceneResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('valid');
  });
});

describe('parseGeminiSceneResponse — degenerate inputs', () => {
  test('completely invalid JSON returns []', () => {
    const result = parseGeminiSceneResponse('this is not json at all {}[]');
    expect(result).toEqual([]);
  });

  test('empty string returns []', () => {
    const result = parseGeminiSceneResponse('');
    expect(result).toEqual([]);
  });

  test('null/undefined input returns []', () => {
    // The function guards with `typeof text !== 'string'`, so these
    // return [] without throwing.
    expect(parseGeminiSceneResponse(null as unknown as string)).toEqual([]);
    expect(parseGeminiSceneResponse(undefined as unknown as string)).toEqual([]);
  });
});
