/**
 * Tests for the S3StorageAdapter.
 *
 * We mock `globalThis.fetch` to simulate the GraphVault server proxy without
 * needing a real server or S3 instance. We also mock `sessionStorage` so
 * the token and server URL lookups work in Node.
 */

import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { S3StorageAdapter, S3_VAULT_OBJECT_KEY } from './s3Adapter';
import type { Note } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'test-bearer-token-s3';
const TEST_SERVER_URL = 'http://127.0.0.1:4000';
const EXPECTED_PROXY_URL = `${TEST_SERVER_URL}/v1/storage/s3/object/${S3_VAULT_OBJECT_KEY}`;

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
    setItem: (key: string, value: string) => {
      sessionStorageMap.set(key, value);
    },
    removeItem: (key: string) => {
      sessionStorageMap.delete(key);
    },
    clear: () => sessionStorageMap.clear(),
  };
}

function removeSessionStorage(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any)['sessionStorage'];
  sessionStorageMap.clear();
}

const localStorageMap = new Map<string, string>();

function installLocalStorage(): void {
  (globalThis as Record<string, unknown>)['localStorage'] = {
    getItem: (key: string) => localStorageMap.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageMap.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageMap.delete(key);
    },
    clear: () => localStorageMap.clear(),
  };
}

function removeLocalStorage(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any)['localStorage'];
  localStorageMap.clear();
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
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';

    // Reject unauthorized requests.
    if (auth !== `Bearer ${token}`) {
      return new Response(
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    }

    if (method === 'GET') {
      const content = fakeStore.get(url);
      if (!content) {
        return new Response(
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(content, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
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
      fakeStore.set(url, body);
      return new Response(null, { status: 200 });
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
  installLocalStorage();
  installMockFetch(TEST_TOKEN);
});

after(() => {
  removeSessionStorage();
  removeLocalStorage();
  restoreFetch();
});

beforeEach(() => {
  fakeStore.clear();
  sessionStorageMap.clear();
  localStorageMap.clear();
  // Set up token and server URL.
  sessionStorageMap.set('graphvault:auth-token:v1', TEST_TOKEN);
  localStorageMap.set('graphvault:server-url', TEST_SERVER_URL);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('isAvailable() returns false without sessionStorage', () => {
  removeSessionStorage();
  const adapter = new S3StorageAdapter();
  assert.equal(adapter.isAvailable(), false);
  installSessionStorage();
});

test('isAvailable() returns false without a token', () => {
  sessionStorageMap.delete('graphvault:auth-token:v1');
  const adapter = new S3StorageAdapter();
  assert.equal(adapter.isAvailable(), false);
});

test('isAvailable() returns true when token is present', () => {
  sessionStorageMap.set('graphvault:auth-token:v1', TEST_TOKEN);
  const adapter = new S3StorageAdapter();
  assert.equal(adapter.isAvailable(), true);
});

test('load() returns empty array when vault object does not exist in S3 (404)', async () => {
  const adapter = new S3StorageAdapter();
  const notes = await adapter.load();
  assert.deepEqual(notes, []);
});

test('save() puts a vault document to the S3 proxy URL', async () => {
  const adapter = new S3StorageAdapter();
  const notes = [makeNote('hello.md', '# Hello'), makeNote('world.md', '# World')];
  await adapter.save(notes);

  const raw = fakeStore.get(EXPECTED_PROXY_URL);
  assert.ok(raw, 'vault document should be stored');
  const doc = JSON.parse(raw) as { version: number; notes: Note[] };
  assert.equal(doc.version, 1);
  assert.equal(doc.notes.length, 2);
  assert.equal(doc.notes[0].path, 'hello.md');
});

test('load() deserialises notes after save()', async () => {
  const adapter = new S3StorageAdapter();
  const original = [makeNote('a.md', '# A'), makeNote('b.md', '# B')];
  await adapter.save(original);

  const loaded = await adapter.load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].path, 'a.md');
  assert.equal(loaded[0].content, '# A');
  assert.equal(loaded[1].path, 'b.md');
});

test('save() then load() is idempotent (round-trip)', async () => {
  const adapter = new S3StorageAdapter();
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

test('clear() deletes the vault object from S3', async () => {
  const adapter = new S3StorageAdapter();
  await adapter.save([makeNote('x.md')]);
  assert.ok(fakeStore.has(EXPECTED_PROXY_URL), 'should exist before clear');

  await adapter.clear();

  assert.equal(fakeStore.has(EXPECTED_PROXY_URL), false, 'should be removed after clear');
});

test('clear() is a no-op when not signed in', async () => {
  sessionStorageMap.delete('graphvault:auth-token:v1');
  const adapter = new S3StorageAdapter();
  await assert.doesNotReject(() => adapter.clear());
});

test('save() throws when not signed in', async () => {
  sessionStorageMap.delete('graphvault:auth-token:v1');
  const adapter = new S3StorageAdapter();
  await assert.rejects(() => adapter.save([makeNote('x.md')]), /not signed in/i);
});

test('load() throws when not signed in', async () => {
  sessionStorageMap.delete('graphvault:auth-token:v1');
  const adapter = new S3StorageAdapter();
  await assert.rejects(() => adapter.load(), /not signed in/i);
});

test('load() throws on corrupt vault document', async () => {
  fakeStore.set(EXPECTED_PROXY_URL, 'this is not json at all');
  const adapter = new S3StorageAdapter();
  await assert.rejects(() => adapter.load(), /corrupt/i);
});

test('adapter has correct id and label', () => {
  const adapter = new S3StorageAdapter();
  assert.equal(adapter.id, 's3');
  assert.equal(typeof adapter.label, 'string');
  assert.ok(adapter.label.toLowerCase().includes('s3'));
});

test('S3_VAULT_OBJECT_KEY is the expected filename', () => {
  assert.equal(S3_VAULT_OBJECT_KEY, 'graphvault-vault.json');
});
