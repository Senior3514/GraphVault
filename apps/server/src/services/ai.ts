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
 *     `graphvault-ai-cred-v1` — distinct from WebDAV (`-webdav-`) and S3
 *     (`-s3-`) so even if two users share the same userId the derived keys
 *     for each credential type are independent.
 *
 * Rate limiting:
 *   - A per-user/day request cap (GRAPHVAULT_AI_DAILY_CAP, default 200) is
 *     enforced in-process using a lightweight counter. Resets at midnight UTC.
 *   - On top of this the global @fastify/rate-limit cap applies (shared with
 *     all other routes) to protect against burst abuse.
 *   - The cap is intentionally conservative and self-hosted-friendly (users can
 *     raise or remove it via the env var on their own deployment).
 *
 * Gateway:
 *   - `openrouter` (default): proxies to https://openrouter.ai/api/v1/chat/completions
 *     using the OpenAI-compatible Chat Completions API. Supports 400+ models
 *     via a single key.
 *   - `custom`: proxies to a user-supplied baseUrl (must be OpenAI-compat).
 *
 * Privacy / audit rules:
 *   - The API key is NEVER logged, returned, or included in error messages.
 *   - Only the completion text is returned to the client — no upstream headers,
 *     model metadata (other than model string), or usage counts.
 *   - No telemetry; the server makes no other outbound calls.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { AiConfigInfo, AiConfigRequest } from '@graphvault/shared';
import { AppError, badRequest, notFound } from '../errors.js';
import { guardedFetch } from './ssrf.js';
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

interface OpenAICompatResponse {
  choices: { message: { content: string } }[];
  model?: string;
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

// ---------------------------------------------------------------------------
// Per-user daily request cap
// ---------------------------------------------------------------------------

interface DayCounter {
  /** UTC date string "YYYY-MM-DD" for the current window. */
  date: string;
  count: number;
}

const dailyCaps = new Map<string, DayCounter>();

function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Increment the daily counter for `userId` and throw 429 if the cap is
 * exceeded. `cap <= 0` means unlimited.
 */
function checkAndIncrementDailyCap(userId: string, cap: number): void {
  if (cap <= 0) return;
  const today = currentUtcDate();
  const existing = dailyCaps.get(userId);
  if (!existing || existing.date !== today) {
    dailyCaps.set(userId, { date: today, count: 1 });
    return;
  }
  if (existing.count >= cap) {
    // 429 RATE_LIMITED — matches the rest of the app's rate-limit envelope.
    throw new AppError(
      429,
      'RATE_LIMITED',
      `AI proxy daily request cap (${cap}) reached. Try again tomorrow or increase GRAPHVAULT_AI_DAILY_CAP.`,
    );
  }
  existing.count += 1;
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
  constructor(
    private readonly storage: Storage,
    private readonly serverKey?: Buffer,
    /** Per-user/day request cap. 0 = unlimited. */
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
      updatedAt: new Date().toISOString(),
    };
    await this.storage.upsertAiConfig(record);
  }

  /**
   * Return the non-secret config info for the user. Returns null if not
   * configured — callers should convert this to a 404.
   */
  async getConfigInfo(userId: string): Promise<AiConfigInfo | null> {
    const record = await this.storage.getAiConfig(userId);
    if (!record) return null;
    return {
      keySet: true,
      gateway: record.gateway,
      baseUrl: record.baseUrl,
      model: record.model,
      updatedAt: record.updatedAt,
    };
  }

  /** Remove the AI configuration for the given user. */
  async deleteConfig(userId: string): Promise<void> {
    await this.storage.deleteAiConfig(userId);
  }

  // ---- Proxy chat ----

  /**
   * Forward an OpenAI-compatible chat completion request to the upstream
   * gateway using the stored (decrypted) API key.
   *
   * Returns `{ content, model }` — never the raw key or upstream headers.
   *
   * @throws 404 if AI is not configured for this user.
   * @throws 400 if the upstream returns a non-200 or malformed response.
   * @throws 429 if the daily cap is exceeded.
   */
  async chat(
    userId: string,
    messages: AiChatMessage[],
    modelOverride?: string,
  ): Promise<{ content: string; model?: string }> {
    // Rate-limit check (in-process daily cap).
    checkAndIncrementDailyCap(userId, this.dailyCap);

    // Load and decrypt the stored key.
    const record = await this.storage.getAiConfig(userId);
    if (!record) {
      throw notFound('AI is not configured for this account. Add an API key in Settings.');
    }
    const apiKey = decryptApiKey(record.encryptedApiKey, userId, this.serverKey);

    // Resolve the outbound endpoint and model.
    const baseUrl =
      record.gateway === 'openrouter'
        ? OPENROUTER_BASE_URL
        : (record.baseUrl ?? OPENROUTER_BASE_URL);

    const model = modelOverride ?? record.model ?? DEFAULT_OPENROUTER_MODEL;

    const url = baseUrl.replace(/\/$/, '') + '/chat/completions';

    // Build request headers — never log the key.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    // OpenRouter recommends these headers for attribution / routing.
    if (record.gateway === 'openrouter') {
      headers['HTTP-Referer'] = 'https://graphvault.app';
      headers['X-Title'] = 'GraphVault';
    }

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
        }),
      });
    } catch (err) {
      // Strip key from error message (belt-and-suspenders; fetch errors
      // typically don't include request headers, but be defensive).
      const raw = err instanceof Error ? err.message : 'Network error';
      throw badRequest(`AI proxy: upstream unreachable — ${raw.replace(apiKey, '[REDACTED]')}`);
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
      throw badRequest(`AI proxy: upstream returned ${res.status} — ${safe}`);
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

    // choices.length > 0 is guaranteed by isOpenAICompatResponse.
    const firstChoice = json.choices[0];
    if (!firstChoice) throw badRequest('AI proxy: upstream returned empty choices array');
    const content = firstChoice.message.content.trim();
    const upstreamModel = json.model;
    return { content, model: upstreamModel };
  }
}
