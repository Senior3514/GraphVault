/**
 * Provider implementations for the AI assistant.
 *
 * Privacy contract:
 *  - `kind === 'off'`   → chat() throws immediately, zero network.
 *  - `kind === 'local'` → fetch() to the user-configured localhost endpoint only.
 *  - `kind === 'byok'`  → fetch() to the user's own Anthropic or OpenAI account.
 *
 * No telemetry, no fallback to any GraphVault-hosted service, no silent network.
 *
 * Key handling:
 *  - Keys are passed in at call time from sessionStorage — never stored in module scope.
 *  - They are NEVER included in error messages, console.log, or the DOM.
 *  - The redactKey() helper is available for display-only contexts.
 *
 * Response validation:
 *  - All provider responses are structurally validated before use.
 *  - A type guard rejects malformed responses with a descriptive (but key-free) error.
 */

import type { AISettings, ChatMessage } from './types';
import { redactKey } from './types';

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

interface AnthropicResponse {
  content: { type: string; text: string }[];
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

function isAnthropicResponse(r: unknown): r is AnthropicResponse {
  return (
    typeof r === 'object' &&
    r !== null &&
    Array.isArray((r as AnthropicResponse).content) &&
    (r as AnthropicResponse).content.length > 0 &&
    (r as AnthropicResponse).content.some(
      (c) => typeof c === 'object' && c !== null && c.type === 'text' && typeof c.text === 'string',
    )
  );
}

// ---------------------------------------------------------------------------
// Error sanitisation — strip any potential key leaks from error strings
// ---------------------------------------------------------------------------

/** Remove any string resembling an API key from an error message. */
function sanitiseErrorMessage(msg: string, key: string): string {
  if (!key) return msg;
  // Replace the full key value (in case it leaked into a server error response).
  let safe = msg.replaceAll(key, '[REDACTED]');
  // Also remove the first 4 chars if they appear (partial key).
  const prefix = key.slice(0, 8);
  if (prefix.length >= 4) {
    safe = safe.replaceAll(prefix, '[REDACTED]');
  }
  return safe;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat (used by both 'local' and 'byok/openai-compatible')
// ---------------------------------------------------------------------------

async function callOpenAICompatible(
  endpoint: string,
  model: string,
  messages: ChatMessage[],
  apiKey: string,
): Promise<string> {
  const url = endpoint.replace(/\/$/, '') + '/chat/completions';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  // For local Ollama, no auth header is needed. For OpenAI-compat cloud, it is.
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

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
    // Never include the key in the thrown message.
    throw new Error(`AI provider unreachable (${redactKey(apiKey)}): ${sanitiseErrorMessage(msg, apiKey)}`);
  }

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore read errors */
    }
    throw new Error(
      `AI provider returned ${res.status}: ${sanitiseErrorMessage(body.slice(0, 200), apiKey)}`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('AI provider returned non-JSON response.');
  }

  if (!isOpenAIResponse(json)) {
    throw new Error('AI provider response has unexpected shape (missing choices[0].message.content).');
  }

  return json.choices[0].message.content.trim();
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

async function callAnthropic(
  model: string,
  messages: ChatMessage[],
  apiKey: string,
): Promise<string> {
  // Split system messages out — Anthropic uses a top-level system field.
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversationMessages = messages.filter((m) => m.role !== 'system');

  const systemPrompt = systemMessages.map((m) => m.content).join('\n\n');

  const url = 'https://api.anthropic.com/v1/messages';

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt || undefined,
        messages: conversationMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : 'Network error';
    throw new Error(`Anthropic API unreachable: ${sanitiseErrorMessage(msg, apiKey)}`);
  }

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(
      `Anthropic API returned ${res.status}: ${sanitiseErrorMessage(body.slice(0, 200), apiKey)}`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('Anthropic API returned non-JSON response.');
  }

  if (!isAnthropicResponse(json)) {
    throw new Error('Anthropic API response has unexpected shape (missing content[].text).');
  }

  const textBlock = json.content.find((c) => c.type === 'text');
  if (!textBlock) {
    throw new Error('Anthropic API response contained no text block.');
  }

  return textBlock.text.trim();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Send messages to the configured AI provider and return the text response.
 *
 * SAFETY INVARIANT: if settings.kind === 'off' this function throws immediately
 * without any network activity. This is the hard guard that makes the default
 * state fully offline.
 *
 * @throws {Error} if kind is 'off', if the provider is misconfigured, or if
 *   the network call fails. Error messages never contain the raw API key.
 */
export async function chat(settings: AISettings, messages: ChatMessage[]): Promise<string> {
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
      '', // no key needed for local
    );
  }

  // byok
  if (!settings.byokKey.trim()) {
    throw new Error('No API key configured. Add your key in Settings → AI assistant.');
  }

  if (settings.byokBackend === 'anthropic') {
    return callAnthropic(
      settings.byokModel.trim() || 'claude-sonnet-4-6',
      messages,
      settings.byokKey.trim(),
    );
  }

  // byok / openai-compatible
  if (!settings.byokEndpoint.trim()) {
    throw new Error('OpenAI-compatible endpoint is not configured. Check Settings → AI assistant.');
  }

  return callOpenAICompatible(
    settings.byokEndpoint.trim(),
    settings.byokModel.trim() || 'gpt-4o-mini',
    messages,
    settings.byokKey.trim(),
  );
}
