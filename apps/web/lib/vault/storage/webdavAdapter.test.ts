/**
 * Tests for the WebDavStorageAdapter.
 *
 * We mock `globalThis.fetch` to simulate the GraphVault server proxy without
 * needing a real server or WebDAV instance. We also mock `sessionStorage` so
 * the token and server URL lookups work in Node.
 */

import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { WebDavStorageAdapter, WEBDAV_VAULT_FILENAME } from './webdavAdapter';
import type { Note } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'test-bearer-token';
const TEST_SERVER_URL = 'http://127.0.0.1:4000';
const EXPECTED_PROXY_URL = `${TEST_SERVER_URL}/v1/storage/webdav/proxy/${WEBDAV_VAULT_FILENAME}`;

function makeNote(path: string, content = '# Test'): Note {
  return { path, content, mtime: 1_000_000, ctime: 1_000_000 };
}

// ---------------------------------------------------------------------------
// sessionStorage mock
// ---------------------------------------------------------------------------

const sessionStorageMap = new Map<string, string>();

function installSessionStorage(): void {
  (globalThis as Record<string, unknown>)['sessionStorage'] = {
    getItem: (key: string) => sessionStorageMap.get(key) ?? null,
    setItem: (key: string, value: string) => { sessionStorageMap.set(key, value); },
    removeItem: (key: string) => { sessionStorageMap.delete(key); },
    clear: () => sessionStorageMap.clear(),
  };
}

function removeSessionStorage(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any)['sessionStorage'];
  sessionStorageMap.clear();
}

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;
let originalFetch: FetchFn | undefined;

/** In-memory "server": URL -> content string. */
const fakeStore = new Map<string, string>();

function installMockFetch(token: string): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';

    // Reject unauthorized requests.
    if (auth !== `Bearer ${token}`) {
      return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (method === 'GET') {
      const content = fakeStore.get(url);
      if (!content) {
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(content, { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (method === 'PUT') {
      let body: string;
      if (typeof init?.body === 'string') {
        body = init.body;
      } else if (init?.body instanceof Uint8Array) {
        body = new TextDecoder().decode(init.body);
      } else {
        body = '';
      }
      const existed = fakeStore.has(url);
      fakeStore.set(url, body);
      return new Response(null, { status: existed ? 204 : 201 });
    }

    if (method === 'DELETE') {
      fakeStore.delete(url);
      return new Response(null, { status: 204 });
    }

    return new Response('Method not allowed', { status: 405 });
  };
}

function restoreFetch(): void {
  if (originalFetch !== undefined) {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

before(() => {
  installSessionStorage();
  installMockFetch(TEST_TOKEN);
});

after(() => {
  removeSessionStorage();
  restoreFetch();
});

beforeEach(() => {
  fakeStore.clear();
  sessionStorageMap.clear();
  // Set up token and server URL.
  sessionStorageMap.set('gv:auth:token', TEST_TOKEN);
  sessionStorageMap.set('gv:serverUrl', TEST_SERVER_URL);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('isAvailable() returns false without sessionStorage', () => {
  removeSessionStorage();
  const adapter = new WebDavStorageAdapter();
  assert.equal(adapter.isAvailable(), false);
  installSessionStorage();
});

test('isAvailable() returns false without a token', () => {
  sessionStorageMap.delete('gv:auth:token');
  const adapter = new WebDavStorageAdapter();
  assert.equal(adapter.isAvailable(), false);
});

test('isAvailable() returns true when token is present', () => {
  sessionStorageMap.set('gv:auth:token', TEST_TOKEN);
  const adapter = new WebDavStorageAdapter();
  assert.equal(adapter.isAvailable(), true);
});

test('load() returns empty array when vault does not exist on WebDAV (404)', async () => {
  const adapter = new WebDavStorageAdapter();
  const notes = await adapter.load();
  assert.deepEqual(notes, []);
});

test('save() puts a vault document to the proxy URL', async () => {
  const adapter = new WebDavStorageAdapter();
  const notes = [makeNote('hello.md', '# Hello'), makeNote('world.md', '# World')];
  await adapter.save(notes);

  // The fake store should now have the vault document.
  const raw = fakeStore.get(EXPECTED_PROXY_URL);
  assert.ok(raw, 'vault document should be stored');
  const doc = JSON.parse(raw) as { version: number; notes: Note[] };
  assert.equal(doc.version, 1);
  assert.equal(doc.notes.length, 2);
  assert.equal(doc.notes[0].path, 'hello.md');
});

test('load() deserialises notes after save()', async () => {
  const adapter = new WebDavStorageAdapter();
  const original = [makeNote('a.md', '# A'), makeNote('b.md', '# B')];
  await adapter.save(original);

  const loaded = await adapter.load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].path, 'a.md');
  assert.equal(loaded[0].content, '# A');
  assert.equal(loaded[1].path, 'b.md');
});

test('save() then load() is idempotent (round-trip)', async () => {
  const adapter = new WebDavStorageAdapter();
  const notes = [
    makeNote('notes/idea.md', '## An idea'),
    makeNote('journal/2026-06-15.md', '## Entry'),
  ];
  await adapter.save(notes);
  const loaded = await adapter.load();

  assert.equal(loaded.length, notes.length);
  for (const orig of notes) {
    const found = loaded.find((n) => n.path === orig.path);
    assert.ok(found, `${orig.path} should survive round-trip`);
    assert.equal(found.content, orig.content);
    assert.equal(found.mtime, orig.mtime);
    assert.equal(found.ctime, orig.ctime);
  }
});

test('clear() deletes the vault document from WebDAV', async () => {
  const adapter = new WebDavStorageAdapter();
  await adapter.save([makeNote('x.md')]);
  assert.ok(fakeStore.has(EXPECTED_PROXY_URL), 'should exist before clear');

  await adapter.clear();

  // After DELETE the fake store should no longer have the key.
  assert.equal(fakeStore.has(EXPECTED_PROXY_URL), false, 'should be removed after clear');
});

test('clear() is a no-op when not signed in', async () => {
  sessionStorageMap.delete('gv:auth:token');
  const adapter = new WebDavStorageAdapter();
  // Should not throw.
  await assert.doesNotReject(() => adapter.clear());
});

test('save() throws when not signed in', async () => {
  sessionStorageMap.delete('gv:auth:token');
  const adapter = new WebDavStorageAdapter();
  await assert.rejects(() => adapter.save([makeNote('x.md')]), /not signed in/i);
});

test('load() throws when not signed in', async () => {
  sessionStorageMap.delete('gv:auth:token');
  const adapter = new WebDavStorageAdapter();
  await assert.rejects(() => adapter.load(), /not signed in/i);
});

test('load() throws on corrupt vault document', async () => {
  // PUT bad JSON into the fake store.
  fakeStore.set(EXPECTED_PROXY_URL, 'this is not json at all');
  const adapter = new WebDavStorageAdapter();
  await assert.rejects(() => adapter.load(), /corrupt/i);
});

test('adapter has correct id and label', () => {
  const adapter = new WebDavStorageAdapter();
  assert.equal(adapter.id, 'webdav');
  assert.equal(typeof adapter.label, 'string');
  assert.ok(adapter.label.toLowerCase().includes('webdav'));
});
