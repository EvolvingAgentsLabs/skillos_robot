/**
 * LLMunix Core — Barrel export
 *
 * Generic hierarchical cognitive architecture with zero domain dependencies.
 * Dream engine, strategy store, and trace logger are now provided by
 * the evolving-memory server via MemoryClient.
 */

// Types
export {
  HierarchyLevel,
  TraceOutcome,
  TraceSource,
  TRACE_FIDELITY_WEIGHTS,
  type ActionEntry,
  type HierarchicalTraceEntry,
  type Strategy,
  type NegativeConstraint,
  type DreamJournalEntry,
} from './types';

// Interfaces
export {
  type InferenceFunction,
  type DreamDomainAdapter,
  type MemorySection,
  type LevelDirectoryConfig,
} from './interfaces';

// Utils
export { extractJSON, parseJSONSafe } from './utils';

// Memory Manager (still local — manages context assembly)
export {
  CoreMemoryManager,
  type CoreMemoryManagerConfig,
} from './memory_manager';

// Memory Client (replaces DreamEngine, StrategyStore, TraceLogger)
export {
  MemoryClient,
  type IngestTraceRequest,
  type DreamResult,
  type QueryResult,
  type StatsResponse,
} from './memory_client';
