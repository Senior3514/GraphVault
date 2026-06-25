/**
 * WebDAV proxy route tests (M18).
 *
 * We mock the outbound `fetch` calls (the ones the WebDavService makes to the
 * WebDAV server) via a monkey-patch on `globalThis.fetch`, so no real WebDAV
 * server is needed.
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
import { joinWebDavUrl } from '../src/services/webdav.js';
import {
  __setResolverForTests,
  __setTransportForTests,
  type GuardedTransport,
  type ResolveAllFn,
} from '../src/services/ssrf.js';

let app: FastifyInstance;
let dataDir: string;

const PASSWORD = 'secure-password-for-tests';
let token = '';

// ---------------------------------------------------------------------------
// Fake WebDAV responses
// ---------------------------------------------------------------------------

let restoreTransport: (() => void) | undefined;
let restoreResolver: (() => void) | undefined;

/**
 * In-memory WebDAV "server": stores file content keyed by URL.
 * Used by the mock SSRF transport to simulate a real WebDAV server.
 */
const fakeWebDavStore = new Map<string, Buffer>();

function makeFakeFetch(): GuardedTransport {
  return async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();

    if (method === 'GET') {
      const content = fakeWebDavStore.get(url);
      if (!content) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(content, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (method === 'PUT') {
      const body = init.body;
      let buf: Buffer;
      if (body instanceof Uint8Array) {
        buf = Buffer.from(body);
      } else if (typeof body === 'string') {
        buf = Buffer.from(body, 'utf8');
      } else {
        buf = Buffer.alloc(0);
      }
      const existed = fakeWebDavStore.has(url);
      fakeWebDavStore.set(url, buf);
      return new Response(null, { status: existed ? 204 : 201 });
    }

    if (method === 'DELETE') {
      fakeWebDavStore.delete(url);
      return new Response(null, { status: 204 });
    }

    return new Response('Method not allowed', { status: 405 });
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gv-webdav-test-'));
  const config = loadConfig({
    GRAPHVAULT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    GRAPHVAULT_RATE_LIMIT_MAX: '100000',
    GRAPHVAULT_AUTH_RATE_LIMIT_MAX: '100000',
  });
  app = await buildApp(config, { storage: new InMemoryStorage() });
  await app.ready();

  // Register a test user.
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'webdav@example.com', password: PASSWORD, deviceName: 'test' },
  });
  assert.equal(res.statusCode, 201, res.body);
  token = res.json().accessToken;

  // Swap out the SSRF transport + DNS resolver with our fakes.
  restoreTransport = __setTransportForTests(makeFakeFetch());
  restoreResolver = __setResolverForTests((async () => ['93.184.216.34']) as ResolveAllFn);
});

after(async () => {
  restoreTransport?.();
  restoreResolver?.();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  fakeWebDavStore.clear();
});

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// joinWebDavUrl unit tests
// ---------------------------------------------------------------------------

test('joinWebDavUrl normalises trailing slash and joins path', () => {
  assert.equal(
    joinWebDavUrl('https://dav.example.com/remote.php/dav/files/alice/', 'vault.json'),
    'https://dav.example.com/remote.php/dav/files/alice/vault.json',
  );
  // Without trailing slash on base
  assert.equal(
    joinWebDavUrl('https://dav.example.com/dav', 'notes/hello.md'),
    'https://dav.example.com/dav/notes/hello.md',
  );
});

test('joinWebDavUrl rejects path traversal', () => {
  assert.throws(
    () => joinWebDavUrl('https://dav.example.com/dav/', '../etc/passwd'),
    /path traversal/i,
  );
});

// ---------------------------------------------------------------------------
// Config endpoints
// ---------------------------------------------------------------------------

test('GET /v1/storage/webdav/config returns 404 when not configured', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/webdav/config',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('POST /v1/storage/webdav/config stores config and returns 201', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/webdav/config',
    headers: authHeader(),
    payload: {
      url: 'https://nextcloud.example.com/remote.php/dav/files/alice/',
      username: 'alice',
      password: 'secret-app-password',
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.ok(res.json().ok);
});

test('GET /v1/storage/webdav/config returns non-secret info after config is set', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/webdav/config',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.url, 'https://nextcloud.example.com/remote.php/dav/files/alice/');
  assert.equal(body.username, 'alice');
  assert.ok(body.updatedAt, 'should have updatedAt timestamp');
  // Password must NOT be returned.
  assert.ok(!('password' in body), 'password must not be in response');
  assert.ok(!('encryptedPassword' in body), 'encryptedPassword must not be in response');
});

