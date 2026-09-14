/**
 * Security audit tests (SecAudit, session https://claude.ai/code/session_01Qw5rxHnoo4J3PuVwfEo79v).
 *
 * Each test is named after the vulnerability it demonstrates. Tests that are
 * prefixed "FIXED:" must PASS; they were written as failing proofs first, then
 * fixed.
 *
 * Vulnerabilities found and fixed:
 *
 *   VULN-1  WebDAV proxy path-traversal via URL-encoded dots (%2e%2e)
 *           - Double-encoded dots (%252e%252e) survived the `includes('..')`
 *             check in webdavProxyPathSchema because Fastify only decodes once.
 *             The resulting %2e%2e was appended to the base URL; the remote
 *             WebDAV server decoded it to `..` and served files outside the
 *             configured directory.
 *           - Also fixed in joinWebDavUrl (service-level belt-and-suspenders).
 *           - Fix: reject any proxy path whose fully-decoded form contains `..`
 *             in the shared schema (packages/shared/src/webdav.ts) and in the
 *             joinWebDavUrl service function.
 *
 *   VULN-2  Snapshot POST body size bypass when Content-Type is non-JSON
 *           - Actually NOT a real vulnerability (the service's maxBytes guard
 *             runs regardless). Confirmed safe.
 *
 *   CONFIRMED SOLID: all other areas (SSRF, auth, credential leak, authz,
 *   snapshot store, inbox ownership) were found to be correctly implemented.
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

// ---------------------------------------------------------------------------
// Shared app + helpers
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let dataDir: string;
let token = '';

/**
 * Fake WebDAV "server": a Map<url, content> so we can verify WHICH URL the
 * server actually fetched, not just whether it fetched at all.
 */
const fakeDavStore = new Map<string, Buffer>();
/** Every URL the fake transport received. Used to verify traversal prevention. */
const fetchedUrls: string[] = [];

function makeFakeTransport(): GuardedTransport {
  return async (url, init) => {
    fetchedUrls.push(url);
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      const content = fakeDavStore.get(url);
      if (!content) return new Response('Not found', { status: 404 });
      return new Response(content, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (method === 'PUT') {
      const body = init.body;
      const buf =
        body instanceof Uint8Array
          ? Buffer.from(body)
          : typeof body === 'string'
            ? Buffer.from(body, 'utf8')
            : Buffer.alloc(0);
      fakeDavStore.set(url, buf);
      return new Response(null, { status: 201 });
    }
    if (method === 'DELETE') {
      fakeDavStore.delete(url);
      return new Response(null, { status: 204 });
    }
    return new Response('Method not allowed', { status: 405 });
  };
}

let restoreTransport: (() => void) | undefined;
let restoreResolver: (() => void) | undefined;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gv-secaudit-'));
  const config = loadConfig({
    GRAPHVAULT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    GRAPHVAULT_RATE_LIMIT_MAX: '100000',
    GRAPHVAULT_AUTH_RATE_LIMIT_MAX: '100000',
    GRAPHVAULT_SNAPSHOTS_ENABLED: 'true',
    GRAPHVAULT_SNAPSHOT_MAX_BYTES: '1000',
    GRAPHVAULT_SNAPSHOT_RATE_LIMIT_MAX: '100000',
  });
  app = await buildApp(config, { storage: new InMemoryStorage() });
  await app.ready();

  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'secaudit@example.com', password: 'hunter2!longpass', deviceName: 'test' },
  });
  assert.equal(reg.statusCode, 201, reg.body);
  token = reg.json().accessToken;

  restoreTransport = __setTransportForTests(makeFakeTransport());
  restoreResolver = __setResolverForTests((async () => ['93.184.216.34']) as ResolveAllFn);
});

after(async () => {
  restoreTransport?.();
  restoreResolver?.();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// Set up a WebDAV config for proxy tests.
async function configureWebDav() {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/webdav/config',
    headers: auth(),
    payload: {
      url: 'https://dav.example.com/user/data/',
      username: 'user',
      password: 'pass',
    },
  });
  assert.equal(res.statusCode, 201, `configure webdav: ${res.body}`);
}

// ---------------------------------------------------------------------------
// VULN-1: WebDAV proxy path-traversal via URL-encoded dots
// ---------------------------------------------------------------------------
//
// Attack: client sends %252e%252e in the URL (double-encoded).
//   Fastify decodes once → wildcard param = "%2e%2e/etc/passwd"
//   Old check: '"%2e%2e/etc/passwd".includes("..") === false' → allowed
//   joinWebDavUrl appends it → "https://dav.example.com/user/data/%2e%2e/etc/passwd"
//   Remote WebDAV server decodes → accesses "../etc/passwd" relative to data/
//   → reads /user/etc/passwd (outside the configured directory)
// ---------------------------------------------------------------------------

