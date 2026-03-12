/**
 * LLMunix Core — Shared utility functions.
 *
 * JSON extraction and parsing helpers used across planner, dream engine,
 * and semantic map. Handles LLM output quirks like <think> tags and
 * markdown code fences.
 */

/**
 * Extract the first valid JSON object or array from LLM output.
 * Strips <think>...</think> blocks and markdown code fences.
 */
export function extractJSON(text: string): string {
  // Strip <think>...</think> blocks (reasoning models)
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Strip markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/gm, '').replace(/\n?```\s*$/gm, '').trim();

  // Find first { ... } or [ ... ] block
  const jsonStart = cleaned.indexOf('{');
  const arrayStart = cleaned.indexOf('[');
  const start = jsonStart >= 0 && (arrayStart < 0 || jsonStart < arrayStart)
    ? jsonStart : arrayStart;

  if (start < 0) return cleaned;

  const openChar = cleaned[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;

  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === openChar) depth++;
    if (cleaned[i] === closeChar) depth--;
    if (depth === 0) return cleaned.slice(start, i + 1);
  }

  return cleaned.slice(start);
}

/**
 * Safely parse JSON from LLM output. Returns null on failure.
 * Attempts truncated JSON recovery by closing open brackets.
 */
export function parseJSONSafe<T>(text: string): T | null {
  const json = extractJSON(text);
  try {
    return JSON.parse(json) as T;
  } catch {
    // Try to salvage truncated JSON by closing open brackets
    try {
      let open = 0, openArr = 0;
      for (const ch of json) {
        if (ch === '{') open++;
        else if (ch === '}') open--;
        else if (ch === '[') openArr++;
        else if (ch === ']') openArr--;
      }
      let fixed = json.replace(/,\s*[^}\]]*$/, '');
      for (let i = 0; i < openArr; i++) fixed += ']';
      for (let i = 0; i < open; i++) fixed += '}';
      return JSON.parse(fixed) as T;
    } catch {
      return null;
    }
  }
}
