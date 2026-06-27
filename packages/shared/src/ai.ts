import { z } from 'zod';

/**
 * Shared zod schemas for the AI proxy feature.
 *
 * Security model:
 *   - The `server` provider mode sends prompts to the GraphVault server's
 *     POST /v1/ai/chat endpoint (authenticated). The server holds the API key
 *     (encrypted at rest with AES-256-GCM + per-user HKDF - same pattern as
 *     WebDAV and S3). The browser never touches the key.
 *   - The `off` and `local` modes never use these schemas (local Ollama stays
 *     entirely client-side as before).
 *   - The key is stored encrypted on the server and never returned to the
 *     client. The client can only GET a `keySet: boolean` flag.
 */

// ---------------------------------------------------------------------------
// AI key configuration (stored server-side, encrypted at rest)
// ---------------------------------------------------------------------------

/**
 * Save or update the AI key configuration for the authenticated user.
 * The `apiKey` is encrypted before being written to storage.
 *
 * `gateway` selects the outbound gateway the server will use:
 *   - `openrouter` (default): https://openrouter.ai/api/v1 - 400+ models
 *   - `custom`: a direct base URL (Anthropic/OpenAI/any OpenAI-compat endpoint)
 */
export const aiConfigRequestSchema = z.object({
  /**
   * The API key to store. Required when saving; the client sends it once over
   * TLS and it is immediately encrypted before being written to storage.
   */
  apiKey: z.string().min(1).max(1024),
  /**
   * `openrouter` uses https://openrouter.ai/api/v1 (default / recommended).
   * `custom` uses the `baseUrl` field to call a direct provider.
   */
  gateway: z.enum(['openrouter', 'custom']).default('openrouter'),
  /**
   * Base URL for custom gateway (e.g. https://api.anthropic.com/v1 or
   * https://api.openai.com/v1). Required when gateway === 'custom'.
   */
  baseUrl: z
    .string()
    .url()
    .max(2048)
    .refine((u) => /^https?:\/\//i.test(u), 'baseUrl must use http or https')
    .optional(),
  /**
   * Default model to use when the chat request does not specify one.
   * For OpenRouter the model string selects from 400+ provider models
   * (e.g. "openai/gpt-4o-mini", "anthropic/claude-sonnet-4-5").
   */
  model: z.string().min(1).max(256).optional(),
  /**
   * Per-key daily spend cap in USD. `0` or omitted means no monetary cap (the
   * request cap still applies). The server tracks accrued spend in a durable
   * per-user/day window and refuses further calls once this is reached (429).
   * See `docs/ai-bff.md` §4. Caps are "soft": a single in-flight call may cross
   * the cap (cost is unknown until generation completes); the next is refused.
   */
  spendCapUsd: z.number().min(0).max(100_000).optional(),
  /**
   * Per-user daily request cap. Overrides the server's GRAPHVAULT_AI_DAILY_CAP
   * env default for this user. `0` means unlimited. Resets at UTC midnight.
   */
  dailyRequestCap: z.number().int().min(0).max(1_000_000).optional(),
});
export type AiConfigRequest = z.infer<typeof aiConfigRequestSchema>;

/**
 * Live status of the per-user daily spend/request window, returned (non-secret)
 * by GET /v1/ai/config so the client can render a budget meter and disable the
 * send button before a doomed call. See `docs/ai-bff.md` §2.2 / §4.
 *   - `ok`:       under 80% of the configured cap
 *   - `warning`:  at or over 80%
 *   - `exceeded`: at or over 100% (further calls 429 until the window resets)
 */
export const aiSpendCapStateSchema = z.object({
  state: z.enum(['ok', 'warning', 'exceeded']),
  /** USD accrued in the current window (provider-reported cost; 0 if unknown). */
  windowSpentUsd: z.number(),
  /** Requests committed in the current window. */
  windowRequests: z.number().int(),
  /** ISO-8601 timestamp when the window resets (next UTC midnight). */
  windowResetsAt: z.string(),
});
export type AiSpendCapState = z.infer<typeof aiSpendCapStateSchema>;

/**
 * Non-secret subset returned by GET /v1/ai/config.
 * The apiKey is NEVER returned to the client.
 */
export const aiConfigInfoSchema = z.object({
  /** Whether an API key has been saved. Never returns the key value. */
  keySet: z.boolean(),
  gateway: z.enum(['openrouter', 'custom']),
  /** Defined only when gateway === 'custom'. */
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  /** ISO-8601 timestamp when the config was last saved. */
  updatedAt: z.string(),
  /** The configured per-key daily spend cap in USD (not a secret). */
  spendCapUsd: z.number().optional(),
  /** Live status of the current daily window (budget meter + send-button gate). */
  spendCapState: aiSpendCapStateSchema.optional(),
});
export type AiConfigInfo = z.infer<typeof aiConfigInfoSchema>;

// ---------------------------------------------------------------------------
// AI chat request / response (proxied via the server)
// ---------------------------------------------------------------------------

export const aiChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1).max(64_000),
});
export type AiChatMessage = z.infer<typeof aiChatMessageSchema>;

export const aiChatRequestSchema = z.object({
  messages: z.array(aiChatMessageSchema).min(1).max(100),
  /**
   * Optional model override for this request. Overrides the per-user default
   * stored in the AI config. Useful for one-off model experiments.
   */
  model: z.string().min(1).max(256).optional(),
  /**
   * Opt into a streaming (Server-Sent Events) response. Default `false` keeps
   * the buffered JSON response below. When `true` the server responds with
   * `text/event-stream` carrying `aiStreamEvent` frames. See `docs/ai-bff.md`
   * §2.5 / §3.
   */
  stream: z.boolean().optional(),
});
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;

/**
 * Token / cost accounting reported by the upstream gateway. `costUsd` is the
 * provider-reported dollar cost when available; omitted (or 0) when the gateway
 * does not return one, in which case only the request cap applies for the call.
 */
export const aiUsageSchema = z.object({
  promptTokens: z.number().int().optional(),
  completionTokens: z.number().int().optional(),
  costUsd: z.number().optional(),
});
export type AiUsage = z.infer<typeof aiUsageSchema>;

export const aiChatResponseSchema = z.object({
  content: z.string(),
  /** The model that generated this response (as reported by the upstream). */
  model: z.string().optional(),
  /** Token/cost accounting, echoed so the client can update its budget meter. */
  usage: aiUsageSchema.optional(),
});
export type AiChatResponse = z.infer<typeof aiChatResponseSchema>;

// ---------------------------------------------------------------------------
// AI streaming (SSE) event frames - server → browser
// ---------------------------------------------------------------------------

/**
 * One frame of the SSE stream emitted by POST /v1/ai/chat when `stream: true`.
 * The server translates the upstream OpenAI-compatible stream into this stable,
 * provider-agnostic shape (it never pipes the raw upstream JSON to the browser).
 * The web client validates every inbound frame against this schema.
 * See `docs/ai-bff.md` §2.5.
 *
 *   - `delta`: an incremental chunk of generated text.
 *   - `usage`: terminal token/cost accounting (used to update the budget meter).
 *   - `done`:  generation finished cleanly; carries the resolved model string.
 *   - `error`: a sanitised error (key redacted); the stream then closes.
 */
export const aiStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), content: z.string() }),
  z.object({ type: z.literal('usage'), usage: aiUsageSchema }),
  z.object({ type: z.literal('done'), model: z.string().optional() }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
  }),
]);
export type AiStreamEvent = z.infer<typeof aiStreamEventSchema>;
