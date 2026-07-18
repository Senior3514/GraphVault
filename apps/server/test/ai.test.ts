/**
 * AI proxy route tests.
 *
 * Tests:
 *  1. POST /v1/ai/config - save AI config (key encrypted at rest)
 *  2. GET  /v1/ai/config - retrieve non-secret info (never returns the key)
 *  3. DELETE /v1/ai/config - remove AI config
 *  4. POST /v1/ai/chat - proxy a chat completion (mocked upstream)
 *  5. POST /v1/ai/chat - 404 when no config saved
 *  6. POST /v1/ai/chat - 429 when daily cap exceeded
 *  7. POST /v1/ai/chat - 401 without auth token
 *  8. POST /v1/ai/config - 400 with custom gateway but no baseUrl
 *
 * We mock outbound fetch calls (to the AI provider) via a monkey-patch so no
 * real provider call is made.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { aiStreamEventSchema } from '@graphvault/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { InMemoryStorage } from '../src/store/memory.js';
import {
  __setResolverForTests,
  __setTransportForTests,
  type GuardedTransport,
  type ResolveAllFn,
} from '../src/services/ssrf.js';

let app: FastifyInstance;
let dataDir: string;
let token = '';
let sharedStorage: InMemoryStorage;

// ---------------------------------------------------------------------------
// Mock upstream AI provider
// ---------------------------------------------------------------------------

let restoreTransport: (() => void) | undefined;
let restoreResolver: (() => void) | undefined;

/**
 * A fake OpenRouter / OpenAI-compat response for chat completions, installed as
 * the SSRF transport so the guarded fetch's validate + DNS-pin path still runs.
 */
function makeFakeAiFetch(statusCode = 200): GuardedTransport {
  return async () => {
    if (statusCode !== 200) {
      return new Response(JSON.stringify({ error: 'upstream error' }), { status: statusCode });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'Hello from mock AI' } }],
        model: 'mock/model-v1',
        usage: { prompt_tokens: 12, completion_tokens: 5, cost: 0.0004 },
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
}

/**
 * A fake upstream that emits an OpenAI-compatible SSE stream. Builds a
 * ReadableStream body so the guardedFetch `stream: true` relay path is
 * exercised end-to-end. The optional `secret` is embedded in a mid-stream error
 * frame to prove the relay redacts the key.
 */
function makeFakeAiStream(opts?: {
  cost?: number;
  errorContaining?: string;
  emittedLater?: () => void;
}): GuardedTransport {
  const cost = opts?.cost;
  return async () => {
    const frames: string[] = [];
    frames.push('data: {"model":"mock/stream-v1","choices":[{"delta":{"content":"Hel"}}]}\n\n');
    frames.push('data: {"model":"mock/stream-v1","choices":[{"delta":{"content":"lo!"}}]}\n\n');
    if (opts?.errorContaining) {
      frames.push(`data: {"error":{"message":"boom ${opts.errorContaining}"}}\n\n`);
    }
    const usage: Record<string, number> = { prompt_tokens: 10, completion_tokens: 2 };
    if (typeof cost === 'number') usage.cost = cost;
    frames.push(`data: {"usage":${JSON.stringify(usage)}}\n\n`);
    frames.push('data: [DONE]\n\n');

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
        opts?.emittedLater?.();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}

/** Parse an SSE payload string into an array of { event, data } frames. */
function parseSse(payload: string): { event: string; data: unknown }[] {
  const out: { event: string; data: unknown }[] = [];
  for (const block of payload.split('\n\n')) {
    const lines = block.split('\n');
    let event = '';
    let dataLine = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLine = line.slice('data:'.length).trim();
    }
    if (event && dataLine) {
      out.push({ event, data: JSON.parse(dataLine) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gv-ai-test-'));
  const config = loadConfig({
    GRAPHVAULT_STORAGE: 'memory',
    GRAPHVAULT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    // Use a very low daily cap for the cap test.
    GRAPHVAULT_AI_DAILY_CAP: '3',
  });
  sharedStorage = new InMemoryStorage();
  app = await buildApp(config, { storage: sharedStorage });

  // Register a test user and get a token.
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'ai-tester@example.com', password: 'test-password-123' },
  });
  assert.equal(res.statusCode, 201, `register: ${res.body}`);
  const body = JSON.parse(res.body) as { accessToken: string };
  token = body.accessToken;

  // Install the mock transport + resolver before running tests.
  restoreTransport = __setTransportForTests(makeFakeAiFetch());
  restoreResolver = __setResolverForTests((async () => ['93.184.216.34']) as ResolveAllFn);
});

