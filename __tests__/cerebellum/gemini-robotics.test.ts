import {
  GeminiRoboticsInference,
  ROCLAW_TOOL_DECLARATIONS,
  createGeminiInference,
  type GeminiInferenceConfig,
} from '../../src/2_qwen_cerebellum/gemini_robotics';

// =============================================================================
// Mock fetch
// =============================================================================

const originalFetch = global.fetch;

function mockFetchResponse(body: unknown, status = 200) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

function geminiTextResponse(text: string, promptTokens = 10, candidatesTokens = 5) {
  return {
    candidates: [{
      content: {
        parts: [{ text }],
      },
    }],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: candidatesTokens,
    },
  };
}

function geminiFunctionCallResponse(name: string, args: Record<string, unknown>) {
  return {
    candidates: [{
      content: {
        parts: [{
          functionCall: { name, args },
        }],
      },
    }],
    usageMetadata: {
      promptTokenCount: 15,
      candidatesTokenCount: 3,
    },
  };
}

afterEach(() => {
  global.fetch = originalFetch;
});

// =============================================================================
// Config defaults
// =============================================================================

describe('GeminiRoboticsInference', () => {
  describe('config defaults', () => {
    test('applies default config values', () => {
      const adapter = new GeminiRoboticsInference({ apiKey: 'test-key' });
      const stats = adapter.getStats();
      expect(stats.totalCalls).toBe(0);
    });

    test('overrides defaults with provided config', () => {
      const adapter = new GeminiRoboticsInference({
        apiKey: 'test-key',
        model: 'gemini-1.5-pro',
        maxOutputTokens: 128,
        temperature: 0.5,
      });
      // Adapter creates — no error means config was accepted
      expect(adapter).toBeDefined();
    });
  });

  // ===========================================================================
  // Basic text inference
  // ===========================================================================

  describe('text inference', () => {
    test('returns text response from Gemini API', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('AA 01 80 80 01 FF'));

      const adapter = new GeminiRoboticsInference({ apiKey: 'test-key' });
      const result = await adapter.infer('System prompt', 'User message');

      expect(result).toBe('AA 01 80 80 01 FF');
    });

    test('sends system prompt as systemInstruction', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok'));

      const adapter = new GeminiRoboticsInference({ apiKey: 'test-key' });
      await adapter.infer('You are a robot', 'Move forward');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.systemInstruction.parts[0].text).toBe('You are a robot');
    });

    test('sends user message as text part', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok'));

      const adapter = new GeminiRoboticsInference({ apiKey: 'test-key' });
      await adapter.infer('System', 'Move forward');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      const parts = body.contents[0].parts;
      expect(parts[parts.length - 1].text).toBe('Move forward');
    });
  });

  // ===========================================================================
  // Image encoding
  // ===========================================================================

  describe('image encoding', () => {
    test('sends images as inlineData parts', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok'));

      const adapter = new GeminiRoboticsInference({ apiKey: 'test-key' });
      await adapter.infer('System', 'Describe', ['base64imagedata']);

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      const parts = body.contents[0].parts;

      // First part should be the image
      expect(parts[0].inlineData).toBeDefined();
      expect(parts[0].inlineData.mimeType).toBe('image/jpeg');
      expect(parts[0].inlineData.data).toBe('base64imagedata');
    });

    test('strips data URI prefix from images', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok'));

      const adapter = new GeminiRoboticsInference({ apiKey: 'test-key' });
      await adapter.infer('System', 'Describe', ['data:image/jpeg;base64,abc123']);

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      const parts = body.contents[0].parts;

      expect(parts[0].inlineData.data).toBe('abc123');
    });

    test('text part comes after image parts', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok'));

      const adapter = new GeminiRoboticsInference({ apiKey: 'test-key' });
      await adapter.infer('System', 'Describe scene', ['img1', 'img2']);

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      const parts = body.contents[0].parts;

      expect(parts.length).toBe(3); // 2 images + 1 text
      expect(parts[0].inlineData).toBeDefined();
      expect(parts[1].inlineData).toBeDefined();
      expect(parts[2].text).toBe('Describe scene');
    });
  });

  // ===========================================================================
  // Thinking budget
  // ===========================================================================

  describe('thinking budget', () => {
    test('thinkingBudget=0 does not include thinkingConfig', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok'));

      const adapter = new GeminiRoboticsInference({
        apiKey: 'test-key',
        thinkingBudget: 0,
      });
      await adapter.infer('System', 'Fast');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.generationConfig.thinkingConfig).toBeUndefined();
    });

    test('thinkingBudget>0 includes thinkingConfig', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok'));

      const adapter = new GeminiRoboticsInference({
        apiKey: 'test-key',
        thinkingBudget: 1024,
      });
      await adapter.infer('System', 'Deep analysis');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 1024,
      });
    });
  });

  // ===========================================================================
  // Tool calling
  // ===========================================================================

  describe('tool calling', () => {
    test('includes tool declarations when useToolCalling=true', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok'));

      const adapter = new GeminiRoboticsInference({
        apiKey: 'test-key',
        useToolCalling: true,
        tools: ROCLAW_TOOL_DECLARATIONS,
      });
      await adapter.infer('System', 'Navigate');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.tools).toBeDefined();
      expect(body.tools[0].functionDeclarations.length).toBe(7);
    });

    test('does not include tools when useToolCalling=false', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok'));

      const adapter = new GeminiRoboticsInference({
        apiKey: 'test-key',
        useToolCalling: false,
      });
      await adapter.infer('System', 'Navigate');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.tools).toBeUndefined();
    });

    test('returns TOOLCALL: prefix for function call responses', async () => {
      global.fetch = mockFetchResponse(
        geminiFunctionCallResponse('move_forward', { speed_l: 150, speed_r: 150 }),
      );

      const adapter = new GeminiRoboticsInference({
        apiKey: 'test-key',
        useToolCalling: true,
        tools: ROCLAW_TOOL_DECLARATIONS,
      });
      const result = await adapter.infer('System', 'Move forward');

      expect(result.startsWith('TOOLCALL:')).toBe(true);
      const parsed = JSON.parse(result.slice('TOOLCALL:'.length));
      expect(parsed.name).toBe('move_forward');
      expect(parsed.args.speed_l).toBe(150);
      expect(parsed.args.speed_r).toBe(150);
    });

    test('returns text when model chooses not to use tools', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('I see a wall ahead'));

      const adapter = new GeminiRoboticsInference({
        apiKey: 'test-key',
        useToolCalling: true,
        tools: ROCLAW_TOOL_DECLARATIONS,
      });
      const result = await adapter.infer('System', 'Describe');

      expect(result).toBe('I see a wall ahead');
    });

    test('all 7 RoClaw tool declarations are defined', () => {
      expect(ROCLAW_TOOL_DECLARATIONS.length).toBe(7);
      const names = ROCLAW_TOOL_DECLARATIONS.map(t => t.name);
      expect(names).toContain('move_forward');
      expect(names).toContain('move_backward');
      expect(names).toContain('turn_left');
      expect(names).toContain('turn_right');
      expect(names).toContain('rotate_cw');
      expect(names).toContain('rotate_ccw');
      expect(names).toContain('stop');
    });
  });

  // ===========================================================================
  // Retry logic
  // ===========================================================================

  describe('retry logic', () => {
    test('retries on failure and succeeds on second attempt', async () => {
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { ok: false, status: 500, text: async () => 'Server error', json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => geminiTextResponse('recovered'),
        };
      });

      const adapter = new GeminiRoboticsInference({
        apiKey: 'test-key',
        maxRetries: 1,
      });
      const result = await adapter.infer('System', 'Test');

      expect(result).toBe('recovered');
      expect(callCount).toBe(2);
    });

    test('throws after all retries exhausted', async () => {
      global.fetch = mockFetchResponse({ error: 'fail' }, 500);

      const adapter = new GeminiRoboticsInference({
        apiKey: 'test-key',
        maxRetries: 1,
      });

      await expect(adapter.infer('System', 'Test')).rejects.toThrow('Gemini API error 500');
    });
  });

  // ===========================================================================
  // Stats tracking
  // ===========================================================================

  describe('stats tracking', () => {
    test('tracks successful calls', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok', 10, 5));

      const adapter = new GeminiRoboticsInference({ apiKey: 'test-key' });
      await adapter.infer('System', 'Test');

      const stats = adapter.getStats();
      expect(stats.totalCalls).toBe(1);
      expect(stats.successfulCalls).toBe(1);
      expect(stats.failedCalls).toBe(0);
      expect(stats.promptTokens).toBe(10);
      expect(stats.completionTokens).toBe(5);
      expect(stats.totalTokens).toBe(15);
      expect(stats.averageLatencyMs).toBeGreaterThan(0);
    });

    test('tracks failed calls', async () => {
      global.fetch = mockFetchResponse({ error: 'fail' }, 500);

      const adapter = new GeminiRoboticsInference({
        apiKey: 'test-key',
        maxRetries: 0,
      });

      try { await adapter.infer('System', 'Test'); } catch { /* expected */ }

      const stats = adapter.getStats();
      expect(stats.totalCalls).toBe(1);
      expect(stats.failedCalls).toBe(1);
      expect(stats.successfulCalls).toBe(0);
    });

    test('resetStats clears all counters', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok'));

      const adapter = new GeminiRoboticsInference({ apiKey: 'test-key' });
      await adapter.infer('System', 'Test');

      adapter.resetStats();
      const stats = adapter.getStats();
      expect(stats.totalCalls).toBe(0);
      expect(stats.successfulCalls).toBe(0);
    });
  });

  // ===========================================================================
  // Factory function
  // ===========================================================================

  describe('createGeminiInference', () => {
    test('returns a valid InferenceFunction', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('hello'));

      const infer = createGeminiInference({ apiKey: 'test-key' });
      expect(typeof infer).toBe('function');

      const result = await infer('System', 'Test');
      expect(result).toBe('hello');
    });

    test('accepts optional images parameter', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('scene'));

      const infer = createGeminiInference({ apiKey: 'test-key' });
      const result = await infer('System', 'Describe', ['base64img']);
      expect(result).toBe('scene');
    });
  });

  // ===========================================================================
  // API URL construction
  // ===========================================================================

  describe('API URL', () => {
    test('constructs correct URL with model and API key', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok'));

      const adapter = new GeminiRoboticsInference({
        apiKey: 'my-api-key',
        model: 'gemini-2.0-flash',
      });
      await adapter.infer('System', 'Test');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const url = call[0] as string;
      expect(url).toContain('/models/gemini-2.0-flash:generateContent');
      expect(url).toContain('key=my-api-key');
    });

    test('uses custom apiBaseUrl', async () => {
      global.fetch = mockFetchResponse(geminiTextResponse('ok'));

      const adapter = new GeminiRoboticsInference({
        apiKey: 'key',
        apiBaseUrl: 'https://custom.api.com/v1',
      });
      await adapter.infer('System', 'Test');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const url = call[0] as string;
      expect(url.startsWith('https://custom.api.com/v1')).toBe(true);
    });
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================

  describe('error handling', () => {
    test('throws on empty response', async () => {
      global.fetch = mockFetchResponse({ candidates: [] });

      const adapter = new GeminiRoboticsInference({
        apiKey: 'test-key',
        maxRetries: 0,
      });

      await expect(adapter.infer('System', 'Test')).rejects.toThrow('Empty response');
    });

    test('throws on missing parts', async () => {
      global.fetch = mockFetchResponse({
        candidates: [{ content: { parts: [] } }],
      });

      const adapter = new GeminiRoboticsInference({
        apiKey: 'test-key',
        maxRetries: 0,
      });

      await expect(adapter.infer('System', 'Test')).rejects.toThrow('Empty response');
    });
  });
});
