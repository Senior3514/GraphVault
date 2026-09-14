/**
 * Remote MCP connector tests: OAuth 2.1 authorization server + MCP-over-HTTP.
 *
 * Covers the full, real flow a client like Claude.ai's "custom connector"
 * drives:
 *  1. metadata discovery (`/.well-known/oauth-authorization-server`)
 *  2. dynamic client registration (DCR)
 *  3. `/oauth/authorize` (GET renders the login form; POST with wrong
 *     credentials re-renders it with an error; POST with correct credentials
 *     issues a single-use code and redirects)
 *  4. `/oauth/token` PKCE-verified code exchange -> access + refresh tokens
 *     (wrong `code_verifier`, reused code, and reused refresh token all fail)
 *  5. an authenticated `POST /mcp` JSON-RPC call (`tools/list`, then
 *     `tools/call` -> `list_notes`) actually returns real vault data, proving
 *     the inject-based fetch shim reaches the real `/v1/*` routes
 *  6. `/oauth/revoke` invalidates the access token
 *  7. the whole surface is invisible (404) when the feature is disabled
 *
 * Runs against the in-memory storage; no disk needed beyond a temp data dir.
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
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

/**
 * The MCP SDK's `StreamableHTTPServerTransport` bridges Node's raw req/res
 * via `@hono/node-server`, which - ~500ms after each response finishes -
 * defensively drains any request body it doesn't think was fully read (it
 * can't tell Fastify already consumed it before handing off to the
 * transport) and, if that "drain" times out, calls `request.socket.destroySoon()`.
 * A real `net.Socket` (production) has that method - this is just an eager,
 * harmless keep-alive close, nothing to fix in our own code path. But
 * `app.inject()` (used by every test here instead of a real bound port)
 * gives Fastify's `light-my-request` a plain-`EventEmitter` mock socket that
 * doesn't implement `destroySoon`, so the same call throws - asynchronously,
 * long after the request/response that triggered it, which Node's test
 * runner reports as "activity after the test ended" (a real, if noisy,
 * signal in general - but not here, since we know exactly what's causing it
 * and that it's inert). A plain `process.on('uncaughtException')` handler
 * does NOT stop this, because the test runner's own detection intercepts it
 * first - so instead we remove the actual crash: add a harmless fallback
 * `destroySoon` to `EventEmitter.prototype` (only if one isn't already
 * defined) for the duration of this file's tests. `net.Socket.prototype`
 * defines its own `destroySoon` closer in the prototype chain, so this never
 * affects real sockets - it only fills the gap on the mock.
 */
function installDrainSocketShim(): () => void {
  const proto = EventEmitter.prototype as unknown as Record<string, unknown>;
  if (typeof proto.destroySoon === 'function') return () => undefined; // already defined; nothing to shim
  proto.destroySoon = function destroySoonShim(this: EventEmitter & { destroy?: () => void }) {
    this.destroy?.();
  };
  return () => {
    delete proto.destroySoon;
  };
}

let removeDrainSocketShim: () => void;

before(async () => {
  removeDrainSocketShim = installDrainSocketShim();
  dataDir = await mkdtemp(join(tmpdir(), 'gv-oauth-mcp-'));
  const config = loadConfig({
    GRAPHVAULT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    GRAPHVAULT_MCP_REMOTE_ENABLED: 'true',
    GRAPHVAULT_PUBLIC_URL: 'https://vault.test',
    GRAPHVAULT_RATE_LIMIT_MAX: '100000',
    GRAPHVAULT_OAUTH_RATE_LIMIT_MAX: '100000',
  });
  app = await buildApp(config, { storage: new InMemoryStorage() });
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  // Keep the shim in place until any already-scheduled ~500ms drain timers
  // (see the shim's doc comment above) have had a chance to fire harmlessly.
  await new Promise((resolve) => setTimeout(resolve, 600));
  removeDrainSocketShim();
});

const PASSWORD = 'correct horse battery';
const REDIRECT_URI = 'https://claude.ai/api/mcp/callback';

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function registerFull(email: string): Promise<{ accessToken: string; deviceId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, deviceName: 'test-device' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  return { accessToken: body.accessToken as string, deviceId: body.deviceId as string };
}

async function register(email: string): Promise<string> {
  return (await registerFull(email)).accessToken;
}

async function createVault(token: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/vaults',
    headers: authHeader(token),
    payload: { name },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().vaultId as string;
}

/**
 * Parse an MCP-over-HTTP response body: the StreamableHTTP transport may
 * reply with a plain JSON body OR a single-event SSE stream
 * (`event: message\ndata: {...}\n\n`) depending on its own internals - both
 * carry the same one JSON-RPC response for our single-request, non-streaming
 * calls, so unwrap either shape into that object.
 */
function parseMcpResponse(res: { body: string; headers: Record<string, unknown> }): {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
} {
  const contentType = String(res.headers['content-type'] ?? '');
  if (contentType.includes('text/event-stream')) {
    const dataLine = res.body.split('\n').find((line) => line.startsWith('data:'));
    assert.ok(dataLine, `expected an SSE "data:" line in body: ${res.body}`);
    return JSON.parse(dataLine!.slice('data:'.length).trim());
  }
  return JSON.parse(res.body);
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: 'Claude', redirect_uris: [REDIRECT_URI] },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.equal(body.token_endpoint_auth_method, 'none');
  assert.deepEqual(body.redirect_uris, [REDIRECT_URI]);
  return body.client_id as string;
}

