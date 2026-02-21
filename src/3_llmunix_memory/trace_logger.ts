/**
 * RoClaw Trace Logger — Records physical experiences to markdown
 *
 * Writes execution traces to the traces/ directory so the LLMunix
 * Dreaming Engine can review and promote patterns to skills.
 */

import * as fs from 'fs';
import * as path from 'path';
import { formatHex } from '../2_qwen_cerebellum/bytecode_compiler';

const TRACES_DIR = path.join(__dirname, 'traces');

/**
 * Append a trace entry to today's trace file.
 */
export function appendTrace(goal: string, vlmOutput: string, bytecode: Buffer): void {
  const date = new Date().toISOString().split('T')[0];
  const tracePath = path.join(TRACES_DIR, `trace_${date}.md`);

  const entry = `
### Time: ${new Date().toISOString()}
**Goal:** ${goal}
**VLM Reasoning:** ${vlmOutput.trim()}
**Compiled Bytecode:** \`${formatHex(bytecode)}\`
---
`;

  if (!fs.existsSync(TRACES_DIR)) {
    fs.mkdirSync(TRACES_DIR, { recursive: true });
  }

  if (!fs.existsSync(tracePath)) {
    fs.writeFileSync(tracePath, `# Execution Traces: ${date}\n\n`);
  }

  fs.appendFileSync(tracePath, entry);
}