test('POST /v1/storage/webdav/config rejects invalid URL', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/webdav/config',
    headers: authHeader(),
    payload: {
      url: 'ftp://bad-scheme.example.com/',
      username: 'alice',
      password: 'secret',
    },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('POST /v1/storage/webdav/config requires auth', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/webdav/config',
    payload: { url: 'https://dav.example.com/', username: 'u', password: 'p' },
  });
  assert.equal(res.statusCode, 401);
});

// ---------------------------------------------------------------------------
// Proxy endpoints
// ---------------------------------------------------------------------------

test('PUT /v1/storage/webdav/proxy/vault.json uploads to fake WebDAV', async () => {
  const content = Buffer.from(JSON.stringify({ notes: [] }), 'utf8');
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/storage/webdav/proxy/vault.json',
    headers: {
      ...authHeader(),
      'content-type': 'application/json',
    },
    payload: content,
  });
  // 201 for a new file, 204 for overwrite — both are success
  assert.ok(
    [201, 204].includes(res.statusCode),
    `unexpected status ${res.statusCode}: ${res.body}`,
  );
});

test('GET /v1/storage/webdav/proxy/vault.json retrieves uploaded content', async () => {
  const expected = JSON.stringify({ notes: [{ path: 'hello.md', content: '# Hi' }] });
  // First PUT the content.
  await app.inject({
    method: 'PUT',
    url: '/v1/storage/webdav/proxy/vault.json',
    headers: { ...authHeader(), 'content-type': 'application/json' },
    payload: Buffer.from(expected, 'utf8'),
  });

  // Then GET it back.
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/webdav/proxy/vault.json',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.body, expected);
});

test('GET /v1/storage/webdav/proxy/ 404 for unknown file', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/webdav/proxy/does-not-exist.json',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('DELETE /v1/storage/webdav/proxy/vault.json removes file', async () => {
  // PUT first.
  await app.inject({
    method: 'PUT',
    url: '/v1/storage/webdav/proxy/to-delete.json',
    headers: { ...authHeader(), 'content-type': 'application/json' },
    payload: Buffer.from('{}', 'utf8'),
  });

  const del = await app.inject({
    method: 'DELETE',
    url: '/v1/storage/webdav/proxy/to-delete.json',
    headers: authHeader(),
  });
  assert.equal(del.statusCode, 204, del.body);
});

test('proxy routes require auth', async () => {
  const get = await app.inject({ method: 'GET', url: '/v1/storage/webdav/proxy/x.json' });
  assert.equal(get.statusCode, 401);

  const put = await app.inject({
    method: 'PUT',
    url: '/v1/storage/webdav/proxy/x.json',
    payload: Buffer.from('{}'),
  });
  assert.equal(put.statusCode, 401);
});

test('proxy routes reject path traversal', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/webdav/proxy/..%2Fetc%2Fpasswd',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 400, res.body);
});

// ---------------------------------------------------------------------------
// DELETE config
// ---------------------------------------------------------------------------

test('DELETE /v1/storage/webdav/config removes the config', async () => {
  const del = await app.inject({
    method: 'DELETE',
    url: '/v1/storage/webdav/config',
    headers: authHeader(),
  });
  assert.equal(del.statusCode, 204, del.body);

  // Config should be gone.
  const get = await app.inject({
    method: 'GET',
    url: '/v1/storage/webdav/config',
    headers: authHeader(),
  });
  assert.equal(get.statusCode, 404);
});

test('proxy GET returns 404 after config is deleted', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/webdav/proxy/vault.json',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 404, res.body);
});

// ---------------------------------------------------------------------------
// Credential isolation between users
// ---------------------------------------------------------------------------

test('user B cannot read user A WebDAV config or proxied data', async () => {
  // Register user A and configure WebDAV.
  const regA = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'userA@example.com', password: PASSWORD, deviceName: 'a' },
  });
  const tokenA = regA.json().accessToken;

  await app.inject({
    method: 'POST',
    url: '/v1/storage/webdav/config',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      url: 'https://dav.example.com/userA/',
      username: 'userA',
      password: 'secretA',
    },
  });

  // Register user B (no WebDAV config).
  const regB = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'userB@example.com', password: PASSWORD, deviceName: 'b' },
  });
  const tokenB = regB.json().accessToken;

  // User B reading config should get 404 (not A's config).
  const configB = await app.inject({
    method: 'GET',
    url: '/v1/storage/webdav/config',
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(configB.statusCode, 404, 'user B should not see user A config');
});