after(async () => {
  restoreTransport?.();
  restoreResolver?.();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH = () => ({ Authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('POST /v1/ai/config - saves config; key is never returned', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/ai/config',
    headers: { ...AUTH(), 'content-type': 'application/json' },
    payload: {
      apiKey: 'test-api-key-openrouter',
      gateway: 'openrouter',
      model: 'openai/gpt-4o-mini',
    },
  });
  assert.equal(res.statusCode, 201, `save config: ${res.body}`);
  const body = JSON.parse(res.body) as { ok: boolean };
  assert.equal(body.ok, true);
  // Ensure the raw key is not in the response body.
  assert.ok(!res.body.includes('test-api-key-openrouter'), 'key must not be in save response');
});

test('GET /v1/ai/config - returns non-secret info only', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/ai/config',
    headers: AUTH(),
  });
  assert.equal(res.statusCode, 200, `get config: ${res.body}`);
  const body = JSON.parse(res.body) as {
    keySet: boolean;
    gateway: string;
    model: string;
    updatedAt: string;
  };
  assert.equal(body.keySet, true, 'keySet must be true after saving');
  assert.equal(body.gateway, 'openrouter');
  assert.equal(body.model, 'openai/gpt-4o-mini');
  // Ensure the raw key is absolutely not present.
  assert.ok(!res.body.includes('test-api-key-openrouter'), 'raw key must never be returned');
  assert.ok(!('apiKey' in body), 'apiKey field must not be present in response');
});

test('POST /v1/ai/chat - proxies to upstream and returns content', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/ai/chat',
    headers: { ...AUTH(), 'content-type': 'application/json' },
    payload: {
      messages: [{ role: 'user', content: 'Summarize this note.' }],
    },
  });
  assert.equal(res.statusCode, 200, `chat: ${res.body}`);
  const body = JSON.parse(res.body) as { content: string; model?: string };
  assert.equal(body.content, 'Hello from mock AI');
  assert.equal(body.model, 'mock/model-v1');
  // Key must not appear in the chat response.
  assert.ok(!res.body.includes('test-api-key-openrouter'), 'key must not leak in chat response');
});

