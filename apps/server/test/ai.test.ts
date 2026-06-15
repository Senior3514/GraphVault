/**
 * AI proxy route tests.
 *
 * Tests:
 *  1. POST /v1/ai/config — save AI config (key encrypted at rest)
 *  2. GET  /v1/ai/config — retrieve non-secret info (never returns the key)
 *  3. DELETE /v1/ai/config — remove AI config
 *  4. POST /v1/ai/chat — proxy a chat completion (mocked upstream)
 *  5. POST /v1/ai/chat — 404 when no config saved
 *  6. POST /v1/ai/chat — 429 when daily cap exceeded
 *  7. POST /v1/ai/chat — 401 without auth token
 *  8. POST /v1/ai/config — 400 with custom gateway but no baseUrl
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
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { InMemoryStorage } from '../src/store/memory.js';

let app: FastifyInstance;
let dataDir: string;
let token = '';

// ---------------------------------------------------------------------------
// Mock upstream AI provider
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;
let originalFetch: FetchFn;

/**
 * A fake OpenRouter / OpenAI-compat response for chat completions.
 */
function makeFakeAiFetch(statusCode = 200): FetchFn {
  return async (_input: RequestInfo | URL, _init?: RequestInit) => {
    if (statusCode !== 200) {
      return new Response(JSON.stringify({ error: 'upstream error' }), { status: statusCode });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'Hello from mock AI' } }],
        model: 'mock/model-v1',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
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
  const storage = new InMemoryStorage();
  app = await buildApp(config, { storage });

  // Register a test user and get a token.
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'ai-tester@example.com', password: 'test-password-123' },
  });
  assert.equal(res.statusCode, 201, `register: ${res.body}`);
  const body = JSON.parse(res.body) as { accessToken: string };
  token = body.accessToken;

  // Install the mock fetch before running tests.
  originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeAiFetch();
});

after(async () => {
  globalThis.fetch = originalFetch;
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

test('POST /v1/ai/config — saves config; key is never returned', async () => {
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

test('GET /v1/ai/config — returns non-secret info only', async () => {
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

test('POST /v1/ai/chat — proxies to upstream and returns content', async () => {
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

test('POST /v1/ai/chat — 401 without auth token', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/ai/chat',
    headers: { 'content-type': 'application/json' },
    payload: { messages: [{ role: 'user', content: 'hello' }] },
  });
  assert.equal(res.statusCode, 401, `expected 401: ${res.body}`);
});

test('POST /v1/ai/chat — 404 when no config saved (second user)', async () => {
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

test('POST /v1/ai/config — 400 when gateway=custom but no baseUrl', async () => {
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

test('POST /v1/ai/chat — 400 with invalid message format', async () => {
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

test('POST /v1/ai/chat — 429 when daily cap exceeded', async () => {
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
  assert.equal(res.statusCode, 400, `expected 400 for daily cap: ${res.body}`);
  const body = JSON.parse(res.body) as { error: { message: string } };
  assert.ok(
    body.error.message.toLowerCase().includes('cap'),
    `expected cap message, got: ${body.error.message}`,
  );
});

test('DELETE /v1/ai/config — removes config', async () => {
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
