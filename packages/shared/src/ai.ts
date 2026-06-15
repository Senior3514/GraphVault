import { z } from 'zod';

/**
 * Shared zod schemas for the AI proxy feature.
 *
 * Security model:
 *   - The `server` provider mode sends prompts to the GraphVault server's
 *     POST /v1/ai/chat endpoint (authenticated). The server holds the API key
 *     (encrypted at rest with AES-256-GCM + per-user HKDF — same pattern as
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
 *   - `openrouter` (default): https://openrouter.ai/api/v1 — 400+ models
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
});
export type AiConfigRequest = z.infer<typeof aiConfigRequestSchema>;

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
});
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;

export const aiChatResponseSchema = z.object({
  content: z.string(),
  /** The model that generated this response (as reported by the upstream). */
  model: z.string().optional(),
});
export type AiChatResponse = z.infer<typeof aiChatResponseSchema>;
