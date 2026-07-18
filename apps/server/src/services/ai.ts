/**
 * AI proxy service.
 *
 * Security model:
 *   - AI API keys are stored server-side, encrypted at rest with AES-256-GCM
 *     using a key derived from the server's GRAPHVAULT_ENCRYPTION_KEY and the
 *     user's ID (same pattern as WebDAV and S3).
 *   - If no server encryption key is configured, credentials are stored with a
 *     deterministic per-user key derived via HKDF from a process-local secret.
 *   - Keys are NEVER returned to the client. The client receives only the
 *     non-secret AiConfigInfo (keySet + gateway + model + updatedAt).
 *   - All outbound AI requests are made server-side, so the browser never
 *     contacts the AI provider directly. The HKDF info string is
 *     `graphvault-ai-cred-v1` - distinct from WebDAV (`-webdav-`) and S3
 *     (`-s3-`) so even if two users share the same userId the derived keys
 *     for each credential type are independent.
 *
 * Rate limiting (durable, per-user/day - see docs/ai-bff.md §4):
 *   - Two independent caps share one UTC-day window, persisted in the Storage
 *     layer (AiSpendWindowRecord) so they survive a restart:
 *       • request count - per-user `dailyRequestCap` (config) or the server's
 *         GRAPHVAULT_AI_DAILY_CAP env default (200); 0 = unlimited.
 *       • monetary spend - per-user `spendCapUsd` (config); unset/0 = no $ cap.
 *   - Caps are "soft": the cost is unknown until generation completes, so one
 *     in-flight call may cross the cap; the next call is then refused (429).
 *   - The committed cost is the provider-reported dollar amount; when the gateway
 *     reports none we record costUsd 0 and rely on the request cap - never guess.
 *   - On top of this the global @fastify/rate-limit cap applies (shared with all
 *     other routes) to protect against burst abuse.
 *
 * Gateway:
 *   - `openrouter` (default): proxies to https://openrouter.ai/api/v1/chat/completions
 *     using the OpenAI-compatible Chat Completions API. Supports 400+ models
 *     via a single key.
 *   - `custom`: proxies to a user-supplied baseUrl (must be OpenAI-compat).
 *
 * Privacy / audit rules:
 *   - The API key is NEVER logged, returned, or included in error messages
 *     (belt-and-suspenders redaction on both buffered and SSE error paths).
 *   - The client receives the completion text, the upstream model string, and
 *     token/cost usage (so it can render a budget meter) - never upstream headers
 *     or the raw provider JSON. Prompts and responses are NEVER written to durable
 *     storage; only the request count and dollar cost go into the durable spend
 *     window. The buffered `chat()` path does hold recent prompts/responses in a
 *     small in-process, short-TTL cache (`aiCache.ts`, Backend DNA - avoid
 *     redundant upstream calls on an identical repeat request) - bounded,
 *     process-memory-only, never disk-persisted, and gone within minutes; a cache
 *     hit is returned to the SAME user's request only and bypasses the request/
 *     spend cap entirely, since it never touches the upstream provider.
 *   - No telemetry; the server makes no other outbound calls.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type {
  AiConfigInfo,
  AiConfigRequest,
  AiSpendCapState,
  AiStreamEvent,
  AiUsage,
} from '@graphvault/shared';
import { AppError, badRequest, notFound } from '../errors.js';
import { guardedFetch } from './ssrf.js';
import { AiResponseCache } from './aiCache.js';
import type { AiConfigRecord, Storage } from '../store/types.js';
import type { AiChatMessage } from '@graphvault/shared';

// ---------------------------------------------------------------------------
// Encryption helpers (same AES-256-GCM + HKDF pattern as webdav.ts / s3.ts)
// ---------------------------------------------------------------------------

const AES_ALGORITHM = 'aes-256-gcm' as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Process-lifetime fallback when GRAPHVAULT_ENCRYPTION_KEY is not set. */
const PROCESS_FALLBACK_KEY = randomBytes(32);

function deriveUserKey(userId: string, serverKey?: Buffer): Buffer {
  const ikm = serverKey ?? PROCESS_FALLBACK_KEY;
  const salt = Buffer.from(userId, 'utf8');
  const info = Buffer.from('graphvault-ai-cred-v1', 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
}

function encryptApiKey(plaintext: string, userId: string, serverKey?: Buffer): string {
  const key = deriveUserKey(userId, serverKey);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ct]).toString('base64');
}

