/**
 * MemoryClient — Thin HTTP client wrapping the evolving-memory REST API.
 *
 * Replaces the local DreamEngine, StrategyStore, and TraceLogger with
 * remote calls to the evolving-memory server.
 */

import type { HierarchyLevel, TraceSource, TraceOutcome } from './types';
import { withRetry } from '../shared/retry';

// =============================================================================
// Types
// =============================================================================

export interface TraceAction {
  reasoning: string;
  actionPayload: string;
  result: string;
}

export interface IngestTraceRequest {
  goal: string;
  hierarchyLevel?: HierarchyLevel;
  outcome?: string;
  confidence?: number;
  source?: string;
  actions?: TraceAction[];
  tags?: string[];
}

export interface IngestTraceResponse {
  trace_id: string;
  session_id: string;
}

export interface DreamResult {
  journal_id: string;
  traces_processed: number;
  nodes_created: number;
  nodes_merged: number;
  edges_created: number;
  constraints_extracted: number;
  phase_log: string[];
}

export interface QueryResult {
  path: string;
  reasoning: string;
  confidence: number;
  entry_point?: {
    node_id: string;
    goal: string;
    summary: string;
    similarity_score: number;
    composite_score: number;
  };
}

export interface ParentNodeResult {
  node_id: string;
  type: 'parent';
  hierarchy_level: number;
  goal: string;
  summary: string;
  confidence: number;
  outcome: string;
  success_rate: number;
  version: number;
  child_count: number;
  trigger_goals: string[];
  negative_constraints: string[];
}

export interface ChildNodeResult {
  node_id: string;
  type: 'child';
  parent_node_id: string;
  hierarchy_level: number;
  summary: string;
  reasoning: string;
  action: string;
  result: string;
  step_index: number;
  confidence: number;
}

export interface TraversalResult {
  node_id: string;
  edges_out: Array<{ edge_id: string; target: string; type: string; weight: number }>;
  edges_in: Array<{ edge_id: string; source: string; type: string; weight: number }>;
}

export interface HealthResponse {
  status: string;
}

export interface StatsResponse {
  parent_nodes: number;
  child_nodes: number;
  edges: number;
  sessions: number;
  traces: number;
  dream_cycles: number;
}

// =============================================================================
// Client
// =============================================================================

export class MemoryClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8420') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  // ── Health ──────────────────────────────────────────────────────

  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/health');
  }

  // ── Trace Ingestion ────────────────────────────────────────────

  async ingestTrace(req: IngestTraceRequest): Promise<IngestTraceResponse> {
    return this.post<IngestTraceResponse>('/traces', {
      goal: req.goal,
      hierarchy_level: req.hierarchyLevel ?? 3,
      outcome: req.outcome ?? 'unknown',
      confidence: req.confidence ?? 0.0,
      source: req.source ?? 'unknown_source',
      actions: (req.actions ?? []).map(a => ({
        reasoning: a.reasoning,
        action_payload: a.actionPayload,
        result: a.result,
      })),
      tags: req.tags ?? [],
    });
  }

  // ── Dream Cycle ────────────────────────────────────────────────

  async runDream(domain?: string): Promise<DreamResult> {
    return this.post<DreamResult>('/dream/run', { domain: domain ?? 'default' });
  }

  // ── Query ──────────────────────────────────────────────────────

  async query(q: string): Promise<QueryResult> {
    return this.get<QueryResult>(`/query?q=${encodeURIComponent(q)}`);
  }

  // ── Node Access ────────────────────────────────────────────────

  async getNode(id: string): Promise<ParentNodeResult | ChildNodeResult> {
    return this.get(`/nodes/${encodeURIComponent(id)}`);
  }

  async getChildren(nodeId: string): Promise<ChildNodeResult[]> {
    return this.get(`/nodes/${encodeURIComponent(nodeId)}/children`);
  }

  async traverse(nodeId: string): Promise<TraversalResult> {
    return this.get(`/nodes/${encodeURIComponent(nodeId)}/traverse`);
  }

  // ── Router ─────────────────────────────────────────────────────

  async route(query: string): Promise<QueryResult> {
    return this.post<QueryResult>('/route', { query });
  }

  // ── Domains ────────────────────────────────────────────────────

  async listDomains(): Promise<{ domains: string[] }> {
    return this.get('/domains');
  }

  async domainDream(domain: string): Promise<DreamResult> {
    return this.post<DreamResult>(`/domains/${encodeURIComponent(domain)}/dream`, {});
  }

  // ── Stats ──────────────────────────────────────────────────────

  async stats(): Promise<StatsResponse> {
    return this.get<StatsResponse>('/stats');
  }

  // ── Private HTTP helpers ───────────────────────────────────────

  private async get<T>(path: string, timeoutMs = 5000): Promise<T> {
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resp = await fetch(`${this.baseUrl}${path}`, {
            signal: controller.signal,
          });
          if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`GET ${path} failed (${resp.status}): ${body}`);
          }
          return resp.json() as Promise<T>;
        } finally {
          clearTimeout(timer);
        }
      },
      { maxRetries: 2, baseMs: 200, label: `GET ${path}` },
    );
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 30000): Promise<T> {
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resp = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`POST ${path} failed (${resp.status}): ${text}`);
          }
          return resp.json() as Promise<T>;
        } finally {
          clearTimeout(timer);
        }
      },
      { maxRetries: 2, baseMs: 200, label: `POST ${path}` },
    );
  }
}
