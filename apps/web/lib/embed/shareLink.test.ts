/**
 * Tests for apps/web/lib/embed/shareLink.ts
 *
 * Coverage:
 * - getServerSnapshotConfig: enabled / disabled / not-OK / malformed / bad URL
 * - uploadSnapshot: 201 success, 413 → ShareLinkTooLargeError, other non-OK,
 *   malformed body, network error, bad URL
 * - fetchSnapshot: round-trip, 404 → ShareLinkError(404), malformed/empty body
 * - normalizeServerOrigin: accepts http/https, rejects non-http(s) + junk
 * - buildShortEmbedUrl: correct shape, srv encoded, rejects bad inputs
 *
 * `globalThis.fetch` is stubbed per-test so no real server is required.
 */

import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

import {
  getServerSnapshotConfig,
  uploadSnapshot,
  fetchSnapshot,
  buildShortEmbedUrl,
  normalizeServerOrigin,
  ShareLinkError,
  ShareLinkTooLargeError,
} from './shareLink';

const SERVER = 'http://127.0.0.1:4000';

// ---------------------------------------------------------------------------
// fetch stubbing
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;
const originalFetch: FetchFn | undefined = globalThis.fetch;

/** Install a fetch handler. Each test sets its own. */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    return handler(url, init);
  }) as FetchFn;
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// normalizeServerOrigin
// ---------------------------------------------------------------------------

test('normalizeServerOrigin accepts http and https, returns bare origin', () => {
  assert.equal(normalizeServerOrigin('http://127.0.0.1:4000'), 'http://127.0.0.1:4000');
  assert.equal(normalizeServerOrigin('https://graphs.example.com'), 'https://graphs.example.com');
  // Path/query/hash are discarded - only the origin survives.
  assert.equal(
    normalizeServerOrigin('https://example.com/some/path?x=1#frag'),
    'https://example.com',
  );
  // Explicit default port is normalised away by URL.origin.
  assert.equal(normalizeServerOrigin('https://example.com:443'), 'https://example.com');
});

