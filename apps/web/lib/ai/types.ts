/**
 * Privacy-first AI provider abstraction.
 *
 * Three-tier privacy spectrum — OFF by default:
 *
 *   off    — no AI, no network, ever. DEFAULT.
 *   local  — OpenAI-compatible endpoint on localhost (e.g. Ollama). Notes never
 *            leave the machine. Key-free.
 *   server — BYO-key via the user's self-hosted GraphVault server (BFF proxy).
 *            The browser sends the prompt to POST /v1/ai/chat on the GV server;
 *            the server adds the encrypted API key and forwards to the gateway
 *            (OpenRouter default, or a custom base URL). The API key NEVER
 *            touches the browser — it lives on the server, encrypted at rest
 *            with AES-256-GCM + per-user HKDF. Requires a signed-in session.
 *
 * Key security rules enforced throughout this module:
 *  - No network call is made unless the provider is explicitly 'local' or 'server'
 *    and configured.
 *  - For `server` mode: the browser never sees or stores the API key at any point.
 *  - Settings (kind, local endpoint, model) are stored in sessionStorage (cleared
 *    on tab/browser close).
 */

/** The three privacy tiers. */
export type AIProviderKind = 'off' | 'local' | 'server';

/**
 * Serialisable AI settings — stored in sessionStorage (cleared when the tab or
 * browser closes). No API keys are ever stored here — for `server` mode the key
 * lives on the GV server encrypted at rest.
 */
export interface AISettings {
  /** Provider kind. Defaults to 'off'. */
  kind: AIProviderKind;

  // --- local ---
  /** Base URL for the OpenAI-compatible local endpoint, e.g. http://localhost:11434/v1 */
  localEndpoint: string;
  /** Model name for the local endpoint, e.g. 'llama3' or 'mistral'. */
  localModel: string;

  // --- server ---
  /**
   * Optional model override for the server proxy. If empty, the server will use
   * its configured default model (stored in the AI config on the server,
   * defaulting to "openai/gpt-4o-mini" on OpenRouter).
   */
  serverModel: string;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  kind: 'off',
  localEndpoint: 'http://localhost:11434/v1',
  localModel: 'llama3',
  serverModel: '',
};

/** Redact all but the first 4 chars of a key for display in error messages or UI. */
export function redactKey(key: string): string {
  if (!key || key.length <= 4) return '****';
  return key.slice(0, 4) + '****';
}

/**
 * A single message in the conversation (OpenAI/Anthropic format).
 * We use a minimal shared interface — just role + content.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Actions the assistant can perform over the user's vault content. */
export type AssistantAction =
  | 'summarize'
  | 'find-related'
  | 'suggest-links'
  | 'suggest-tags'
  | 'outline';

/** What context will be sent to the provider (shown to user before sending). */
export interface SendContext {
  /** Human-readable description, e.g. "current note (2 048 chars)". */
  description: string;
  /** The actual text that will be included in the prompt. */
  text: string;
}