test('POST /v1/ai/chat - Backend DNA: an identical repeat request is served from cache, not the upstream', async () => {
  const tok = await freshUser();
  await saveConfig(`Bearer ${tok}`, {
    apiKey: 'cache-test-key',
    gateway: 'openrouter',
    dailyRequestCap: 1000,
  });

  let upstreamCalls = 0;
  const restore = __setTransportForTests((async () => {
    upstreamCalls += 1;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'cached-worthy answer' } }],
        model: 'mock/model-v1',
        usage: { cost: 0.01 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as GuardedTransport);

  try {
    const payload = { messages: [{ role: 'user', content: 'same question twice' }] };
    const headers = { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' };

    const first = await app.inject({ method: 'POST', url: '/v1/ai/chat', headers, payload });
    assert.equal(first.statusCode, 200, `first call: ${first.body}`);
    assert.equal(upstreamCalls, 1, 'first call should hit the upstream');

    const second = await app.inject({ method: 'POST', url: '/v1/ai/chat', headers, payload });
    assert.equal(second.statusCode, 200, `second call: ${second.body}`);
    assert.equal(
      upstreamCalls,
      1,
      'identical repeat call must be served from cache, not the upstream',
    );
    assert.deepEqual(
      JSON.parse(second.body),
      JSON.parse(first.body),
      'cached response must match the original',
    );

    // A different prompt from the SAME user must still hit the upstream - the
    // cache must never return a stale answer to a genuinely different question.
    const different = await app.inject({
      method: 'POST',
      url: '/v1/ai/chat',
      headers,
      payload: { messages: [{ role: 'user', content: 'a completely different question' }] },
    });
    assert.equal(different.statusCode, 200, `different-prompt call: ${different.body}`);
    assert.equal(
      upstreamCalls,
      2,
      "a genuinely different prompt must not be served from the first prompt's cache entry",
    );
  } finally {
    restore();
  }
});

test('POST /v1/ai/chat - 401 without auth token', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/ai/chat',
    headers: { 'content-type': 'application/json' },
    payload: { messages: [{ role: 'user', content: 'hello' }] },
  });
  assert.equal(res.statusCode, 401, `expected 401: ${res.body}`);
});

test('POST /v1/ai/chat - 404 when no config saved (second user)', async () => {
  // Register a second user who has no AI config.
  const regRes = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'no-ai-config@example.com', password: 'test-password-456' },
  });
  assert.equal(regRes.statusCode, 201);
  const { accessToken } = JSON.parse(regRes.body) as { accessToken: string };

  const res = await app.inject({
    method: 'POST',
    url: '/v1/ai/chat',
    headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    payload: { messages: [{ role: 'user', content: 'hello' }] },
  });
  assert.equal(res.statusCode, 404, `expected 404 when no config: ${res.body}`);
});

test('POST /v1/ai/config - 400 when gateway=custom but no baseUrl', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/ai/config',
    headers: { ...AUTH(), 'content-type': 'application/json' },
    payload: {
      apiKey: 'some-key',
      gateway: 'custom',
      // baseUrl intentionally omitted
    },
  });
  assert.equal(res.statusCode, 400, `expected 400: ${res.body}`);
});

test('POST /v1/ai/chat - 400 with invalid message format', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/ai/chat',
    headers: { ...AUTH(), 'content-type': 'application/json' },
    payload: {
      messages: [{ role: 'invalid-role', content: 'hello' }],
    },
  });
  assert.equal(res.statusCode, 400, `expected 400 for bad role: ${res.body}`);
});

test('POST /v1/ai/chat - 429 when daily cap exceeded', async () => {
  // Daily cap is set to 3 for this test instance.
  // We already made 1 successful chat request. Make 2 more to hit cap.
  for (let i = 0; i < 2; i++) {
    await app.inject({
      method: 'POST',
      url: '/v1/ai/chat',
      headers: { ...AUTH(), 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: `request ${i}` }] },
    });
  }
  // 4th request should hit the cap.
  const res = await app.inject({
    method: 'POST',
    url: '/v1/ai/chat',
    headers: { ...AUTH(), 'content-type': 'application/json' },
    payload: { messages: [{ role: 'user', content: 'over cap' }] },
  });
  assert.equal(res.statusCode, 429, `expected 429 for daily cap: ${res.body}`);
  const body = JSON.parse(res.body) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'RATE_LIMITED', `expected RATE_LIMITED code: ${res.body}`);
  assert.ok(
    body.error.message.toLowerCase().includes('cap'),
    `expected cap message, got: ${body.error.message}`,
  );
});

