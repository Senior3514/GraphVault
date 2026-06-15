/**
 * Privacy-first AI provider abstraction.
 *
 * Three-tier privacy spectrum — OFF by default:
 *
 *   off   — no AI, no network, ever. DEFAULT.
 *   local — OpenAI-compatible endpoint on localhost (e.g. Ollama). Notes never leave the machine.
 *   byok  — bring-your-own-key: Anthropic Messages API or OpenAI-compatible Chat Completions.
 *           Notes are sent to the user's own key/account, not to GraphVault's infrastructure.
 *
 * Key security rules enforced throughout this module:
 *  - No network call is made unless provider is explicitly 'local' or 'byok' and configured.
 *  - Keys are stored in sessionStorage only and are never logged or included in error messages.
 *  - AI output is always passed through the DOMPurify-sanitised markdown renderer before display.
 *  - All provider responses are validated (type guards) before use.
 */

/** The three privacy tiers. */
export type AIProviderKind = 'off' | 'local' | 'byok';

/** Which cloud API to use when provider is 'byok'. */
export type ByokBackend = 'anthropic' | 'openai-compatible';

/**
 * Serialisable AI settings — stored in sessionStorage (never localStorage so
 * the key is cleared when the tab/browser closes).
 */
export interface AISettings {
  /** Provider kind. Defaults to 'off'. */
  kind: AIProviderKind;

  // --- local ---
  /** Base URL for the OpenAI-compatible local endpoint, e.g. http://localhost:11434/v1 */
  localEndpoint: string;
  /** Model name for the local endpoint, e.g. 'llama3' or 'mistral'. */
  localModel: string;

  // --- byok ---
  byokBackend: ByokBackend;
  /**
   * Raw API key — kept only in sessionStorage; never in logs or the DOM.
   * When reading for display, always redact (see redactKey()).
   */
  byokKey: string;
  /**
   * API endpoint for OpenAI-compatible backend.
   * Ignored when byokBackend === 'anthropic' (endpoint is always the Anthropic API).
   */
  byokEndpoint: string;
  /** Model name. Defaults to a current Claude model for Anthropic, 'gpt-4o-mini' for OpenAI. */
  byokModel: string;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  kind: 'off',
  localEndpoint: 'http://localhost:11434/v1',
  localModel: 'llama3',
  byokBackend: 'anthropic',
  byokKey: '',
  byokEndpoint: 'https://api.openai.com/v1',
  byokModel: 'claude-sonnet-4-6',
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
