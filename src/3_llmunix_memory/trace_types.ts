/**
 * Shared type definitions for the Hierarchical Cognitive Architecture.
 *
 * Re-exports all generic types from llmunix-core and provides
 * backward-compatible BytecodeEntry alias + conversion helpers.
 */

// Re-export all core types
export {
  HierarchyLevel,
  TraceOutcome,
  TraceSource,
  type ActionEntry,
  type Strategy,
  type NegativeConstraint,
  type DreamJournalEntry,
} from '../llmunix-core/types';

// Re-export HierarchicalTraceEntry from core (uses actionEntries)
export type { HierarchicalTraceEntry } from '../llmunix-core/types';

import type { ActionEntry, HierarchicalTraceEntry as CoreEntry } from '../llmunix-core/types';

// =============================================================================
// BytecodeEntry — Backward-compatible alias for RoClaw consumers
// =============================================================================

export interface BytecodeEntry {
  timestamp: string;
  vlmOutput: string;
  bytecodeHex: string;
}

/**
 * Convert a BytecodeEntry to a generic ActionEntry.
 */
export function bytecodeToAction(bc: BytecodeEntry): ActionEntry {
  return {
    timestamp: bc.timestamp,
    reasoning: bc.vlmOutput,
    actionPayload: bc.bytecodeHex,
  };
}

/**
 * Convert a generic ActionEntry to a BytecodeEntry.
 */
export function actionToBytecode(action: ActionEntry): BytecodeEntry {
  return {
    timestamp: action.timestamp,
    vlmOutput: action.reasoning,
    bytecodeHex: action.actionPayload,
  };
}

/**
 * Adapt a core HierarchicalTraceEntry's actionEntries as BytecodeEntry[].
 */
export function getBytecodesFromTrace(entry: CoreEntry): BytecodeEntry[] {
  return entry.actionEntries.map(actionToBytecode);
}
