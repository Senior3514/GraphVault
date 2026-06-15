/**
 * Tests for EncryptedVaultStore.
 *
 * Runs in Node 22+ via `node --test` (no browser required — uses the built-in
 * WebCrypto available in Node 22+).
 *
 * Test matrix:
 *  - Round-trip: save → load with correct passphrase recovers exact notes.
 *  - Wrong passphrase: load throws VaultDecryptionError, no data returned.
 *  - No data loss on wrong passphrase: source notes still readable.
 *  - Lock / unlock cycle.
 *  - encryptExisting: converts plaintext blob to encrypted in place.
 *  - decryptExisting: converts encrypted blob back to plaintext.
 *  - encryptExisting idempotent on already-encrypted blob.
 *  - decryptExisting idempotent on already-plaintext blob.
 *  - Sentinel is set on save and cleared on clear().
 *  - Empty passphrase guard (constructor + setPassphrase).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EncryptedVaultStore,
  VaultDecryptionError,
  ENCRYPTION_SENTINEL_KEY,
  type RawStorage,
} from './EncryptedVaultStore';
import type { Note } from '../types';

// ---------------------------------------------------------------------------
// In-memory RawStorage for tests (no browser required)
// ---------------------------------------------------------------------------

function makeStorage(): RawStorage & { _map: Map<string, string> } {
  const _map = new Map<string, string>();
  return {
    _map,
    getItem: (k) => _map.get(k) ?? null,
    setItem: (k, v) => {
      _map.set(k, v);
    },
    removeItem: (k) => {
      _map.delete(k);
    },
  };
}

const TEST_KEY = 'gv:test:vault';

function makeNote(path: string, content = '# Test', offset = 0): Note {
  const t = 1_000_000 + offset;
  return { path, content, mtime: t, ctime: t };
}

function makeStore(storage: RawStorage, passphrase = 'test-passphrase'): EncryptedVaultStore {
  return new EncryptedVaultStore(storage, TEST_KEY, passphrase);
}

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

test('round-trip: save then load with correct passphrase returns exact notes', async () => {
  const storage = makeStorage();
  const store = makeStore(storage);

  const notes = [
    makeNote('a.md', '# Alpha', 0),
    makeNote('b.md', '# Beta', 1),
    makeNote('notes/c.md', '# Nested', 2),
  ];

  await store.save(notes);

  // Stored value must be encrypted (not raw JSON).
  const raw = storage._map.get(TEST_KEY)!;
  assert.ok(raw, 'should have written something to storage');
  assert.ok(
    raw.startsWith('R1ZF') || !raw.startsWith('['),
    'stored value should be encrypted, not plaintext JSON',
  );

  const loaded = await store.load();
  assert.equal(loaded.length, notes.length);
  for (const original of notes) {
    const found = loaded.find((n) => n.path === original.path);
    assert.ok(found, `note ${original.path} should survive round-trip`);
    assert.equal(found.content, original.content);
    assert.equal(found.mtime, original.mtime);
    assert.equal(found.ctime, original.ctime);
  }
});

test('round-trip: empty notes array', async () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  await store.save([]);
  const loaded = await store.load();
  assert.deepEqual(loaded, []);
});

test('round-trip: notes with unicode content', async () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  const notes = [makeNote('unicode.md', '# 日本語 — héllo wörld 🔐')];
  await store.save(notes);
  const loaded = await store.load();
  assert.equal(loaded[0].content, notes[0].content);
});

// ---------------------------------------------------------------------------
// Wrong passphrase rejection — no data loss
// ---------------------------------------------------------------------------

test('wrong passphrase: load throws VaultDecryptionError', async () => {
  const storage = makeStorage();
  const store = makeStore(storage, 'correct-passphrase');
  await store.save([makeNote('x.md')]);

  const wrongStore = makeStore(storage, 'wrong-passphrase');
  await assert.rejects(
    () => wrongStore.load(),
    (err: unknown) => {
      assert.ok(err instanceof VaultDecryptionError, 'should throw VaultDecryptionError');
      return true;
    },
  );
});

test('wrong passphrase: original data is unmodified after failed load', async () => {
  const storage = makeStorage();
  const store = makeStore(storage, 'correct-passphrase');
  const notes = [makeNote('safe.md', '# Safe content')];
  await store.save(notes);

  const rawBefore = storage._map.get(TEST_KEY);

  const wrongStore = makeStore(storage, 'wrong-passphrase');
  await assert.rejects(() => wrongStore.load());

  // Storage must be byte-for-byte identical — no mutation on failed load.
  const rawAfter = storage._map.get(TEST_KEY);
  assert.equal(rawAfter, rawBefore, 'storage must not be mutated on failed load');

  // The correct store can still load.
  const recovered = await store.load();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].path, 'safe.md');
});

test('wrong passphrase: VaultDecryptionError has a meaningful message', async () => {
  const storage = makeStorage();
  const store = makeStore(storage, 'good');
  await store.save([makeNote('n.md')]);

  const wrong = makeStore(storage, 'bad');
  const err = await wrong.load().catch((e: unknown) => e);
  assert.ok(err instanceof VaultDecryptionError);
  assert.ok(
    err.message.toLowerCase().includes('decryption failed') ||
      err.message.toLowerCase().includes('wrong passphrase'),
    `message should describe failure, got: "${err.message}"`,
  );
});

// ---------------------------------------------------------------------------
// Lock / unlock
// ---------------------------------------------------------------------------

test('lock(): load throws after lock()', async () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  await store.save([makeNote('a.md')]);

  store.lock();
  assert.equal(store.isLocked, true);

  await assert.rejects(() => store.load(), VaultDecryptionError);
});

test('setPassphrase(): restores ability to load after lock', async () => {
  const storage = makeStorage();
  const store = makeStore(storage, 'pass');
  await store.save([makeNote('a.md')]);
  store.lock();
  store.setPassphrase('pass');
  assert.equal(store.isLocked, false);
  const loaded = await store.load();
  assert.equal(loaded.length, 1);
});

// ---------------------------------------------------------------------------
// encryptExisting — enable encryption on plaintext blob
// ---------------------------------------------------------------------------

test('encryptExisting: encrypts plaintext blob in place', async () => {
  const storage = makeStorage();
  const notes = [makeNote('a.md', '# Hello'), makeNote('b.md', '# World')];

  // Write plaintext JSON directly to simulate a non-encrypted vault.
  storage.setItem(TEST_KEY, JSON.stringify(notes));

  const store = makeStore(storage, 'my-passphrase');
  const result = await store.encryptExisting();

  assert.equal(result.length, 2);

  // Raw value must now be encrypted.
  const raw = storage._map.get(TEST_KEY)!;
  assert.ok(!raw.startsWith('['), 'stored value should be encrypted after encryptExisting');

  // Sentinel must be set.
  assert.equal(storage._map.get(ENCRYPTION_SENTINEL_KEY), '1');

  // Must be loadable with the same passphrase.
  const loaded = await store.load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].path, 'a.md');
});

test('encryptExisting: idempotent on already-encrypted blob', async () => {
  const storage = makeStorage();
  const store = makeStore(storage, 'pass');
  await store.save([makeNote('a.md')]);

  // Call encryptExisting again — should not throw and should return notes.
  const result = await store.encryptExisting();
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'a.md');
});

test('encryptExisting: handles empty storage (no data)', async () => {
  const storage = makeStorage();
  const store = makeStore(storage, 'pass');
  const result = await store.encryptExisting();
  assert.deepEqual(result, []);
  assert.equal(storage._map.get(ENCRYPTION_SENTINEL_KEY), '1');
});

// ---------------------------------------------------------------------------
// decryptExisting — disable encryption
// ---------------------------------------------------------------------------

test('decryptExisting: decrypts and writes plaintext back', async () => {
  const storage = makeStorage();
  const store = makeStore(storage, 'pass');
  const notes = [makeNote('a.md', '# Decrypted'), makeNote('b.md', '# Content')];
  await store.save(notes);

  const result = await store.decryptExisting();
  assert.equal(result.length, 2);

  // Raw value must now be plaintext JSON.
  const raw = storage._map.get(TEST_KEY)!;
  assert.ok(raw.startsWith('['), `stored value should be plaintext JSON, got: ${raw.slice(0, 40)}`);

  // Sentinel must be cleared.
  assert.equal(storage._map.has(ENCRYPTION_SENTINEL_KEY), false);
});

test('decryptExisting: wrong passphrase does not corrupt the blob', async () => {
  const storage = makeStorage();
  const store = makeStore(storage, 'correct');
  await store.save([makeNote('a.md')]);

  const rawBefore = storage._map.get(TEST_KEY);

  const wrongStore = makeStore(storage, 'wrong');
  await assert.rejects(() => wrongStore.decryptExisting(), VaultDecryptionError);

  // Storage must not have been mutated.
  assert.equal(storage._map.get(TEST_KEY), rawBefore);

  // Correct store can still load.
  const loaded = await store.load();
  assert.equal(loaded.length, 1);
});

test('decryptExisting: idempotent on plaintext blob', async () => {
  const storage = makeStorage();
  const notes = [makeNote('a.md')];
  storage.setItem(TEST_KEY, JSON.stringify(notes));

  const store = makeStore(storage, 'pass');
  const result = await store.decryptExisting();
  assert.equal(result.length, 1);
  assert.equal(storage._map.has(ENCRYPTION_SENTINEL_KEY), false);
});

test('decryptExisting: handles empty storage', async () => {
  const storage = makeStorage();
  const store = makeStore(storage, 'pass');
  const result = await store.decryptExisting();
  assert.deepEqual(result, []);
  assert.equal(storage._map.has(ENCRYPTION_SENTINEL_KEY), false);
});

// ---------------------------------------------------------------------------
// Enable → disable round-trip
// ---------------------------------------------------------------------------

test('enable then disable: data is preserved exactly', async () => {
  const storage = makeStorage();
  const notes = [makeNote('x.md', '# X content'), makeNote('y.md', '# Y content')];

  // Start with plaintext.
  storage.setItem(TEST_KEY, JSON.stringify(notes));

  const store = makeStore(storage, 'my-secret');

  // Enable.
  await store.encryptExisting();
  assert.equal(storage._map.get(ENCRYPTION_SENTINEL_KEY), '1');

  // Disable.
  const restored = await store.decryptExisting();
  assert.equal(restored.length, 2);
  assert.equal(restored[0].path, 'x.md');
  assert.equal(restored[1].path, 'y.md');
  assert.equal(restored[0].content, '# X content');
  assert.equal(storage._map.has(ENCRYPTION_SENTINEL_KEY), false);

  // Raw value is plaintext again.
  const raw = storage._map.get(TEST_KEY)!;
  assert.ok(raw.startsWith('['));
});

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------

test('save() sets the encryption sentinel', async () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  await store.save([makeNote('a.md')]);
  assert.equal(storage._map.get(ENCRYPTION_SENTINEL_KEY), '1');
});

test('clear() removes the blob and the sentinel', async () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  await store.save([makeNote('a.md')]);
  store.clear();
  assert.equal(storage._map.has(TEST_KEY), false);
  assert.equal(storage._map.has(ENCRYPTION_SENTINEL_KEY), false);
});

test('isEncryptedSentinel() reflects the sentinel state', async () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  assert.equal(store.isEncryptedSentinel(), false);
  await store.save([makeNote('a.md')]);
  assert.equal(store.isEncryptedSentinel(), true);
  store.clear();
  assert.equal(store.isEncryptedSentinel(), false);
});

// ---------------------------------------------------------------------------
// Input guards
// ---------------------------------------------------------------------------

test('constructor: empty passphrase throws TypeError', () => {
  const storage = makeStorage();
  assert.throws(() => new EncryptedVaultStore(storage, TEST_KEY, ''), TypeError);
});

test('setPassphrase: empty passphrase throws TypeError', () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  assert.throws(() => store.setPassphrase(''), TypeError);
});

test('load(): returns [] when no data is stored', async () => {
  const storage = makeStorage();
  const store = makeStore(storage);
  const result = await store.load();
  assert.deepEqual(result, []);
});