test('DELETE /v1/ai/config - removes config', async () => {
  // Register a fresh user so deletion does not affect other tests.
  const regRes = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'ai-delete@example.com', password: 'test-password-789' },
  });
  const { accessToken } = JSON.parse(regRes.body) as { accessToken: string };

  // Save a config.
  await app.inject({
    method: 'POST',
    url: '/v1/ai/config',
    headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    payload: { apiKey: 'key-to-delete', gateway: 'openrouter' },
  });

  // Delete it.
  const delRes = await app.inject({
    method: 'DELETE',
    url: '/v1/ai/config',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(delRes.statusCode, 204, `delete: ${delRes.body}`);

  // GET should now 404.
  const getRes = await app.inject({
    method: 'GET',
    url: '/v1/ai/config',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(getRes.statusCode, 404, `expected 404 after delete: ${getRes.body}`);
});

// ---------------------------------------------------------------------------
// Slice B additions: SSE streaming, durable spend cap, redaction, restart
// ---------------------------------------------------------------------------

let userCounter = 0;
/** Register a fresh user and return its bearer token. */
async function freshUser(): Promise<string> {
  userCounter += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: `slice-b-${userCounter}@example.com`, password: 'test-password-abc' },
  });
  assert.equal(res.statusCode, 201, `register: ${res.body}`);
  return (JSON.parse(res.body) as { accessToken: string }).accessToken;
}

async function saveConfig(authHeader: string, payload: Record<string, unknown>): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/ai/config',
    headers: { Authorization: authHeader, 'content-type': 'application/json' },
    payload,
  });
  assert.equal(res.statusCode, 201, `save config: ${res.body}`);
}

test('POST /v1/ai/chat stream - emits well-formed, provider-agnostic SSE frames', async () => {
  const tok = await freshUser();
  await saveConfig(`Bearer ${tok}`, {
    apiKey: 'stream-secret-key',
    gateway: 'openrouter',
    // High caps so this test never trips the cap.
    spendCapUsd: 100,
    dailyRequestCap: 1000,
  });

  const restore = __setTransportForTests(makeFakeAiStream({ cost: 0.002 }));
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ai/chat',
      headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: 'hi' }], stream: true },
    });

    assert.equal(res.statusCode, 200, `stream: ${res.body}`);
    assert.match(res.headers['content-type'] as string, /text\/event-stream/);
    assert.equal(res.headers['x-accel-buffering'], 'no');

    // Raw upstream JSON shape must never appear. Our own frames legitimately use
    // a `type:"delta"` discriminator, so check for the upstream-only structure
    // (the `choices[].delta` object) instead.
    assert.ok(!res.body.includes('"choices"'), 'must not leak raw upstream choices');
    assert.ok(!res.body.includes('"delta":{'), 'must not leak raw upstream delta object');

    const frames = parseSse(res.body);
    const types = frames.map((f) => f.event);
    assert.ok(types.includes('delta'), 'expected at least one delta frame');
    assert.ok(types.includes('usage'), 'expected a usage frame');
    assert.equal(types[types.length - 1], 'done', 'last frame must be done');

    // Each frame validates against the shared schema (provider-agnostic shape).
    for (const f of frames) {
      const parsed = aiStreamEventSchema.safeParse(f.data);
      assert.ok(parsed.success, `frame failed schema: ${JSON.stringify(f.data)}`);
    }

    const deltaText = frames
      .filter((f) => f.event === 'delta')
      .map((f) => (f.data as { content: string }).content)
      .join('');
    assert.equal(deltaText, 'Hello!');

    const usageFrame = frames.find((f) => f.event === 'usage');
    assert.equal((usageFrame?.data as { usage: { costUsd: number } }).usage.costUsd, 0.002);

    const doneFrame = frames.find((f) => f.event === 'done');
    assert.equal((doneFrame?.data as { model?: string }).model, 'mock/stream-v1');

    // Key must never appear anywhere in the SSE body.
    assert.ok(!res.body.includes('stream-secret-key'), 'key must not leak in stream');
  } finally {
    restore();
  }
});

