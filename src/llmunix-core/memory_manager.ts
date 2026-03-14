/**
 * LLMunix Core — Memory Manager
 *
 * Section-based memory system. Domain adapters register their sections
 * (e.g., hardware, identity, skills) and the core assembles them into
 * a unified context for LLM consumption.
 *
 * Strategy storage has moved to evolving-memory server. Strategy methods
 * now delegate to MemoryClient when available, or return empty results.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MemorySection } from './interfaces';
import { MemoryClient } from './memory_client';

// =============================================================================
// Configuration
// =============================================================================

export interface CoreMemoryManagerConfig {
  tracesDir: string;
  strategiesDir: string;
  memoryServerUrl?: string;
}

// =============================================================================
// Helpers
// =============================================================================

function safeRead(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

// =============================================================================
// CoreMemoryManager
// =============================================================================

export class CoreMemoryManager {
  private cache = new Map<string, string>();
  private sections = new Map<string, MemorySection>();
  protected tracesDir: string;
  protected strategiesDir: string;
  private memoryClient: MemoryClient | null = null;

  constructor(config: CoreMemoryManagerConfig) {
    this.tracesDir = config.tracesDir;
    this.strategiesDir = config.strategiesDir;
    if (config.memoryServerUrl) {
      this.memoryClient = new MemoryClient(config.memoryServerUrl);
    }
  }

  /**
   * Register a named memory section.
   */
  registerSection(section: MemorySection): void {
    this.sections.set(section.name, section);
  }

  /**
   * Get a single registered section's content by name.
   */
  getSection(name: string): string {
    const section = this.sections.get(name);
    if (!section) return '';
    return this.cached(`section:${name}`, section.load);
  }

  /**
   * Get the N most recent trace files (newest first).
   */
  getRecentTraces(n = 3): string {
    return this.cached(`traces:${n}`, () => {
      try {
        const files = fs.readdirSync(this.tracesDir)
          .filter(f => f.endsWith('.md'))
          .sort()
          .reverse()
          .slice(0, n);
        return files
          .map(f => safeRead(path.join(this.tracesDir, f)))
          .filter(Boolean)
          .join('\n---\n');
      } catch {
        return '';
      }
    });
  }

  /**
   * Get the full memory context — all registered sections + traces.
   */
  getFullContext(): string {
    const parts: string[] = [];

    // Registered sections sorted by priority
    const sortedSections = [...this.sections.values()]
      .sort((a, b) => a.priority - b.priority);

    for (const section of sortedSections) {
      const content = this.getSection(section.name);
      if (content) {
        parts.push(`${section.heading}\n${content}`);
      }
    }

    // Recent traces
    const traces = this.getRecentTraces();
    if (traces) parts.push(`## Recent Traces\n${traces}`);

    return parts.join('\n\n');
  }

  /**
   * Get the MemoryClient for remote strategy/memory queries.
   */
  getMemoryClient(): MemoryClient | null {
    return this.memoryClient;
  }

  /**
   * Clear the cache (e.g., after files change on disk).
   */
  refreshCache(): void {
    this.cache.clear();
  }

  // ---------------------------------------------------------------------------
  // Protected / Private
  // ---------------------------------------------------------------------------

  protected cached(key: string, loader: () => string): string {
    const existing = this.cache.get(key);
    if (existing !== undefined) return existing;

    const value = loader();
    this.cache.set(key, value);
    return value;
  }
}