function decryptApiKey(ciphertext: string, userId: string, serverKey?: Buffer): string {
  const key = deriveUserKey(userId, serverKey);
  const buf = Buffer.from(ciphertext, 'base64');
  if (buf.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error('Malformed AI credential ciphertext');
  }
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ct = buf.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(AES_ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt AI credentials (wrong key or corrupted data)');
  }
}

// ---------------------------------------------------------------------------
// OpenRouter / OpenAI-compatible response types
// ---------------------------------------------------------------------------

/** Raw OpenAI-compatible usage block (token counts; cost is OpenRouter-specific). */
interface OpenAICompatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenRouter-specific: computed dollar cost for the call. */
  cost?: number;
}

interface OpenAICompatResponse {
  choices: { message: { content: string } }[];
  model?: string;
  usage?: OpenAICompatUsage;
}

function isOpenAICompatResponse(r: unknown): r is OpenAICompatResponse {
  return (
    typeof r === 'object' &&
    r !== null &&
    Array.isArray((r as OpenAICompatResponse).choices) &&
    (r as OpenAICompatResponse).choices.length > 0 &&
    typeof (r as OpenAICompatResponse).choices[0]?.message?.content === 'string'
  );
}

/**
 * Translate an upstream usage block into our provider-agnostic {@link AiUsage}.
 * `costUsd` is included ONLY when the gateway reported a real dollar cost - we
 * never estimate (a guess could over- or under-charge the user's own budget).
 * When no cost is reported the request-count cap remains the backstop.
 */
function toAiUsage(raw: OpenAICompatUsage | undefined): AiUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage: AiUsage = {};
  if (typeof raw.prompt_tokens === 'number') usage.promptTokens = raw.prompt_tokens;
  if (typeof raw.completion_tokens === 'number') usage.completionTokens = raw.completion_tokens;
  if (typeof raw.cost === 'number' && Number.isFinite(raw.cost)) usage.costUsd = raw.cost;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** The dollar cost to commit (0 when the gateway reported none - never guessed). */
function costToCommit(usage: AiUsage | undefined): number {
  return typeof usage?.costUsd === 'number' && Number.isFinite(usage.costUsd) ? usage.costUsd : 0;
}

// ---------------------------------------------------------------------------
// Durable per-user/day spend + request caps (see docs/ai-bff.md §4)
// ---------------------------------------------------------------------------

function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Next UTC-midnight ISO timestamp (when the current window resets). */
function nextUtcMidnightIso(): string {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return next.toISOString();
}

/** The accrued counters for `today` (a stale window reads as empty). */
interface WindowCounters {
  requests: number;
  spentUsd: number;
}

// ---------------------------------------------------------------------------
// Gateway constants
// ---------------------------------------------------------------------------

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';

// ---------------------------------------------------------------------------
// AiService
// ---------------------------------------------------------------------------

export class AiService {
  /** Backend DNA: short-TTL cache for buffered chat() responses - see aiCache.ts. */
  private readonly responseCache = new AiResponseCache();

  constructor(
    private readonly storage: Storage,
    private readonly serverKey?: Buffer,
    /** Server-default per-user/day request cap. 0 = unlimited. */
    private readonly dailyCap: number = 200,
  ) {}

  // ---- Config management ----