test('POST /v1/ai/chat stream - mid-stream upstream error is redacted (key never leaks)', async () => {
  const tok = await freshUser();
  const KEY = 'super-secret-redaction-key';
  await saveConfig(`Bearer ${tok}`, { apiKey: KEY, gateway: 'openrouter', dailyRequestCap: 1000 });

  // Upstream error frame embeds the key - the relay must strip it.
  const restore = __setTransportForTests(makeFakeAiStream({ errorContaining: KEY }));
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ai/chat',
      headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes(KEY), 'key must be redacted from the SSE error frame');
    assert.ok(res.body.includes('[REDACTED]'), 'expected redaction marker in error frame');
    const frames = parseSse(res.body);
    assert.ok(
      frames.some((f) => f.event === 'error'),
      'expected an error frame for the mid-stream upstream error',
    );
  } finally {
    restore();
  }
});

test('spend cap - refuses the NEXT call after the monetary cap is crossed', async () => {
  const tok = await freshUser();
  // One call costing 0.50 crosses a 0.40 cap (soft cap: this call goes through).
  await saveConfig(`Bearer ${tok}`, {
    apiKey: 'spend-cap-key',
    gateway: 'openrouter',
    spendCapUsd: 0.4,
    dailyRequestCap: 1000, // high so the request cap is not the limiter
  });

  const restore = __setTransportForTests(
    (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          model: 'mock/model-v1',
          usage: { cost: 0.5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as GuardedTransport,
  );
  try {
    // First call: crosses the cap (soft) → still 200, commits 0.50.
    const first = await app.inject({
      method: 'POST',
      url: '/v1/ai/chat',
      headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: 'first' }] },
    });
    assert.equal(first.statusCode, 200, `first call should succeed: ${first.body}`);

    // Second call: accrued spend (0.50) >= cap (0.40) → 429.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/ai/chat',
      headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: 'second' }] },
    });
    assert.equal(second.statusCode, 429, `second call should be 429: ${second.body}`);
    const body = JSON.parse(second.body) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.ok(body.error.message.toLowerCase().includes('spend'), body.error.message);

    // GET config surfaces the exceeded state + configured cap (never the key).
    const info = await app.inject({
      method: 'GET',
      url: '/v1/ai/config',
      headers: { Authorization: `Bearer ${tok}` },
    });
    assert.equal(info.statusCode, 200);
    const cfg = JSON.parse(info.body) as {
      spendCapUsd?: number;
      spendCapState?: { state: string; windowSpentUsd: number; windowRequests: number };
    };
    assert.equal(cfg.spendCapUsd, 0.4);
    assert.equal(cfg.spendCapState?.state, 'exceeded');
    assert.equal(cfg.spendCapState?.windowSpentUsd, 0.5);
    assert.equal(cfg.spendCapState?.windowRequests, 1);
    assert.ok(!info.body.includes('spend-cap-key'), 'key must never be returned by GET config');
  } finally {
    restore();
  }
});

test('spend cap with no provider cost - falls back to request-count capping (costUsd 0)', async () => {
  const tok = await freshUser();
  await saveConfig(`Bearer ${tok}`, {
    apiKey: 'no-cost-key',
    gateway: 'openrouter',
    dailyRequestCap: 2, // request cap is the backstop when no $ cost is reported
  });

  // Upstream returns NO cost field - we must never estimate; commit costUsd 0.
  const restore = __setTransportForTests(
    (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          model: 'mock/model-v1',
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as GuardedTransport,
  );
  try {
    for (let i = 0; i < 2; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/ai/chat',
        headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        payload: { messages: [{ role: 'user', content: `c${i}` }] },
      });
      assert.equal(r.statusCode, 200, `call ${i}: ${r.body}`);
    }
    // 3rd call hits the request cap (spend stayed at 0, never estimated).
    const over = await app.inject({
      method: 'POST',
      url: '/v1/ai/chat',
      headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: 'over' }] },
    });
    assert.equal(over.statusCode, 429, `expected request-cap 429: ${over.body}`);

    const info = await app.inject({
      method: 'GET',
      url: '/v1/ai/config',
      headers: { Authorization: `Bearer ${tok}` },
    });
    const cfg = JSON.parse(info.body) as { spendCapState?: { windowSpentUsd: number } };
    assert.equal(cfg.spendCapState?.windowSpentUsd, 0, 'cost must stay 0 - never estimated');
  } finally {
    restore();
  }
});

