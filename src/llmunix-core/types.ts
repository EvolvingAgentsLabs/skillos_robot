/**
 * LLMunix Core — Generic type definitions for hierarchical cognitive architecture.
 *
 * Defines the 4-tier hierarchy, trace entries, strategies, and
 * negative constraints. Domain-agnostic: no robotics-specific types.
 */

// =============================================================================
// Hierarchy Levels
// =============================================================================

export enum HierarchyLevel {
  /** High-level goal decomposition */
  GOAL = 1,
  /** Multi-step strategic plan */
  STRATEGY = 2,
  /** Intra-context tactical plan */
  TACTICAL = 3,
  /** Sub-second reactive control */
  REACTIVE = 4,
}

// =============================================================================
// Trace Outcomes
// =============================================================================

export enum TraceOutcome {
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
  PARTIAL = 'PARTIAL',
  ABORTED = 'ABORTED',
  UNKNOWN = 'UNKNOWN',
}

// =============================================================================
// Action Entry (generic replacement for BytecodeEntry)
// =============================================================================

export interface ActionEntry {
  timestamp: string;
  /** Reasoning or explanation for this action */
  reasoning: string;
  /** The action payload (could be JSON, bytecode hex, text, etc.) */
  actionPayload: string;
}

// =============================================================================
// Hierarchical Trace Entry
// =============================================================================

export interface HierarchicalTraceEntry {
  /** Unique ID for this trace (e.g., "tr_<timestamp>_<random>") */
  traceId: string;
  /** Which tier of the hierarchy this trace belongs to */
  hierarchyLevel: HierarchyLevel;
  /** Parent trace ID for linking sub-goals to their parent */
  parentTraceId: string | null;
  /** ISO timestamp when the trace started */
  timestamp: string;
  /** The goal or sub-goal being pursued */
  goal: string;
  /** Current location node label, if known */
  locationNode: string | null;
  /** Brief scene description at trace start */
  sceneDescription: string | null;
  /** Strategy ID being executed, if any */
  activeStrategyId: string | null;
  /** Outcome of this trace */
  outcome: TraceOutcome;
  /** Human-readable reason for the outcome */
  outcomeReason: string | null;
  /** Duration in milliseconds */
  durationMs: number | null;
  /** Confidence score (0-1) */
  confidence: number | null;
  /** Collected action entries */
  actionEntries: ActionEntry[];
}

// =============================================================================
// Strategy
// =============================================================================

export interface Strategy {
  /** Unique ID (e.g., "strat_3_doorway-approach") */
  id: string;
  /** Version counter, incremented on dream engine updates */
  version: number;
  /** Which hierarchy level this strategy applies to */
  hierarchyLevel: HierarchyLevel;
  /** Human-readable title */
  title: string;
  /** Conditions that must hold for this strategy to apply */
  preconditions: string[];
  /** Goal keywords that trigger this strategy */
  triggerGoals: string[];
  /** Ordered steps to execute */
  steps: string[];
  /** Things NOT to do (learned from failures) */
  negativeConstraints: string[];
  /** Spatial navigation rules learned from bounding box grounding (e.g., "when target bbox center x > 600, TURN_RIGHT proportionally") */
  spatialRules?: string[];
  /** Confidence score (0-1), updated by dream engine */
  confidence: number;
  /** Number of successful uses */
  successCount: number;
  /** Number of failed uses */
  failureCount: number;
  /** Trace IDs that contributed to this strategy */
  sourceTraceIds: string[];
  /** Whether this strategy has been superseded */
  deprecated: boolean;
}

// =============================================================================
// Negative Constraint
// =============================================================================

export interface NegativeConstraint {
  /** What NOT to do */
  description: string;
  /** When this constraint applies (e.g., "near doorways") */
  context: string;
  /** Trace IDs where this was learned */
  learnedFrom: string[];
  /** How critical: "low" | "medium" | "high" */
  severity: 'low' | 'medium' | 'high';
}

// =============================================================================
// Dream Journal
// =============================================================================

export interface DreamJournalEntry {
  /** ISO timestamp of the dream session */
  timestamp: string;
  /** Number of traces processed */
  tracesProcessed: number;
  /** Number of new strategies created */
  strategiesCreated: number;
  /** Number of existing strategies updated */
  strategiesUpdated: number;
  /** Number of negative constraints learned */
  constraintsLearned: number;
  /** Number of traces pruned/deleted */
  tracesPruned: number;
  /** Brief summary of what was learned */
  summary: string;
}