  /**
   * Store or update the AI configuration for the given user.
   * The apiKey is encrypted before being written to storage.
   */
  async saveConfig(userId: string, input: AiConfigRequest): Promise<void> {
    const encryptedApiKey = encryptApiKey(input.apiKey, userId, this.serverKey);
    const record: AiConfigRecord = {
      userId,
      encryptedApiKey,
      gateway: input.gateway ?? 'openrouter',
      baseUrl: input.baseUrl,
      model: input.model,
      spendCapUsd: input.spendCapUsd,
      dailyRequestCap: input.dailyRequestCap,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.upsertAiConfig(record);
  }

  /**
   * Return the non-secret config info for the user. Returns null if not
   * configured - callers should convert this to a 404. Includes the live spend
   * window status (budget meter + send-button gate) but NEVER the key.
   */
  async getConfigInfo(userId: string): Promise<AiConfigInfo | null> {
    const record = await this.storage.getAiConfig(userId);
    if (!record) return null;
    const counters = await this.loadWindowCounters(userId);
    return {
      keySet: true,
      gateway: record.gateway,
      baseUrl: record.baseUrl,
      model: record.model,
      updatedAt: record.updatedAt,
      spendCapUsd: record.spendCapUsd,
      spendCapState: this.computeSpendCapState(record, counters),
    };
  }

  /** Remove the AI configuration for the given user. */
  async deleteConfig(userId: string): Promise<void> {
    await this.storage.deleteAiConfig(userId);
  }

  // ---- Durable spend / request caps (docs/ai-bff.md §4) ----

  /** The effective request cap for a user (per-user override, else env default). */
  private effectiveRequestCap(record: AiConfigRecord): number {
    return record.dailyRequestCap ?? this.dailyCap;
  }

  /** Load the user's accrued counters for today (a stale window reads as empty). */
  private async loadWindowCounters(userId: string): Promise<WindowCounters> {
    const today = currentUtcDate();
    const window = await this.storage.getAiSpendWindow(userId);
    if (!window || window.windowDate !== today) {
      return { requests: 0, spentUsd: 0 };
    }
    return { requests: window.requests, spentUsd: window.spentUsd };
  }

  /**
   * Pre-check both caps against the *previously accrued* spend. Caps are "soft":
   * one in-flight call may cross the cap (cost is unknown until generation
   * completes); the next call is then refused. `cap <= 0` / undefined = no cap.
   *
   * @throws 429 RATE_LIMITED if either cap is already reached.
   */
  private async precheckCaps(record: AiConfigRecord): Promise<void> {
    const counters = await this.loadWindowCounters(record.userId);

    const requestCap = this.effectiveRequestCap(record);
    if (requestCap > 0 && counters.requests >= requestCap) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        `AI daily request cap (${requestCap}) reached. Resets at UTC midnight or raise it in Settings.`,
      );
    }

