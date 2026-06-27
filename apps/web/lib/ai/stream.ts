/**
 * Server-Sent Events (SSE) consumption for the AI server proxy (BFF).
 *
 * When the active provider is the `server` BFF and streaming is requested, the
 * GraphVault server responds to POST /v1/ai/chat with `text/event-stream`. Each
 * SSE record carries a JSON payload that the server has already translated into
 * the stable, provider-agnostic shape described by `aiStreamEventSchema` in
 * `@graphvault/shared` (it never pipes the raw upstream OpenAI JSON). See
 * `docs/ai-bff.md` §2.5 / §3.
 *
 * This module is split into two layers so the parsing logic is unit-testable
 * without any network:
 *
 *   1. `parseSseRecords` — a pure generator that turns a raw SSE text buffer
 *      into discrete `{ event, data }` records, handling multi-line `data:`
 *      fields, `:comment` heartbeats, and partial trailing records.
 *   2. `readAiStream` — wires a `ReadableStream<Uint8Array>` (from `fetch`) and
 *      a `TextDecoder` into the parser, validates every payload against
 *      `aiStreamEventSchema`, and invokes typed callbacks.
 *
 * Security / privacy invariants (carried from the rest of the AI feature):
 *   - No payload is ever logged; the caller decides what to render.
 *   - `error` frames are surfaced as `AiStreamEvent` and never re-thrown with an
 *     unsanitised body — the server has already redacted the key (`docs/ai-bff.md`
 *     §6/§7). We pass the server's `{code,message}` through verbatim.
 */

import { aiStreamEventSchema, type AiStreamEvent } from '@graphvault/shared';

/** A single parsed SSE record (one `event:`/`data:` block). */
export interface SseRecord {
  /** The `event:` field value, or `'message'` when omitted (SSE default). */
  event: string;
  /** The concatenated `data:` field value (multiple `data:` lines joined by \n). */
  data: string;
}

/**
 * Pure SSE record splitter.
 *
 * Accumulates `buffer` (which may contain any number of complete records plus a
 * partial trailing one) and yields each complete record. Records are separated
 * by a blank line (`\n\n`). The trailing partial fragment (text after the last
 * blank line) is returned via the `rest` out-param so the caller can prepend it
 * to the next chunk.
 *
 * `:` comment lines (SSE heartbeats / keepalives) are skipped entirely.
 */
export function parseSseRecords(buffer: string): { records: SseRecord[]; rest: string } {
  // Normalise CRLF → LF so the blank-line split is robust across proxies.
  const normalised = buffer.replace(/\r\n/g, '\n');
  const parts = normalised.split('\n\n');
  // The final element is an incomplete record (no terminating blank line yet).
  const rest = parts.pop() ?? '';

  const records: SseRecord[] = [];
  for (const block of parts) {
    if (block.trim() === '') continue;
    let event = 'message';
    const dataLines: string[] = [];
    for (const rawLine of block.split('\n')) {
      // Heartbeat / comment line — ignore.
      if (rawLine.startsWith(':')) continue;
      const colon = rawLine.indexOf(':');
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      // Per the SSE spec a single leading space after the colon is stripped.
      let value = colon === -1 ? '' : rawLine.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        dataLines.push(value);
      }
      // `id` / `retry` fields are not used by this protocol — ignore.
    }
    records.push({ event, data: dataLines.join('\n') });
  }
  return { records, rest };
}

/**
 * Parse one SSE record's JSON `data` payload into a validated `AiStreamEvent`.
 *
 * Returns `null` for records that carry no usable payload (e.g. an empty data
 * line or `[DONE]` sentinel). Throws if the JSON is malformed or fails schema
 * validation — the caller treats that as a stream protocol error.
 */
export function parseAiStreamRecord(record: SseRecord): AiStreamEvent | null {
  const data = record.data.trim();
  if (!data || data === '[DONE]') return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new Error('AI stream sent a malformed (non-JSON) frame.');
  }
  // The server emits a discriminated `type` field. If a transitional server is
  // still using only the `event:` name (delta/usage/done/error) without a `type`
  // in the payload, synthesise it from the event name so older/newer servers
  // interoperate. The shared schema remains the single source of truth.
  const withType =
    json && typeof json === 'object' && !('type' in (json as Record<string, unknown>))
      ? { type: record.event, ...(json as Record<string, unknown>) }
      : json;
  const parsed = aiStreamEventSchema.safeParse(withType);
  if (!parsed.success) {
    throw new Error('AI stream sent a frame that failed schema validation.');
  }
  return parsed.data;
}

/** Callbacks invoked as the stream is consumed. All are optional. */
export interface AiStreamHandlers {
  /** Incremental text chunk — append to the rendered output. */
  onDelta?: (content: string) => void;
  /** Terminal token/cost accounting — update the budget meter. */
  onUsage?: (usage: Extract<AiStreamEvent, { type: 'usage' }>['usage']) => void;
  /** Generation finished cleanly; carries the resolved model string. */
  onDone?: (model?: string) => void;
  /** A sanitised error frame from the server (key already redacted). */
  onError?: (code: string, message: string) => void;
}

/**
 * Consume an SSE stream from a `fetch` Response body, validating every frame
 * against the shared schema and dispatching to typed handlers.
 *
 * Honours an `AbortSignal` so a closing panel (or a "Stop" button) tears the
 * stream down promptly — important so a closed view does not keep the upstream
 * generation (and the user's budget) running.
 *
 * @param body  The `ReadableStream<Uint8Array>` from `response.body`.
 * @param handlers  Typed event callbacks.
 * @param signal  Optional abort signal; when aborted, reading stops and the
 *   reader is released.
 */
export async function readAiStream(
  body: ReadableStream<Uint8Array>,
  handlers: AiStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => {
    void reader.cancel().catch(() => {
      /* reader may already be closed */
    });
  };
  if (signal) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { records, rest } = parseSseRecords(buffer);
      buffer = rest;
      for (const record of records) {
        const event = parseAiStreamRecord(record);
        if (!event) continue;
        dispatch(event, handlers);
        if (event.type === 'done' || event.type === 'error') {
          // Terminal frame — stop reading. Cancel releases the socket.
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
    // Flush any complete record left in the buffer at EOF.
    const tail = buffer + decoder.decode();
    const { records } = parseSseRecords(tail + '\n\n');
    for (const record of records) {
      const event = parseAiStreamRecord(record);
      if (event) dispatch(event, handlers);
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function dispatch(event: AiStreamEvent, handlers: AiStreamHandlers): void {
  switch (event.type) {
    case 'delta':
      handlers.onDelta?.(event.content);
      break;
    case 'usage':
      handlers.onUsage?.(event.usage);
      break;
    case 'done':
      handlers.onDone?.(event.model);
      break;
    case 'error':
      handlers.onError?.(event.code, event.message);
      break;
  }
}
