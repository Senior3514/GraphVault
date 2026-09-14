/**
 * Tests for the SSE consumption layer (lib/ai/stream.ts).
 *
 * Covers:
 *  1. parseSseRecords - record splitting, multi-line data, comments, partials.
 *  2. parseAiStreamRecord - schema validation, [DONE] sentinel, event-name
 *     synthesis, malformed JSON.
 *  3. readAiStream - end-to-end dispatch from a ReadableStream, terminal frame
 *     handling, abort, and chunk boundaries that split a frame.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSseRecords, parseAiStreamRecord, readAiStream } from './stream.js';
import type { AiStreamEvent } from '@graphvault/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ReadableStream that emits the given string chunks (utf-8). */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// 1. parseSseRecords
// ---------------------------------------------------------------------------

describe('parseSseRecords()', () => {
  it('splits two complete records and returns no remainder', () => {
    const buf = 'event: delta\ndata: {"a":1}\n\nevent: done\ndata: {"b":2}\n\n';
    const { records, rest } = parseSseRecords(buf);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], { event: 'delta', data: '{"a":1}' });
    assert.deepEqual(records[1], { event: 'done', data: '{"b":2}' });
    assert.equal(rest, '');
  });

  it('returns a trailing partial record as rest', () => {
    const buf = 'event: delta\ndata: {"a":1}\n\nevent: del';
    const { records, rest } = parseSseRecords(buf);
    assert.equal(records.length, 1);
    assert.equal(rest, 'event: del');
  });

  it('joins multiple data: lines with a newline', () => {
    const buf = 'data: line1\ndata: line2\n\n';
    const { records } = parseSseRecords(buf);
    assert.equal(records[0].data, 'line1\nline2');
  });

  it('skips comment / heartbeat lines', () => {
    const buf = ':keepalive\nevent: delta\ndata: {"x":1}\n\n';
    const { records } = parseSseRecords(buf);
    assert.equal(records.length, 1);
    assert.equal(records[0].event, 'delta');
  });

  it('defaults event to "message" when omitted', () => {
    const buf = 'data: {"x":1}\n\n';
    const { records } = parseSseRecords(buf);
    assert.equal(records[0].event, 'message');
  });

  it('normalises CRLF line endings', () => {
    const buf = 'event: delta\r\ndata: {"x":1}\r\n\r\n';
    const { records, rest } = parseSseRecords(buf);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], { event: 'delta', data: '{"x":1}' });
    assert.equal(rest, '');
  });
});

// ---------------------------------------------------------------------------
// 2. parseAiStreamRecord
// ---------------------------------------------------------------------------

describe('parseAiStreamRecord()', () => {
  it('parses a typed delta payload', () => {
    const ev = parseAiStreamRecord({ event: 'delta', data: '{"type":"delta","content":"hi"}' });
    assert.deepEqual(ev, { type: 'delta', content: 'hi' });
  });

  it('synthesises type from the event name when payload omits it', () => {
    const ev = parseAiStreamRecord({ event: 'delta', data: '{"content":"hi"}' });
    assert.deepEqual(ev, { type: 'delta', content: 'hi' });
  });

  it('parses a usage frame', () => {
    const ev = parseAiStreamRecord({
      event: 'usage',
      data: '{"type":"usage","usage":{"costUsd":0.0007,"promptTokens":10}}',
    });
    assert.equal(ev?.type, 'usage');
    assert.equal((ev as Extract<AiStreamEvent, { type: 'usage' }>).usage.costUsd, 0.0007);
  });

  it('parses an error frame', () => {
    const ev = parseAiStreamRecord({
      event: 'error',
      data: '{"type":"error","code":"RATE_LIMITED","message":"cap reached"}',
    });
    assert.deepEqual(ev, { type: 'error', code: 'RATE_LIMITED', message: 'cap reached' });
  });

  it('returns null for the [DONE] sentinel', () => {
    assert.equal(parseAiStreamRecord({ event: 'message', data: '[DONE]' }), null);
  });

  it('returns null for an empty data line', () => {
    assert.equal(parseAiStreamRecord({ event: 'message', data: '   ' }), null);
  });

  it('throws on malformed JSON', () => {
    assert.throws(() => parseAiStreamRecord({ event: 'delta', data: '{not json' }));
  });

  it('throws on a payload that fails schema validation', () => {
    // `delta` requires a string `content`; a number must be rejected.
    assert.throws(() =>
      parseAiStreamRecord({ event: 'delta', data: '{"type":"delta","content":123}' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. readAiStream
// ---------------------------------------------------------------------------

describe('readAiStream()', () => {
  it('dispatches delta, usage, and done events in order', async () => {
    const body = streamFromChunks([
      'event: delta\ndata: {"type":"delta","content":"Hello "}\n\n',
      'event: delta\ndata: {"type":"delta","content":"world"}\n\n',
      'event: usage\ndata: {"type":"usage","usage":{"costUsd":0.001}}\n\n',
      'event: done\ndata: {"type":"done","model":"openai/gpt-4o-mini"}\n\n',
    ]);

    const deltas: string[] = [];
    let cost = -1;
    let doneModel = '';
    await readAiStream(body, {
      onDelta: (c) => deltas.push(c),
      onUsage: (u) => {
        cost = u.costUsd ?? -1;
      },
      onDone: (m) => {
        doneModel = m ?? '';
      },
    });

    assert.deepEqual(deltas, ['Hello ', 'world']);
    assert.equal(cost, 0.001);
    assert.equal(doneModel, 'openai/gpt-4o-mini');
  });

  it('reassembles a frame split across two chunks', async () => {
    const body = streamFromChunks([
      'event: delta\ndata: {"type":"del',
      'ta","content":"split"}\n\n',
      'event: done\ndata: {"type":"done"}\n\n',
    ]);
    const deltas: string[] = [];
    await readAiStream(body, { onDelta: (c) => deltas.push(c) });
    assert.deepEqual(deltas, ['split']);
  });

  it('dispatches an error frame and stops', async () => {
    const body = streamFromChunks([
      'event: error\ndata: {"type":"error","code":"RATE_LIMITED","message":"cap"}\n\n',
      // This delta must never be dispatched - the stream stops on error.
      'event: delta\ndata: {"type":"delta","content":"after"}\n\n',
    ]);
    const deltas: string[] = [];
    let errCode = '';
    await readAiStream(body, {
      onDelta: (c) => deltas.push(c),
      onError: (code) => {
        errCode = code;
      },
    });
    assert.equal(errCode, 'RATE_LIMITED');
    assert.deepEqual(deltas, []);
  });

  it('honours an already-aborted signal without dispatching', async () => {
    const body = streamFromChunks(['event: delta\ndata: {"type":"delta","content":"x"}\n\n']);
    const controller = new AbortController();
    controller.abort();
    const deltas: string[] = [];
    await readAiStream(body, { onDelta: (c) => deltas.push(c) }, controller.signal);
    assert.deepEqual(deltas, []);
  });

  it('flushes a final record without a trailing blank line at EOF', async () => {
    const body = streamFromChunks(['event: delta\ndata: {"type":"delta","content":"tail"}']);
    const deltas: string[] = [];
    await readAiStream(body, { onDelta: (c) => deltas.push(c) });
    assert.deepEqual(deltas, ['tail']);
  });
});
