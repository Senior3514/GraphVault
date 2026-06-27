/**
 * Provider implementations for the AI assistant.
 *
 * Privacy contract:
 *  - `kind === 'off'`    → chat() throws immediately, zero network.
 *  - `kind === 'local'`  → fetch() to the user-configured localhost endpoint only.
 *                          No key is sent. Notes never leave the machine.
 *  - `kind === 'server'` → fetch() to the user's self-hosted GV server's
 *                          POST /v1/ai/chat endpoint (bearer-token authenticated).
 *                          The prompt travels to the server; the server adds the
 *                          encrypted API key and forwards to the gateway
 *                          (OpenRouter default, or a custom base URL). The API
 *                          key NEVER touches this browser at any point.
 *
 * No telemetry, no fallback to any GraphVault-hosted service, no silent network.
 *
 * Response validation:
 *  - All provider responses are structurally validated before use.
 *  - A type guard rejects malformed responses with a descriptive error.
 */

import type { AISettings, ChatMessage } from './types';
import { readAiStream, type AiStreamHandlers } from './stream';

/** Maximum characters we'll send in a single prompt to avoid huge payloads. */
const MAX_CONTEXT_CHARS = 32_000;

/**
 * Truncate note content to the safe limit, appending a note so the model knows
 * it saw a partial document.
 */
export function truncateContext(text: string): string {
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return text.slice(0, MAX_CONTEXT_CHARS) + '\n\n[... content truncated for length ...]';
}

// ---------------------------------------------------------------------------
// Response type guards
// ---------------------------------------------------------------------------

interface OpenAIResponse {
  choices: { message: { content: string } }[];
}

function isOpenAIResponse(r: unknown): r is OpenAIResponse {
  return (
    typeof r === 'object' &&
    r !== null &&
    Array.isArray((r as OpenAIResponse).choices) &&
    (r as OpenAIResponse).choices.length > 0 &&
    typeof (r as OpenAIResponse).choices[0]?.message?.content === 'string'
  );
}

/** Shape returned by the GV server proxy at POST /v1/ai/chat. */
interface ServerChatResponse {
  content: string;
  model?: string;
}