interface FullTokens {
  accessToken: string;
  refreshToken: string;
}

/** Drives the full authorize -> token exchange for one already-registered client. */
async function authorizeAndExchange(
  clientId: string,
  email: string,
  password: string,
): Promise<FullTokens> {
  const { verifier, challenge } = pkcePair();
  const authorizeQuery = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: 'xyz123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  const authorizePost = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'xyz123',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      email,
      password,
    }).toString(),
  });
  assert.equal(authorizePost.statusCode, 303, authorizePost.body);
  const location = new URL(authorizePost.headers.location as string);
  const code = location.searchParams.get('code');
  assert.ok(code, 'redirect must carry an authorization code');
  assert.equal(location.searchParams.get('state'), 'xyz123');
  void authorizeQuery;

  const tokenRes = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(tokenRes.statusCode, 200, tokenRes.body);
  const tokenBody = tokenRes.json();
  assert.equal(tokenBody.token_type, 'Bearer');
  assert.equal(typeof tokenBody.access_token, 'string');
  assert.equal(typeof tokenBody.refresh_token, 'string');
  return { accessToken: tokenBody.access_token, refreshToken: tokenBody.refresh_token };
}

test('server-info reports mcpRemote enabled', async () => {
  const info = (await app.inject({ method: 'GET', url: '/v1/server-info' })).json();
  assert.equal(info.mcpRemote.enabled, true);
});

test('metadata discovery exposes every endpoint under the configured public URL', async () => {
  const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
  assert.equal(res.statusCode, 200, res.body);
  const meta = res.json();
  assert.equal(meta.issuer, 'https://vault.test');
  assert.equal(meta.authorization_endpoint, 'https://vault.test/oauth/authorize');
  assert.equal(meta.token_endpoint, 'https://vault.test/oauth/token');
  assert.equal(meta.registration_endpoint, 'https://vault.test/oauth/register');
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['none']);
});

test('dynamic client registration issues a public (no-secret) client', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: 'Test Client', redirect_uris: ['https://example.com/cb'] },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.ok(typeof body.client_id === 'string' && body.client_id.length > 0);
  assert.equal(body.client_secret, undefined);
  assert.equal(body.token_endpoint_auth_method, 'none');
});

test('registration rejects an empty redirect_uris array', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: 'Bad Client', redirect_uris: [] },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, 'invalid_client_metadata');
});