test('normalizeServerOrigin rejects non-http(s) schemes and junk (SSRF guard)', () => {
  for (const bad of [
    '',
    'ftp://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'not a url',
    '//no-scheme.example.com',
    null,
    undefined,
  ]) {
    assert.equal(normalizeServerOrigin(bad as string), null, `should reject: ${String(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// buildShortEmbedUrl
// ---------------------------------------------------------------------------

test('buildShortEmbedUrl produces /embed/?id=&srv= with encoded server origin', () => {
  const url = buildShortEmbedUrl('https://app.example.com', 'http://127.0.0.1:4000', 'abc123');
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://app.example.com');
  // Trailing slash before the query - static export uses trailingSlash: true.
  assert.equal(parsed.pathname, '/embed/');
  assert.equal(parsed.searchParams.get('id'), 'abc123');
  assert.equal(parsed.searchParams.get('srv'), 'http://127.0.0.1:4000');
  // srv must be percent-encoded in the raw string (the : and / are encoded).
  assert.ok(url.includes('srv=http%3A%2F%2F127.0.0.1%3A4000'), `raw srv encoded: ${url}`);
});

test('buildShortEmbedUrl rejects bad app origin, server origin, and empty id', () => {
  assert.throws(() => buildShortEmbedUrl('not-a-url', SERVER, 'id'), ShareLinkError);
  assert.throws(() => buildShortEmbedUrl('https://app', 'file:///x', 'id'), ShareLinkError);
  assert.throws(() => buildShortEmbedUrl('https://app', SERVER, ''), ShareLinkError);
});

// ---------------------------------------------------------------------------
// getServerSnapshotConfig
// ---------------------------------------------------------------------------

test('getServerSnapshotConfig returns the snapshots block when enabled', async () => {
  stubFetch((url) => {
    assert.equal(url, `${SERVER}/v1/server-info`);
    return jsonResponse({ snapshots: { enabled: true, maxBytes: 400_000 } });
  });
  const cfg = await getServerSnapshotConfig(SERVER);
  assert.deepEqual(cfg, { enabled: true, maxBytes: 400_000 });
});

test('getServerSnapshotConfig returns the block when disabled (enabled:false)', async () => {
  stubFetch(() => jsonResponse({ snapshots: { enabled: false, maxBytes: 400_000 } }));
  const cfg = await getServerSnapshotConfig(SERVER);
  assert.deepEqual(cfg, { enabled: false, maxBytes: 400_000 });
});

test('getServerSnapshotConfig returns null on non-OK status', async () => {
  stubFetch(() => jsonResponse({ error: 'nope' }, 500));
  assert.equal(await getServerSnapshotConfig(SERVER), null);
});

test('getServerSnapshotConfig returns null when snapshots field is missing/malformed', async () => {
  stubFetch(() => jsonResponse({ apiVersion: '1' }));
  assert.equal(await getServerSnapshotConfig(SERVER), null);
  stubFetch(() => jsonResponse({ snapshots: { enabled: 'yes', maxBytes: 1 } }));
  assert.equal(await getServerSnapshotConfig(SERVER), null);
});

test('getServerSnapshotConfig returns null on network error or bad URL', async () => {
  stubFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  assert.equal(await getServerSnapshotConfig(SERVER), null);
  // Bad URL short-circuits before any fetch.
  assert.equal(await getServerSnapshotConfig('file:///x'), null);
});

// ---------------------------------------------------------------------------
// uploadSnapshot
// ---------------------------------------------------------------------------

test('uploadSnapshot posts data and returns id + deleteToken on 201', async () => {
  let seenBody: unknown;
  stubFetch((url, init) => {
    assert.equal(url, `${SERVER}/v1/snapshots`);
    assert.equal((init?.method ?? '').toUpperCase(), 'POST');
    seenBody = JSON.parse(init?.body as string);
    return jsonResponse({ id: 'snap-1', deleteToken: 'tok-1' }, 201);
  });
  const result = await uploadSnapshot(SERVER, 'zENCODED');
  assert.deepEqual(result, { id: 'snap-1', deleteToken: 'tok-1' });
  assert.deepEqual(seenBody, { data: 'zENCODED' });
});

test('uploadSnapshot surfaces 413 as ShareLinkTooLargeError', async () => {
  stubFetch(() => jsonResponse({ error: { code: 'PAYLOAD_TOO_LARGE' } }, 413));
  await assert.rejects(
    () => uploadSnapshot(SERVER, 'zBIG'),
    (err) => err instanceof ShareLinkTooLargeError,
  );
});

test('uploadSnapshot throws ShareLinkError on other non-OK status', async () => {
  stubFetch(() => jsonResponse({ error: 'bad' }, 400));
  await assert.rejects(
    () => uploadSnapshot(SERVER, 'z'),
    (err) => err instanceof ShareLinkError && (err as ShareLinkError).status === 400,
  );
});

test('uploadSnapshot throws ShareLinkError on malformed success body', async () => {
  stubFetch(() => jsonResponse({ id: 123 }, 201));
  await assert.rejects(() => uploadSnapshot(SERVER, 'z'), ShareLinkError);
});

test('uploadSnapshot throws on network error and bad URL', async () => {
  stubFetch(() => {
    throw new Error('boom');
  });
  await assert.rejects(() => uploadSnapshot(SERVER, 'z'), ShareLinkError);
  await assert.rejects(() => uploadSnapshot('file:///x', 'z'), ShareLinkError);
  await assert.rejects(() => uploadSnapshot(SERVER, ''), ShareLinkError);
});

// ---------------------------------------------------------------------------
// fetchSnapshot
// ---------------------------------------------------------------------------

test('fetchSnapshot round-trips: returns the stored data string', async () => {
  stubFetch((url) => {
    assert.equal(url, `${SERVER}/v1/snapshots/snap-1`);
    return jsonResponse({ id: 'snap-1', data: 'zPAYLOAD', createdAt: '2026-01-01T00:00:00Z' });
  });
  const data = await fetchSnapshot(SERVER, 'snap-1');
  assert.equal(data, 'zPAYLOAD');
});

test('fetchSnapshot encodes the id in the path', async () => {
  let seenUrl = '';
  stubFetch((url) => {
    seenUrl = url;
    return jsonResponse({ id: 'a/b', data: 'z', createdAt: 'now' });
  });
  await fetchSnapshot(SERVER, 'a/b');
  assert.equal(seenUrl, `${SERVER}/v1/snapshots/a%2Fb`);
});

test('fetchSnapshot throws ShareLinkError(404) on not-found', async () => {
  stubFetch(() => jsonResponse({ error: { code: 'NOT_FOUND' } }, 404));
  await assert.rejects(
    () => fetchSnapshot(SERVER, 'missing'),
    (err) => err instanceof ShareLinkError && (err as ShareLinkError).status === 404,
  );
});

test('fetchSnapshot throws on malformed or empty body', async () => {
  stubFetch(() => jsonResponse({ id: 'x', createdAt: 'now' })); // no data
  await assert.rejects(() => fetchSnapshot(SERVER, 'x'), ShareLinkError);
  stubFetch(() => jsonResponse({ id: 'x', data: '', createdAt: 'now' }));
  await assert.rejects(() => fetchSnapshot(SERVER, 'x'), ShareLinkError);
});

test('fetchSnapshot rejects an untrusted (non-http) server URL before fetching', async () => {
  let called = false;
  stubFetch(() => {
    called = true;
    return jsonResponse({ data: 'z' });
  });
  await assert.rejects(() => fetchSnapshot('javascript:alert(1)', 'id'), ShareLinkError);
  assert.equal(called, false, 'must not fetch for an untrusted srv');
});