test('FIXED VULN-1: joinWebDavUrl rejects URL-encoded dot traversal (%2e%2e)', () => {
  // The service-level guard must catch URL-encoded dots even if the schema
  // somehow passed the path through.
  assert.throws(
    () => joinWebDavUrl('https://dav.example.com/data/', '%2e%2e/etc/passwd'),
    /path traversal/i,
  );
  assert.throws(
    () => joinWebDavUrl('https://dav.example.com/data/', '%2E%2E/secret'),
    /path traversal/i,
  );
  // Mixed: literal + encoded
  assert.throws(
    () => joinWebDavUrl('https://dav.example.com/data/', 'sub/%2e.'),
    /path traversal/i,
  );
  // Triple-encoded - still caught after a full decode
  assert.throws(
    () => joinWebDavUrl('https://dav.example.com/data/', '%252e%252e/x'),
    /path traversal/i,
  );
});

test('FIXED VULN-1: webdav proxy route rejects double-encoded path traversal (400)', async () => {
  await configureWebDav();
  fetchedUrls.length = 0;

  // The client sends %252e%252e - double-encoded dots.
  // Fastify decodes once: the wildcard param becomes "%2e%2e/etc/passwd".
  // The old check: includes('..') = false → would pass.
  // The fix: the schema (or joinWebDavUrl) must also catch %2e (encoded dots).
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/webdav/proxy/%252e%252e%2fetc%2fpasswd',
    headers: auth(),
  });
  assert.equal(
    res.statusCode,
    400,
    `expected 400 for double-encoded traversal, got ${res.statusCode}: ${res.body}`,
  );
  // The fake transport must NOT have been invoked - the request is rejected
  // before any outbound fetch is made.
  const traversalFetches = fetchedUrls.filter((u) => u.includes('etc/passwd'));
  assert.equal(
    traversalFetches.length,
    0,
    `server should not have fetched any traversal URL, but fetched: ${traversalFetches.join(', ')}`,
  );
});

test('FIXED VULN-1: webdav proxy route rejects single-encoded path traversal (400)', async () => {
  fetchedUrls.length = 0;
  // %2e%2e is a single-encoded .. - Fastify leaves it as %2e%2e in the param.
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/webdav/proxy/%2e%2e%2fconfidential.json',
    headers: auth(),
  });
  assert.equal(
    res.statusCode,
    400,
    `expected 400 for single-encoded traversal, got ${res.statusCode}: ${res.body}`,
  );
  const traversalFetches = fetchedUrls.filter((u) => u.includes('confidential.json'));
  assert.equal(traversalFetches.length, 0, 'server must not have fetched the traversal URL');
});

test('FIXED VULN-1: joinWebDavUrl still allows normal paths', () => {
  // Legitimate paths must still work after the fix.
  const result = joinWebDavUrl('https://dav.example.com/data/', 'vault.json');
  assert.equal(result, 'https://dav.example.com/data/vault.json');

  const result2 = joinWebDavUrl('https://dav.example.com/dav', 'folder/sub/file.md');
  assert.equal(result2, 'https://dav.example.com/dav/folder/sub/file.md');

  // URL-encoded chars that are NOT traversal must be allowed through (e.g.
  // percent-encoded space or Unicode in a filename).
  const result3 = joinWebDavUrl('https://dav.example.com/dav/', 'my%20notes/hello.md');
  assert.equal(result3, 'https://dav.example.com/dav/my%20notes/hello.md');
});

// ---------------------------------------------------------------------------
// CONFIRMED SOLID: snapshot store security (no new bugs found)
// ---------------------------------------------------------------------------

test('snapshot data is stored and returned opaquely (no server-side parsing)', async () => {
  // Deliberately adversarial payload: looks like JSON/script injection but must
  // be stored and returned as an opaque string.
  const maliciousData = '<script>alert(1)</script>{"evil":true}';
  const post = await app.inject({
    method: 'POST',
    url: '/v1/snapshots',
    payload: { data: maliciousData },
  });
  assert.equal(post.statusCode, 201, post.body);
  const { id } = post.json();

  const get = await app.inject({ method: 'GET', url: `/v1/snapshots/${id}` });
  assert.equal(get.statusCode, 200);
  // Returned as a JSON string field - never executed or parsed server-side.
  assert.equal(get.json().data, maliciousData);
  // The response Content-Type must be application/json, not text/html.
  assert.ok(
    get.headers['content-type']?.includes('application/json'),
    `expected JSON content-type, got: ${get.headers['content-type']}`,
  );
});