    const spendCap = record.spendCapUsd ?? 0;
    if (spendCap > 0 && counters.spentUsd >= spendCap) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        `AI daily spend cap ($${spendCap}) reached. Resets at UTC midnight or raise it in Settings.`,
      );
    }
  }

  /** Commit one request plus the provider-reported cost (0 when none reported). */
  private async commitSpend(userId: string, usage: AiUsage | undefined): Promise<void> {
    await this.storage.commitAiSpend(userId, costToCommit(usage), 1, currentUtcDate());
  }

  /** Build the live spend-cap status for the config GET (non-secret). */
  private computeSpendCapState(record: AiConfigRecord, counters: WindowCounters): AiSpendCapState {
    const spendCap = record.spendCapUsd ?? 0;
    const requestCap = this.effectiveRequestCap(record);

    // Fraction of whichever cap is closest to being hit (spend or requests).
    let fraction = 0;
    if (spendCap > 0) fraction = Math.max(fraction, counters.spentUsd / spendCap);
    if (requestCap > 0) fraction = Math.max(fraction, counters.requests / requestCap);

    let state: AiSpendCapState['state'] = 'ok';
    if (fraction >= 1) state = 'exceeded';
    else if (fraction >= 0.8) state = 'warning';

    return {
      state,
      windowSpentUsd: counters.spentUsd,
      windowRequests: counters.requests,
      windowResetsAt: nextUtcMidnightIso(),
    };
  }

  // ---- Outbound request plumbing (shared by buffered + streaming paths) ----

  /**
   * Load + decrypt the config and resolve the outbound endpoint/model/headers.
   * The plaintext key lives only in the returned `headers` object (and the
   * returned `apiKey`, used solely for redaction) - never stored or logged.
   *
   * @throws 404 if AI is not configured for this user.
   */
  private async prepareOutbound(
    userId: string,
    modelOverride?: string,
  ): Promise<{
    record: AiConfigRecord;
    apiKey: string;
    url: string;
    model: string;
    headers: Record<string, string>;
  }> {
    const record = await this.storage.getAiConfig(userId);
    if (!record) {
      throw notFound('AI is not configured for this account. Add an API key in Settings.');
    }
    const apiKey = decryptApiKey(record.encryptedApiKey, userId, this.serverKey);

    const baseUrl =
      record.gateway === 'openrouter'
        ? OPENROUTER_BASE_URL
        : (record.baseUrl ?? OPENROUTER_BASE_URL);
    const model = modelOverride ?? record.model ?? DEFAULT_OPENROUTER_MODEL;
    const url = baseUrl.replace(/\/$/, '') + '/chat/completions';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    if (record.gateway === 'openrouter') {
      headers['HTTP-Referer'] = 'https://graphvault.app';
      headers['X-Title'] = 'GraphVault';
    }

    return { record, apiKey, url, model, headers };
  }

  // ---- Buffered (non-streaming) chat ----

  /**
   * Forward an OpenAI-compatible chat completion request to the upstream
   * gateway using the stored (decrypted) API key.
   *
   * Returns `{ content, model, usage }` - never the raw key or upstream headers.
   *
   * Backend DNA: an identical repeat request (same user, same resolved model,
   * same messages) within a short window is served from `responseCache`
   * instead of calling the upstream provider again - it bypasses the cap
   * check and spend commit entirely below, since it never touches the
   * provider and therefore costs nothing.
   *
   * @throws 404 if AI is not configured for this user.
   * @throws 400 if the upstream returns a non-200 or malformed response.
   * @throws 429 if a daily cap (request or spend) is exceeded.
   */
  async chat(
    userId: string,
    messages: AiChatMessage[],
    modelOverride?: string,
  ): Promise<{ content: string; model?: string; usage?: AiUsage }> {
    const { record, apiKey, url, model, headers } = await this.prepareOutbound(
      userId,
      modelOverride,
    );

    const cacheKey = AiResponseCache.key(userId, model, messages);
    const cached = this.responseCache.get(cacheKey);
    if (cached) return cached;

    // Pre-check caps AFTER resolving the config (so we 404 a missing config) but
    // BEFORE the upstream call. The cost is unknown until generation completes,
    // so the cap is soft (this call may cross; the next is refused).
    await this.precheckCaps(record);

    let res: Response;
    try {
      // SSRF guard: the `custom` gateway lets the user set an arbitrary baseUrl,
      // so every outbound AI request goes through the DNS-pinned guarded fetch.
      // Private/loopback targets (e.g. a self-hosted local LLM) require the
      // explicit GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS opt-in.
      res = await guardedFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 1024,
          temperature: 0.3,
          // Ask the gateway to include usage (token counts + cost) so metering
          // is accurate, not estimated.
          usage: { include: true },
        }),
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Network error';
      throw badRequest(`AI proxy: upstream unreachable - ${raw.replace(apiKey, '[REDACTED]')}`);
    }

    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* ignore read errors */
      }
      // Replace key in error body (defensive; providers may echo auth errors).
      const safe = body.replace(apiKey, '[REDACTED]').slice(0, 400);
      throw badRequest(`AI proxy: upstream returned ${res.status} - ${safe}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw badRequest('AI proxy: upstream returned non-JSON response');
    }

    if (!isOpenAICompatResponse(json)) {
      throw badRequest(
        'AI proxy: upstream response has unexpected shape (missing choices[0].message.content)',
      );
    }

    const firstChoice = json.choices[0];
    if (!firstChoice) throw badRequest('AI proxy: upstream returned empty choices array');
    const content = firstChoice.message.content.trim();
    const upstreamModel = json.model;
    const usage = toAiUsage(json.usage);

    // Commit the real provider-reported cost (0 when the gateway reports none).
    await this.commitSpend(userId, usage);

    const result = { content, model: upstreamModel, usage };
    this.responseCache.set(cacheKey, result);
    return result;
  }

  // ---- Streaming chat (SSE translating relay; docs/ai-bff.md §2.5) ----

  /**
   * Pre-check caps for a streaming request BEFORE any SSE headers are written,
   * so the route can still return a real HTTP 429 in the common case (an SSE
   * response has already committed `200`, so a cap tripped after headers can
   * only be delivered as an `event: error`). Resolves the prepared outbound
   * context for {@link streamChat}.
   *
   * @throws 404 if AI is not configured.
   * @throws 429 if a daily cap is already reached.
   */
  async prepareStream(userId: string, modelOverride?: string): Promise<PreparedStream> {
    const prepared = await this.prepareOutbound(userId, modelOverride);
    await this.precheckCaps(prepared.record);
    return prepared;
  }

  /**
   * Open the upstream stream and yield provider-agnostic {@link AiStreamEvent}
   * frames (`delta` / `usage` / `done` / `error`). NEVER yields raw upstream
   * JSON. The terminal `usage` chunk is read for accurate metering and the real
   * cost is committed once the stream ends. `signal` aborts the upstream fetch
   * (used on client disconnect).
   *
   * This is a generator so the route stays thin: it owns the SSE wire format,
   * heartbeats, and disconnect wiring; the service owns decryption, egress,
   * parsing, redaction, and spend commit.
   */
  async *streamChat(
    userId: string,
    prepared: PreparedStream,
    messages: AiChatMessage[],
    signal: AbortSignal,
  ): AsyncGenerator<AiStreamEvent> {
    const { apiKey, url, model } = prepared;
    const redact = (s: string): string => s.split(apiKey).join('[REDACTED]');

    let res: Response;
    try {
      res = await guardedFetch(url, {
        method: 'POST',
        headers: prepared.headers,
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 1024,
          temperature: 0.3,
          stream: true,
          // OpenAI/OpenRouter terminal usage chunk for accurate metering.
          stream_options: { include_usage: true },
          usage: { include: true },
        }),
        stream: true,
        signal,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Network error';
      yield {
        type: 'error',
        code: 'BAD_REQUEST',
        message: `AI proxy: upstream unreachable - ${redact(raw)}`,
      };
      return;
    }

    if (!res.ok || !res.body) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
      const safe = redact(body).slice(0, 400);
      yield {
        type: 'error',
        code: 'BAD_REQUEST',
        message: `AI proxy: upstream returned ${res.status}${safe ? ` - ${safe}` : ''}`,
      };
      return;
    }

    let finalModel: string | undefined;
    let finalUsage: AiUsage | undefined;
    let committed = false;

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = res.body.getReader();

    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          // Aborted (client disconnect) or socket error - stop relaying.
          break;
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        // SSE frames are separated by a blank line. Process complete frames.
        let sepIndex: number;
        while ((sepIndex = indexOfFrameSep(buffer)) !== -1) {
          const frame = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex).replace(/^(\r?\n)+/, '');
          const { events, model: frameModel } = this.parseUpstreamFrame(frame, redact);
          if (frameModel) finalModel = frameModel;
          for (const ev of events) {
            // `usage` and `done` are terminal - capture, don't relay inline, so
            // exactly one canonical `usage` + one `done` close the stream below.
            if (ev.type === 'done') continue;
            if (ev.type === 'usage') {
              finalUsage = ev.usage;
              continue;
            }
            yield ev; // delta / error
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      // Commit the real reported cost exactly once (0 when none reported). We
      // commit even on disconnect so partial generation still counts a request.
      if (!committed) {
        committed = true;
        await this.commitSpend(userId, finalUsage);
      }
    }

    // Terminal frames: surface the final usage (if not already emitted) + done.
    if (finalUsage) {
      yield { type: 'usage', usage: finalUsage };
    }
    yield { type: 'done', model: finalModel };
  }

  /**
   * Parse one upstream SSE frame (the lines between blank-line separators) into
   * zero or more provider-agnostic events. Translates OpenAI-compatible
   * `data: {choices:[{delta:{content}}]}` lines and the terminal
   * `data: {usage:{…}}` / `data: [DONE]`. Unknown shapes are ignored (never
   * relayed raw). All emitted strings are key-redacted by the caller-supplied
   * `redact`.
   */
  private parseUpstreamFrame(
    frame: string,
    redact: (s: string) => string,
  ): { events: AiStreamEvent[]; model?: string } {
    const out: AiStreamEvent[] = [];
    let model: string | undefined;
    for (const line of frame.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '') continue;
      if (payload === '[DONE]') {
        out.push({ type: 'done' });
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // not JSON - never relay raw
      }
      if (typeof json !== 'object' || json === null) continue;
      const obj = json as {
        model?: unknown;
        choices?: { delta?: { content?: unknown } }[];
        usage?: OpenAICompatUsage;
        error?: { message?: unknown };
      };

      if (typeof obj.model === 'string' && obj.model.length > 0) model = obj.model;

      // Upstream error surfaced mid-stream → clean, redacted error frame.
      if (obj.error && typeof obj.error === 'object') {
        const msg = typeof obj.error.message === 'string' ? obj.error.message : 'upstream error';
        out.push({ type: 'error', code: 'BAD_REQUEST', message: redact(msg).slice(0, 400) });
        continue;
      }

      const delta = obj.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        out.push({ type: 'delta', content: delta });
      }
      const usage = toAiUsage(obj.usage);
      if (usage) {
        out.push({ type: 'usage', usage });
      }
    }
    return { events: out, model };
  }
}

/** The prepared outbound context for a streaming chat (no secrets returned out of the module). */
export interface PreparedStream {
  record: AiConfigRecord;
  apiKey: string;
  url: string;
  model: string;
  headers: Record<string, string>;
}

/**
 * Index of the first SSE frame separator (blank line) in `buffer`, or -1.
 * Handles both `\n\n` and `\r\n\r\n`.
 */
function indexOfFrameSep(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}