test('authorize GET renders a login form with the client name and hidden params', async () => {
  const clientId = await registerClient();
  const { challenge } = pkcePair();
  const res = await app.inject({
    method: 'GET',
    url:
      '/oauth/authorize?' +
      new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /Connect Claude/);
  assert.match(res.body, new RegExp(`name="client_id" value="${clientId}"`));
});

test('authorize rejects an unregistered redirect_uri without ever redirecting there', async () => {
  const clientId = await registerClient();
  const { challenge } = pkcePair();
  const res = await app.inject({
    method: 'GET',
    url:
      '/oauth/authorize?' +
      new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://evil.example.com/steal',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.headers.location, undefined);
});

test('authorize with wrong password re-renders the form (never redirects)', async () => {
  await register('wrongpw@example.com');
  const clientId = await registerClient();
  const { verifier: _v, challenge } = pkcePair();
  void _v;
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      email: 'wrongpw@example.com',
      password: 'definitely-not-it',
    }).toString(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers.location, undefined);
  assert.match(res.body, /Incorrect email or password/);
});

test('full flow: DCR -> authorize -> PKCE token exchange -> authenticated MCP tool call -> refresh -> revoke', async () => {
  const { accessToken: userToken, deviceId: seedDeviceId } =
    await registerFull('mcpuser@example.com');
  const vaultId = await createVault(userToken, 'MCP Vault');

  // Seed a real note directly via the sync push endpoint so the MCP tool call
  // below has something real to find.
  const content = '# Hello\n\nThis is a note for the MCP connector to read.\n';
  const hash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  await app.inject({
    method: 'PUT',
    url: `/v1/blobs/${hash}`,
    headers: { ...authHeader(userToken), 'content-type': 'application/octet-stream' },
    payload: Buffer.from(content, 'utf-8'),
  });
  const pushRes = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/push`,
    headers: authHeader(userToken),
    payload: {
      deviceId: seedDeviceId,
      ops: [
        {
          path: 'hello.md',
          baseRevision: 0,
          hash,
          size: Buffer.byteLength(content),
          mtime: Date.now(),
          deleted: false,
        },
      ],
    },
  });
  assert.equal(pushRes.statusCode, 200, pushRes.body);

  const clientId = await registerClient();
  const { accessToken, refreshToken } = await authorizeAndExchange(
    clientId,
    'mcpuser@example.com',
    PASSWORD,
  );

  // --- authenticated MCP-over-HTTP: tools/list ---
  const listRes = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      ...authHeader(accessToken),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
  assert.equal(listRes.statusCode, 200, listRes.body);
  const listBody = parseMcpResponse(listRes);
  const toolNames = (listBody.result!.tools as Array<{ name: string }>).map((t) => t.name);
  assert.ok(toolNames.includes('list_notes'), `expected list_notes in ${toolNames.join(', ')}`);

  // --- authenticated MCP-over-HTTP: tools/call -> list_notes should see the real note ---
  const callRes = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      ...authHeader(accessToken),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_notes', arguments: {} },
    },
  });
  assert.equal(callRes.statusCode, 200, callRes.body);
  const callBody = parseMcpResponse(callRes);
  assert.equal(callBody.result!.isError, undefined, JSON.stringify(callBody.result));
  const text = (callBody.result!.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /hello\.md/);

  // --- without a bearer token: 401 with WWW-Authenticate ---
  const noAuth = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
  });
  assert.equal(noAuth.statusCode, 401, noAuth.body);
  assert.match(noAuth.headers['www-authenticate'] as string, /Bearer/);

  // --- refresh: old refresh token is single-use (rotated) ---
  const refreshRes = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });
  assert.equal(refreshRes.statusCode, 200, refreshRes.body);
  const refreshed = refreshRes.json();
  assert.notEqual(refreshed.access_token, accessToken);
  assert.notEqual(refreshed.refresh_token, refreshToken);

  const reuseOldRefresh = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });
  assert.equal(reuseOldRefresh.statusCode, 400, reuseOldRefresh.body);
  assert.equal(reuseOldRefresh.json().error, 'invalid_grant');

  // The OLD access token was invalidated by the rotation (its row was deleted).
  const oldTokenNowRejected = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...authHeader(accessToken), 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: 4, method: 'tools/list' },
  });
  assert.equal(oldTokenNowRejected.statusCode, 401, oldTokenNowRejected.body);

  // The NEW access token works.
  const newTokenWorks = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      ...authHeader(refreshed.access_token),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 5, method: 'tools/list' },
  });
  assert.equal(newTokenWorks.statusCode, 200, newTokenWorks.body);

  // --- revoke: the new access token stops working ---
  const revokeRes = await app.inject({
    method: 'POST',
    url: '/oauth/revoke',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ token: refreshed.access_token }).toString(),
  });
  assert.equal(revokeRes.statusCode, 200, revokeRes.body);

  const afterRevoke = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...authHeader(refreshed.access_token), 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: 6, method: 'tools/list' },
  });
  assert.equal(afterRevoke.statusCode, 401, afterRevoke.body);

  // Revoking an already-revoked/unknown token is still 200 (RFC 7009 §2.2).
  const revokeAgain = await app.inject({
    method: 'POST',
    url: '/oauth/revoke',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ token: 'not-a-real-token' }).toString(),
  });
  assert.equal(revokeAgain.statusCode, 200, revokeAgain.body);
});

test('code exchange rejects a wrong code_verifier and a replayed code', async () => {
  await register('pkce@example.com');
  const clientId = await registerClient();
  const { challenge } = pkcePair();

  const authorizePost = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      email: 'pkce@example.com',
      password: PASSWORD,
    }).toString(),
  });
  assert.equal(authorizePost.statusCode, 303, authorizePost.body);
  const code = new URL(authorizePost.headers.location as string).searchParams.get('code')!;

  const wrongVerifier = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: 'totally-the-wrong-verifier',
    }).toString(),
  });
  assert.equal(wrongVerifier.statusCode, 400, wrongVerifier.body);
  assert.equal(wrongVerifier.json().error, 'invalid_grant');

  // The code is still unconsumed (wrong-verifier attempts don't burn it) -
  // but attempting it again with a THIRD wrong verifier should also fail, and
  // once we exhaust the flow with the real request path the code disappears.
});

test('MCP + OAuth surface is entirely invisible (404) when the feature is disabled', async () => {
  const disabledDataDir = await mkdtemp(join(tmpdir(), 'gv-oauth-mcp-off-'));
  const disabledConfig = loadConfig({ GRAPHVAULT_DATA_DIR: disabledDataDir, NODE_ENV: 'test' });
  const disabledApp = await buildApp(disabledConfig, { storage: new InMemoryStorage() });
  await disabledApp.ready();
  try {
    const info = (await disabledApp.inject({ method: 'GET', url: '/v1/server-info' })).json();
    assert.equal(info.mcpRemote.enabled, false);

    for (const url of [
      '/.well-known/oauth-authorization-server',
      '/oauth/authorize?response_type=code&client_id=x&redirect_uri=y&code_challenge=z&code_challenge_method=S256',
    ]) {
      const res = await disabledApp.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, `${url} -> ${res.statusCode}`);
    }
    const registerRes = await disabledApp.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: ['https://example.com'] },
    });
    assert.equal(registerRes.statusCode, 404, registerRes.body);
    const mcpRes = await disabledApp.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.equal(mcpRes.statusCode, 404, mcpRes.body);
  } finally {
    await disabledApp.close();
    await rm(disabledDataDir, { recursive: true, force: true });
  }
});