test('snapshot GET/DELETE have no auth requirement and no info leak', async () => {
  const post = await app.inject({
    method: 'POST',
    url: '/v1/snapshots',
    payload: { data: 'some-graph-data' },
  });
  const { id, deleteToken } = post.json();

  // GET is public (unauthenticated) by design.
  const get = await app.inject({ method: 'GET', url: `/v1/snapshots/${id}` });
  assert.equal(get.statusCode, 200);
  const body = get.json();
  // The deleteToken must NEVER be included in a GET response.
  assert.equal(body.deleteToken, undefined, 'deleteToken must not be in GET response');

  // DELETE requires the correct token (already tested in snapshots.test.ts),
  // just confirm the 204 path with valid token.
  const del = await app.inject({
    method: 'DELETE',
    url: `/v1/snapshots/${id}`,
    payload: { deleteToken },
  });
  assert.equal(del.statusCode, 204);
});

// ---------------------------------------------------------------------------
// CONFIRMED SOLID: AI config - API key never returned
// ---------------------------------------------------------------------------

test('GET /v1/ai/config never returns the apiKey field', async () => {
  // Save an AI config.
  restoreTransport?.();
  restoreResolver?.();
  // Temporarily swap to a resolver + transport that allows the AI config save
  // (the save itself doesn't fetch outbound, so the real resolver isn't used).
  const r1 = __setTransportForTests(makeFakeTransport());
  const r2 = __setResolverForTests((async () => ['93.184.216.34']) as ResolveAllFn);
  try {
    const save = await app.inject({
      method: 'POST',
      url: '/v1/ai/config',
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: { apiKey: 'super-secret-ai-key-never-return-me', gateway: 'openrouter' },
    });
    assert.equal(save.statusCode, 201, save.body);
    // Must not contain the key in the save response.
    assert.ok(!save.body.includes('super-secret-ai-key-never-return-me'));

    const get = await app.inject({
      method: 'GET',
      url: '/v1/ai/config',
      headers: auth(),
    });
    assert.equal(get.statusCode, 200, get.body);
    const info = get.json();
    assert.equal(info.keySet, true);
    // Key must NEVER be returned.
    assert.ok(!get.body.includes('super-secret-ai-key-never-return-me'));
    assert.ok(!('apiKey' in info), 'apiKey field must not exist in GET /v1/ai/config response');
    assert.ok(
      !('encryptedApiKey' in info),
      'encryptedApiKey must not exist in GET /v1/ai/config response',
    );
  } finally {
    r1();
    r2();
    // Re-install the main test transport/resolver.
    restoreTransport = __setTransportForTests(makeFakeTransport());
    restoreResolver = __setResolverForTests((async () => ['93.184.216.34']) as ResolveAllFn);
  }
});

// ---------------------------------------------------------------------------
// CONFIRMED SOLID: authz - cross-user isolation
// ---------------------------------------------------------------------------

test('user cannot access a vault owned by another user (403)', async () => {
  // Register a second user.
  const reg2 = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'other@example.com', password: 'hunter2!longpass', deviceName: 'dev2' },
  });
  const token2 = reg2.json().accessToken;

  // Create a vault as the first user.
  const vaultRes = await app.inject({
    method: 'POST',
    url: '/v1/vaults',
    headers: auth(),
    payload: { name: 'private vault' },
  });
  const vaultId = vaultRes.json().vaultId;

  // Try to access it as the second user.
  const intruder = await app.inject({
    method: 'GET',
    url: `/v1/vaults/${vaultId}/changes?since=0`,
    headers: { authorization: `Bearer ${token2}` },
  });
  assert.equal(intruder.statusCode, 403);
  assert.equal(intruder.json().error.code, 'FORBIDDEN');
});

// ---------------------------------------------------------------------------
// CONFIRMED SOLID: SSRF guard - validates error message doesn't leak address
// ---------------------------------------------------------------------------

test('SSRF guard: error message never leaks the blocked IP address', async () => {
  const { assertSafeUrl, __setResolverForTests: setResolver } =
    await import('../src/services/ssrf.js');
  const restore = setResolver((async (h: string) => {
    if (h === 'ssrf-test-target.internal') return ['10.10.10.10'];
    throw new Error(`no stub for ${h}`);
  }) as ResolveAllFn);
  try {
    await assert.rejects(
      () => assertSafeUrl('https://ssrf-test-target.internal/', { allowPrivate: false }),
      (err: unknown) => {
        const e = err as { message: string };
        // The message must NOT include the internal IP.
        assert.ok(!e.message.includes('10.10.10.10'), `message leaked IP: ${e.message}`);
        // Nor the hostname used.
        assert.ok(
          !e.message.includes('ssrf-test-target.internal'),
          `message leaked hostname: ${e.message}`,
        );
        return true;
      },
    );
  } finally {
    restore();
  }
});
