/**
 * HTTP client tests against a stubbed global `fetch`.
 *
 * No real network calls are made: every test injects a `fetchImpl` stub that
 * records the requested URL/headers and returns canned `Response` objects.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileState } from '@graphvault/shared';
import { GraphVaultApiError, GraphVaultClient } from './client.js';

const TOKEN = 'secret-token-do-not-log';
const BASE = 'https://vault.example.com';

interface Recorded {
  url: string;
  headers: Headers;
}

/** Build a fetch stub that returns `responses` in sequence and records calls. */
function stubFetch(responses: Response[]): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
    });
    const res = responses[i++];
    if (!res) throw new Error('stubFetch: no response queued');
    return res;
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeState(over: Partial<FileState>): FileState {
  return {
    path: 'note.md',
    hash: 'sha256:' + 'a'.repeat(64),
    size: 10,
    mtime: 1,
    deleted: false,
    revision: 1,
    ...over,
  };
}

test('listVaults sends a bearer token and parses the array', async () => {
  const { fetchImpl, calls } = stubFetch([json([{ id: 'v1', name: 'Personal' }])]);
  const client = new GraphVaultClient({ serverUrl: BASE, token: TOKEN }, { fetchImpl });

  const vaults = await client.listVaults();
  assert.deepEqual(vaults, [{ id: 'v1', name: 'Personal' }]);
  assert.equal(calls[0]?.url, `${BASE}/v1/vaults`);
  assert.equal(calls[0]?.headers.get('authorization'), `Bearer ${TOKEN}`);
});

test('the token is never embedded in a thrown error message', async () => {
  const { fetchImpl } = stubFetch([
    json({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }, 401),
  ]);
  const client = new GraphVaultClient({ serverUrl: BASE, token: TOKEN }, { fetchImpl });

  await assert.rejects(
    () => client.listVaults(),
    (err: unknown) => {
      assert.ok(err instanceof GraphVaultApiError);
      assert.equal(err.status, 401);
      assert.equal(err.code, 'UNAUTHORIZED');
      assert.ok(!err.message.includes(TOKEN), 'token must not leak into the error');
      assert.ok(err.message.includes('Authentication failed'));
      return true;
    },
  );
});

test('a non-2xx with the error envelope surfaces code + message', async () => {
  const { fetchImpl } = stubFetch([
    json({ error: { code: 'NOT_FOUND', message: 'Blob not found' } }, 404),
  ]);
  const client = new GraphVaultClient({ serverUrl: BASE, token: TOKEN }, { fetchImpl });

  await assert.rejects(
    () => client.getBlob('sha256:' + 'b'.repeat(64)),
    (err: unknown) => {
      assert.ok(err instanceof GraphVaultApiError);
      assert.equal(err.status, 404);
      assert.equal(err.code, 'NOT_FOUND');
      assert.match(err.message, /Blob not found/);
      return true;
    },
  );
});

test('a transport-level failure becomes a GraphVaultApiError(status 0)', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new TypeError('network down');
  };
  const client = new GraphVaultClient({ serverUrl: BASE, token: TOKEN }, { fetchImpl });

  await assert.rejects(
    () => client.listVaults(),
    (err: unknown) => {
      assert.ok(err instanceof GraphVaultApiError);
      assert.equal(err.status, 0);
      assert.match(err.message, /Network error/);
      return true;
    },
  );
});

test('getBlobText decodes UTF-8 octet-stream bytes', async () => {
  const bytes = new TextEncoder().encode('# Héllo wörld');
  const { fetchImpl, calls } = stubFetch([
    new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
  ]);
  const client = new GraphVaultClient({ serverUrl: BASE, token: TOKEN }, { fetchImpl });

  const text = await client.getBlobText('sha256:' + 'c'.repeat(64));
  assert.equal(text, '# Héllo wörld');
  assert.match(calls[0]?.url ?? '', /\/v1\/blobs\/sha256/);
});

test('listAllFileStates paginates using the max revision until hasMore is false', async () => {
  const page1 = {
    revision: 4,
    changes: [makeState({ path: 'a.md', revision: 1 }), makeState({ path: 'b.md', revision: 2 })],
    hasMore: true,
  };
  const page2 = {
    revision: 4,
    changes: [makeState({ path: 'c.md', revision: 4 })],
    hasMore: false,
  };
  const { fetchImpl, calls } = stubFetch([json(page1), json(page2)]);
  const client = new GraphVaultClient({ serverUrl: BASE, token: TOKEN }, { fetchImpl });

  const states = await client.listAllFileStates('v1', 2);
  assert.equal(states.length, 3);
  assert.deepEqual(
    states.map((s) => s.path),
    ['a.md', 'b.md', 'c.md'],
  );
  // First page since=0, second page since=2 (max revision of page 1).
  assert.match(calls[0]?.url ?? '', /since=0&limit=2/);
  assert.match(calls[1]?.url ?? '', /since=2&limit=2/);
});

test('listAllFileStates stops when revision does not advance (no infinite loop)', async () => {
  // hasMore is true but revision never advances past `since`; must terminate.
  const stuck = {
    revision: 1,
    changes: [makeState({ path: 'a.md', revision: 0 })],
    hasMore: true,
  };
  const { fetchImpl, calls } = stubFetch([json(stuck), json(stuck), json(stuck)]);
  const client = new GraphVaultClient({ serverUrl: BASE, token: TOKEN }, { fetchImpl });

  const states = await client.listAllFileStates('v1', 100);
  assert.equal(states.length, 1);
  assert.equal(calls.length, 1, 'should not page again when revision <= since');
});
