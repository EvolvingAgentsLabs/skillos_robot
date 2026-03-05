/**
 * RoClaw Dream Domain Adapter — Implements DreamDomainAdapter for robotics
 *
 * Provides bytecode RLE compression and robot-specific LLM prompts
 * for the generic DreamEngine.
 */

import type { DreamDomainAdapter } from '../llmunix-core/interfaces';
import type { ActionEntry, HierarchyLevel } from '../llmunix-core/types';

// =============================================================================
// Bytecode RLE Compression
// =============================================================================

function compressBytecodes(actions: ActionEntry[]): string {
  if (actions.length === 0) return '(no bytecodes)';
  if (actions.length <= 5) {
    const lines = actions.map(a => {
      let line = `${a.actionPayload}: ${a.reasoning.slice(0, 50)}`;
      // Extract spatial coordinate hints from reasoning for short traces
      const coordMatch = a.reasoning.match(/x[=:]\s*(\d+)/i);
      if (coordMatch) {
        line += ` [spatial: x=${coordMatch[1]}]`;
      }
      return line;
    });
    return lines.join('\n');
  }

  // RLE compress: group consecutive identical opcodes
  const compressed: string[] = [];
  let prevOpcode = '';
  let count = 0;

  for (const action of actions) {
    const opcode = action.actionPayload.split(' ')[1] || '??'; // Byte index 1 = opcode
    if (opcode === prevOpcode) {
      count++;
    } else {
      if (count > 0) {
        compressed.push(`${prevOpcode} x${count}`);
      }
      prevOpcode = opcode;
      count = 1;
    }
  }
  if (count > 0) {
    compressed.push(`${prevOpcode} x${count}`);
  }

  return `${actions.length} commands: ${compressed.join(' → ')}`;
}

// =============================================================================
// LLM Prompts
// =============================================================================

const FAILURE_ANALYSIS_SYSTEM = `You are analyzing a failed robot trace sequence. The robot attempted a goal and failed.

Extract a concise negative constraint — something the robot should AVOID doing in similar situations.

Output ONLY valid JSON (no markdown, no explanation):
{
  "description": "Do not attempt tight turns in narrow corridors",
  "context": "narrow corridor navigation",
  "severity": "high"
}`;

const STRATEGY_ABSTRACTION_SYSTEM = `You are abstracting successful robot traces into a reusable strategy.

Given a set of successful trace summaries at a specific hierarchy level, create a general-purpose strategy that captures the common pattern.
If the traces contain spatial coordinate hints (e.g., "[spatial: x=...]"), extract spatial navigation rules that describe how bounding box positions map to motor actions.

Output ONLY valid JSON (no markdown, no explanation):
{
  "title": "Wall Following",
  "trigger_goals": ["follow wall", "navigate corridor", "find door"],
  "preconditions": ["camera active", "near wall"],
  "steps": ["Detect wall on one side", "Maintain parallel distance using differential speed", "Turn at wall corners"],
  "negative_constraints": ["Do not hug wall too closely"],
  "spatial_rules": ["when target bbox center x > 600, TURN_RIGHT proportionally", "when target bbox center x < 400, TURN_LEFT proportionally"]
}`;

const STRATEGY_MERGE_SYSTEM = `You receive an existing robot strategy and new evidence from recent traces. Produce an updated version that incorporates the new evidence.

Keep the same ID and structure. Update steps, confidence hints, and trigger_goals as needed.

Output ONLY valid JSON (no markdown, no explanation):
{
  "title": "Updated Strategy Title",
  "trigger_goals": ["updated", "goals"],
  "preconditions": ["updated preconditions"],
  "steps": ["Updated step 1", "Updated step 2"],
  "negative_constraints": ["Updated constraint"]
}`;

const DREAM_SUMMARY_SYSTEM = `Write a 2-3 sentence dream journal entry summarizing what the robot learned during this consolidation session.

Be specific about what strategies were created or updated and what failures were analyzed.

Output ONLY the summary text (no JSON, no markdown headers).`;

// =============================================================================
// Adapter
// =============================================================================

export const roClawDreamAdapter: DreamDomainAdapter = {
  compressActions: compressBytecodes,

  failureAnalysisSystemPrompt: FAILURE_ANALYSIS_SYSTEM,
  strategyAbstractionSystemPrompt: STRATEGY_ABSTRACTION_SYSTEM,
  strategyMergeSystemPrompt: STRATEGY_MERGE_SYSTEM,
  dreamSummarySystemPrompt: DREAM_SUMMARY_SYSTEM,

  buildFailurePrompt(summary: string): string {
    return `Failed robot trace:\n\n${summary}\n\nWhat should the robot avoid doing in similar situations?`;
  },

  buildAbstractionPrompt(summary: string, level: HierarchyLevel): string {
    return `Successful robot trace at Level ${level}:\n\n${summary}\n\nAbstract this into a reusable strategy.`;
  },

  buildMergePrompt(existing: string, evidence: string): string {
    return [
      `Existing strategy:`,
      existing,
      '',
      `New trace evidence:`,
      evidence,
      '',
      'Update the strategy to incorporate this new evidence.',
    ].join('\n');
  },
};