function isServerChatResponse(r: unknown): r is ServerChatResponse {
  return (
    typeof r === 'object' && r !== null && typeof (r as ServerChatResponse).content === 'string'
  );
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat (used by 'local' only)
// ---------------------------------------------------------------------------

async function callOpenAICompatible(
  endpoint: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const url = endpoint.replace(/\/$/, '') + '/chat/completions';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 1024,
        temperature: 0.3,
      }),
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : 'Network error';
    throw new Error(`Local AI provider unreachable (${endpoint}): ${msg}`);
  }

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore read errors */
    }
    throw new Error(`Local AI provider returned ${res.status}: ${body.slice(0, 200)}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('Local AI provider returned non-JSON response.');
  }

  if (!isOpenAIResponse(json)) {
    throw new Error(
      'Local AI provider response has unexpected shape (missing choices[0].message.content).',
    );
  }

  return json.choices[0].message.content.trim();
}

// ---------------------------------------------------------------------------
// Server proxy chat (used by 'server' mode)
// ---------------------------------------------------------------------------

/**
 * Call the GV server's AI proxy endpoint. The bearer token authenticates the
 * request; the server adds the stored API key server-side. The key is NEVER
 * sent from or stored in the browser.
 *
 * @param serverUrl - Base URL of the GV server (e.g. http://127.0.0.1:4000)
 * @param bearerToken - The user's GV session token
 * @param messages - Chat messages to send
 * @param model - Optional model override (sent to the server proxy)
 */
async function callServerProxy(
  serverUrl: string,
  bearerToken: string,
  messages: ChatMessage[],
  model?: string,
): Promise<string> {
  const url = serverUrl.replace(/\/+$/, '') + '/v1/ai/chat';

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ messages, ...(model ? { model } : {}) }),
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : 'Network error';
    throw new Error(`GraphVault server unreachable (${serverUrl}): ${msg}`);
  }

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    // Attempt to extract the server error message from the standard error envelope.
    let errorMsg = `Server returned ${res.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) errorMsg = parsed.error.message;
    } catch {
      /* not JSON - use status */
    }
    throw new Error(`AI proxy: ${errorMsg}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('AI proxy returned non-JSON response.');
  }

  if (!isServerChatResponse(json)) {
    throw new Error('AI proxy response has unexpected shape (missing content).');
  }

  return json.content.trim();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Options for the `server` provider mode. The caller (AssistantPanel) passes
 * the current GV session token and server URL so this module never reads them
 * from storage directly - keeping the coupling explicit.
 */
export interface ServerProviderOptions {
  serverUrl: string;
  bearerToken: string;
}

/**
 * Send messages to the configured AI provider and return the text response.
 *
 * SAFETY INVARIANT: if settings.kind === 'off' this function throws immediately
 * without any network activity. This is the hard guard that makes the default
 * state fully offline.
 *
 * For `server` mode, `serverOpts` must be provided (serverUrl + bearerToken).
 *
 * @throws {Error} if kind is 'off', if the provider is misconfigured, or if
 *   the network call fails. Error messages never contain raw API keys.
 */
export async function chat(
  settings: AISettings,
  messages: ChatMessage[],
  serverOpts?: ServerProviderOptions,
): Promise<string> {
  if (settings.kind === 'off') {
    throw new Error(
      'AI assistant is disabled. Enable a provider in Settings → AI assistant to use this feature.',
    );
  }

  if (settings.kind === 'local') {
    if (!settings.localEndpoint.trim()) {
      throw new Error('Local AI endpoint is not configured. Check Settings → AI assistant.');
    }
    return callOpenAICompatible(
      settings.localEndpoint.trim(),
      settings.localModel.trim() || 'llama3',
      messages,
    );
  }

  // server mode
  if (!serverOpts?.bearerToken) {
    throw new Error(
      'Sign in to your GraphVault server to use the AI proxy (server mode). ' +
        'Go to Settings → Account.',
    );
  }
  if (!serverOpts.serverUrl) {
    throw new Error('GraphVault server URL is not configured. Check Settings → Sync server.');
  }

  return callServerProxy(
    serverOpts.serverUrl,
    serverOpts.bearerToken,
    messages,
    settings.serverModel.trim() || undefined,
  );
}

// ---------------------------------------------------------------------------
// Streaming server proxy chat (used by 'server' mode when streaming is enabled)
// ---------------------------------------------------------------------------

/**
 * Stream a chat completion from the GV server's AI proxy via Server-Sent Events.
 *
 * Only the `server` (BFF) mode supports streaming - the key never touches the
 * browser; the server adds it and relays a clean, provider-agnostic SSE stream
 * (`delta`/`usage`/`done`/`error`). Each frame is validated against the shared
 * `aiStreamEventSchema` inside `readAiStream`. See `docs/ai-bff.md` §2.5.
 *
 * SAFETY INVARIANT: if `settings.kind !== 'server'` this throws immediately,
 * without any network activity - there is no streaming path for `off` or `local`.
 *
 * @param settings   Active AI settings (must be `kind: 'server'`).
 * @param messages   Chat messages to send.
 * @param serverOpts Server URL + bearer token (required for `server` mode).
 * @param handlers   Typed SSE event callbacks (delta/usage/done/error).
 * @param signal     Optional abort signal - aborting tears down the stream and
 *   the underlying request so a closed view stops burning the user's budget.
 * @throws {Error} when not in `server` mode, when misconfigured, or when the
 *   HTTP request itself fails before the stream opens. Error messages never
 *   contain raw API keys (the key is never present in the browser).
 */
export async function chatStream(
  settings: AISettings,
  messages: ChatMessage[],
  serverOpts: ServerProviderOptions,
  handlers: AiStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  if (settings.kind === 'off') {
    throw new Error(
      'AI assistant is disabled. Enable a provider in Settings → AI assistant to use this feature.',
    );
  }
  if (settings.kind !== 'server') {
    throw new Error('Streaming is only available for the server proxy provider.');
  }
  if (!serverOpts?.bearerToken) {
    throw new Error(
      'Sign in to your GraphVault server to use the AI proxy (server mode). ' +
        'Go to Settings → Account.',
    );
  }
  if (!serverOpts.serverUrl) {
    throw new Error('GraphVault server URL is not configured. Check Settings → Sync server.');
  }

  const model = settings.serverModel.trim() || undefined;
  const url = serverOpts.serverUrl.replace(/\/+$/, '') + '/v1/ai/chat';

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serverOpts.bearerToken}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ messages, stream: true, ...(model ? { model } : {}) }),
      signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return;
    const msg = cause instanceof Error ? cause.message : 'Network error';
    throw new Error(`GraphVault server unreachable (${serverOpts.serverUrl}): ${msg}`);
  }

  if (!res.ok) {
    // The pre-check (e.g. spend/request cap) can refuse before any SSE headers
    // are written, so an error here is a real HTTP status with the standard
    // error envelope. Surface it through onError so the UI handles it uniformly.
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    let code = 'HTTP_ERROR';
    let message = `Server returned ${res.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
      if (parsed.error?.code) code = parsed.error.code;
    } catch {
      /* not JSON - use status */
    }
    handlers.onError?.(code, message);
    return;
  }

  if (!res.body) {
    throw new Error('AI proxy returned an empty streaming response.');
  }

  await readAiStream(res.body, handlers, signal);
}
