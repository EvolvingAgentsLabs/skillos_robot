// src/orchestrator/index.ts
// Public exports for the ISA orchestrator module.

export { parseOpcode, formatResult, formatAck, parseJSON, STOP_SEQUENCES } from './dispatch';
export type { ParsedOpcode, OpcodeType, CallOpcode, HaltOpcode } from './dispatch';

export { OpenRouterBackend } from './backend';
export type { ChatMessage, GenerateOptions, GenerateResult, OpenRouterBackendConfig } from './backend';

export { Executor } from './executor';
export type { ExecutorConfig, ExecutionResult, TraceEntry, IOHandler } from './executor';

export { ConsoleIOAdapter, MacOSSayAdapter, StubIOAdapter, createIOAdapter } from './io';
export type { IOAdapter, IOAdapterType, StubScenario } from './io';
