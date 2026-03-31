/**
 * Shared retry/backoff utility — ported from claw-code's send_with_retry pattern.
 *
 * Provides exponential backoff with jitter and error classification
 * for retryable HTTP status codes.
 */

import { logger } from './logger';

/** HTTP status codes that are safe to retry. */
export function isRetryableStatus(status: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

/** Exponential backoff delay in milliseconds. */
export function backoffMs(attempt: number, baseMs = 200, maxMs = 2000): number {
  const multiplier = Math.pow(2, attempt - 1);
  const delay = Math.min(baseMs * multiplier, maxMs);
  // Add small jitter (0-10%) to avoid thundering herd
  const jitter = delay * 0.1 * Math.random();
  return Math.floor(delay + jitter);
}

/** Check if an error is retryable based on its message or cause. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof TypeError) {
    // Network errors (fetch failures, DNS, connection refused)
    return true;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    // Timeout — retryable
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  // Match "API error NNN:" pattern from our inference adapters
  const statusMatch = msg.match(/(?:API error|failed \()(\d{3})/);
  if (statusMatch) {
    return isRetryableStatus(parseInt(statusMatch[1], 10));
  }
  // Network-level keywords
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(msg);
}

export interface RetryOptions {
  maxRetries?: number;
  baseMs?: number;
  maxMs?: number;
  isRetryable?: (error: unknown) => boolean;
  label?: string;
}

/**
 * Execute an async function with exponential backoff retry.
 *
 * Only retries on errors classified as retryable (network issues,
 * 429/5xx status codes). Non-retryable errors (400, 401, 403, 404)
 * are thrown immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const baseMs = opts.baseMs ?? 200;
  const maxMs = opts.maxMs ?? 2000;
  const check = opts.isRetryable ?? isRetryableError;
  const label = opts.label ?? 'operation';

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries && check(error)) {
        const delay = backoffMs(attempt + 1, baseMs, maxMs);
        logger.debug('Retry', `${label} attempt ${attempt + 1} failed, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else if (!check(error)) {
        // Non-retryable error — throw immediately
        throw error;
      }
    }
  }

  throw lastError;
}
