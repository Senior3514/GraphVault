/**
 * A small, bounded, TTL in-memory cache for buffered (non-streaming) AI chat
 * responses.
 *
 * Backend DNA (CLAUDE.md): avoid redundant upstream LLM calls for identical
 * repeat requests within a short window - e.g. a user re-clicking "Suggest
 * related notes" on the same unchanged note, or a client-side retry after a
 * dropped response. Deliberately simple: an in-process `Map`, no Redis or
 * other external cache dependency, matching this server's existing
 * in-memory-by-default architecture (the same tier the in-memory storage
 * adapter uses). A cache hit is meant to cost the user nothing, so
 * `AiService.chat()` returns it BEFORE the daily request/spend cap check and
 * BEFORE committing any spend - counting a free cache hit against a paid
 * usage cap would defeat the point of caching at all.
 *
 * Scoped to the buffered `chat()` path only, not `streamChat()` - streaming
 * exists specifically for the live "watch it type" assistant panel UX, and
 * instantly replaying a cached response would just look like a UI glitch
 * there. The buffered path is used by the batch analysis features (related
 * notes, gap finding, cluster naming) where an identical repeat call is both
 * plausible and safe to short-circuit.
 */

import { createHash } from 'node:crypto';
import type { AiUsage } from '@graphvault/shared';

export interface CachedAiResponse {
  content: string;
  model?: string;
  usage?: AiUsage;
}

interface CacheEntry {
  value: CachedAiResponse;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes - short enough that staleness is a non-issue.
const DEFAULT_MAX_ENTRIES = 500;

export class AiResponseCache {
  private readonly store = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {}

  /**
   * Deterministic key from the exact inputs that determine the response:
   * the user (caches must never cross users), the resolved model (so
   * switching providers/models never serves a stale answer from another
   * one), and the message list verbatim.
   */
  static key(userId: string, model: string, messages: unknown): string {
    const raw = JSON.stringify({ userId, model, messages });
    return createHash('sha256').update(raw).digest('hex');
  }

  get(key: string): CachedAiResponse | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: CachedAiResponse): void {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      // Map preserves insertion order, so the first key is the oldest -
      // simplest correct bounded eviction without an LRU dependency.
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Current entry count - exposed for tests, not used by request handling. */
  get size(): number {
    return this.store.size;
  }
}