test('spend cap survives a simulated restart (durable in the store)', async () => {
  const tok = await freshUser();
  await saveConfig(`Bearer ${tok}`, {
    apiKey: 'durable-key',
    gateway: 'openrouter',
    spendCapUsd: 1.0,
    dailyRequestCap: 1000,
  });

  const restore = __setTransportForTests(
    (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          model: 'mock/model-v1',
          usage: { cost: 0.7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as GuardedTransport,
  );
  try {
    // Commit 0.70 of spend.
    const r = await app.inject({
      method: 'POST',
      url: '/v1/ai/chat',
      headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: 'spend' }] },
    });
    assert.equal(r.statusCode, 200, r.body);
  } finally {
    restore();
  }

  // Simulate a restart: build a brand-new app over the SAME storage instance.
  // The durable spend window must be read back, not reset.
  const config = loadConfig({
    GRAPHVAULT_STORAGE: 'memory',
    GRAPHVAULT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    GRAPHVAULT_AI_DAILY_CAP: '3',
  });
  const app2 = await buildApp(config, { storage: sharedStorage });
  try {
    const info = await app2.inject({
      method: 'GET',
      url: '/v1/ai/config',
      headers: { Authorization: `Bearer ${tok}` },
    });
    assert.equal(info.statusCode, 200, info.body);
    const cfg = JSON.parse(info.body) as { spendCapState?: { windowSpentUsd: number } };
    assert.equal(
      cfg.spendCapState?.windowSpentUsd,
      0.7,
      'accrued spend must survive the simulated restart',
    );
  } finally {
    await app2.close();
  }
});

test('client disconnect aborts the upstream fetch (stops burning budget)', async () => {
  // Use a dedicated, listening app so we can model a real mid-stream TCP close.
  const config = loadConfig({
    GRAPHVAULT_STORAGE: 'memory',
    GRAPHVAULT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
  });
  const storage = new InMemoryStorage();
  const liveApp = await buildApp(config, { storage });

  const regRes = await liveApp.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'abort-tester@example.com', password: 'test-password-abc' },
  });
  const tok = (JSON.parse(regRes.body) as { accessToken: string }).accessToken;
  await liveApp.inject({
    method: 'POST',
    url: '/v1/ai/config',
    headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    payload: { apiKey: 'abort-key', gateway: 'openrouter', dailyRequestCap: 1000 },
  });

  let aborted = false;
  // A never-ending upstream stream that flags when its socket is torn down via
  // the forwarded abort signal (the path the route wires on client disconnect).
  const restore = __setTransportForTests((async (_url, init) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          try {
            controller.close();
          } catch {
            /* noop */
          }
        });
        // Never close on our own - only the abort path ends it.
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as GuardedTransport);

  try {
    const address = await liveApp.listen({ port: 0, host: '127.0.0.1' });
    const port = Number(new URL(address).port);

    const { request: httpRequest } = await import('node:http');
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/ai/chat',
          headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        },
        (res) => {
          res.once('data', () => {
            // Got the first delta - disconnect abruptly mid-stream.
            req.destroy();
            setTimeout(resolve, 250);
          });
          res.on('error', () => {
            /* expected on destroy */
          });
        },
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNRESET') resolve();
        else reject(err);
      });
      req.write(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }));
      req.end();
    });

    assert.ok(aborted, 'upstream fetch must be aborted on client disconnect');
  } finally {
    restore();
    await liveApp.close();
  }
});
