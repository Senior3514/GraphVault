/**
 * Tests for the localStorage storage adapter and the adapter registry.
 *
 * We run in Node (via `node --test`), so `window.localStorage` is absent.
 * We mock it with a minimal in-memory implementation to exercise every code
 * path, including the seed-on-first-run and corrupt-backup behaviour.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { localStorageAdapter, LOCAL_STORAGE_KEY } from './localStorageAdapter';
import {
  registerAdapter,
  getActiveAdapter,
  getAdapterById,
  listAdapters,
  _resetRegistry,
  type StorageAdapter,
} from './index';
import type { Note } from '../types';

// ---------------------------------------------------------------------------
// Minimal localStorage mock
// ---------------------------------------------------------------------------

type StorageMap = Map<string, string>;

function makeLocalStorage(map: StorageMap) {
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
  };
}

/** Install a fresh in-memory localStorage on the global `window`. */
function installMockStorage(): StorageMap {
  const map: StorageMap = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = {
    localStorage: makeLocalStorage(map),
  };
  return map;
}

/** Remove the mock so `hasLocalStorage()` returns false again. */
function removeMockStorage(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeNote(path: string, content = '# Test', offset = 0): Note {
  const t = 1_000_000 + offset;
  return { path, content, mtime: t, ctime: t };
}

// ---------------------------------------------------------------------------
// localStorage adapter tests
// ---------------------------------------------------------------------------

test('localStorageAdapter.isAvailable() returns false without window', () => {
  removeMockStorage();
  assert.equal(localStorageAdapter.isAvailable(), false);
});

test('localStorageAdapter.isAvailable() returns true with mock window.localStorage', () => {
  installMockStorage();
  assert.equal(localStorageAdapter.isAvailable(), true);
  removeMockStorage();
});

test('load() seeds notes on first run and persists them', async () => {
  const map = installMockStorage();
  assert.equal(map.has(LOCAL_STORAGE_KEY), false, 'storage should be empty before load');

  const notes = await localStorageAdapter.load();

  assert.ok(notes.length > 0, 'seed notes should be returned');
  assert.ok(map.has(LOCAL_STORAGE_KEY), 'seed notes should be persisted');

  const stored = JSON.parse(map.get(LOCAL_STORAGE_KEY)!) as Note[];
  assert.equal(stored.length, notes.length);
  removeMockStorage();
});

test('load() returns stored notes on subsequent calls', async () => {
  const map = installMockStorage();
  const existing: Note[] = [makeNote('a.md', '# A'), makeNote('b.md', '# B')];
  map.set(LOCAL_STORAGE_KEY, JSON.stringify(existing));

  const loaded = await localStorageAdapter.load();

  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].path, 'a.md');
  assert.equal(loaded[1].path, 'b.md');
  removeMockStorage();
});

test('load() filters out non-note entries from stored array', async () => {
  const map = installMockStorage();
  const mixed: unknown[] = [
    makeNote('good.md'),
    { path: 42, content: 'bad', mtime: 0, ctime: 0 }, // path not string
    null,
    'just a string',
    makeNote('also-good.md'),
  ];
  map.set(LOCAL_STORAGE_KEY, JSON.stringify(mixed));

  const loaded = await localStorageAdapter.load();

  assert.equal(loaded.length, 2, 'only valid notes should survive');
  assert.ok(loaded.some((n) => n.path === 'good.md'));
  assert.ok(loaded.some((n) => n.path === 'also-good.md'));
  removeMockStorage();
});

test('load() backs up corrupt JSON and reseeds', async () => {
  const map = installMockStorage();
  const corrupt = '{ not valid json :::';
  map.set(LOCAL_STORAGE_KEY, corrupt);

  const notes = await localStorageAdapter.load();

  assert.ok(notes.length > 0, 'should return seed notes after corrupt data');
  assert.equal(
    map.get(`${LOCAL_STORAGE_KEY}:corrupt-backup`),
    corrupt,
    'corrupt data should be backed up',
  );
  // Primary key should now contain valid seed notes.
  const primary = JSON.parse(map.get(LOCAL_STORAGE_KEY)!) as Note[];
  assert.ok(primary.length > 0);
  removeMockStorage();
});

test('load() backs up non-array JSON and reseeds', async () => {
  const map = installMockStorage();
  const nonArray = JSON.stringify({ not: 'an array' });
  map.set(LOCAL_STORAGE_KEY, nonArray);

  const notes = await localStorageAdapter.load();

  assert.ok(notes.length > 0, 'should return seed notes after non-array JSON');
  assert.equal(
    map.get(`${LOCAL_STORAGE_KEY}:corrupt-backup`),
    nonArray,
    'non-array value should be backed up',
  );
  removeMockStorage();
});

test('save() writes notes as JSON to localStorage', async () => {
  const map = installMockStorage();
  const notes = [makeNote('test.md', '# Test')];

  await localStorageAdapter.save(notes);

  const stored = JSON.parse(map.get(LOCAL_STORAGE_KEY)!) as Note[];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].path, 'test.md');
  removeMockStorage();
});

test('save() overwrites previous data', async () => {
  const map = installMockStorage();
  await localStorageAdapter.save([makeNote('old.md')]);
  await localStorageAdapter.save([makeNote('new.md')]);

  const stored = JSON.parse(map.get(LOCAL_STORAGE_KEY)!) as Note[];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].path, 'new.md');
  removeMockStorage();
});

test('clear() removes the primary storage key', async () => {
  const map = installMockStorage();
  map.set(LOCAL_STORAGE_KEY, JSON.stringify([makeNote('a.md')]));

  await localStorageAdapter.clear();

  assert.equal(map.has(LOCAL_STORAGE_KEY), false);
  removeMockStorage();
});

test('clear() followed by load() reseeds the vault', async () => {
  const map = installMockStorage();
  map.set(LOCAL_STORAGE_KEY, JSON.stringify([makeNote('a.md')]));

  await localStorageAdapter.clear();
  const notes = await localStorageAdapter.load();

  assert.ok(notes.length > 0, 'should reseed after clear');
  removeMockStorage();
});

test('save() and load() are idempotent', async () => {
  installMockStorage();
  const notes = [makeNote('x.md', '# X', 0), makeNote('y.md', '# Y', 1)];

  await localStorageAdapter.save(notes);
  const loaded = await localStorageAdapter.load();

  assert.equal(loaded.length, notes.length);
  for (const original of notes) {
    const found = loaded.find((n) => n.path === original.path);
    assert.ok(found, `note ${original.path} should survive a round-trip`);
    assert.equal(found.content, original.content);
    assert.equal(found.mtime, original.mtime);
    assert.equal(found.ctime, original.ctime);
  }
  removeMockStorage();
});

test('all adapter methods are no-ops (no throw) when localStorage is absent', async () => {
  removeMockStorage();
  // load() falls back to seed notes when localStorage is absent.
  const notes = await localStorageAdapter.load();
  assert.ok(notes.length > 0, 'should return seed notes when localStorage unavailable');

  // save() and clear() are no-ops - must not throw.
  await assert.doesNotReject(() => localStorageAdapter.save([makeNote('a.md')]));
  await assert.doesNotReject(() => localStorageAdapter.clear());
});

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

// Use a fresh sub-scope to avoid polluting other tests' registry state.
test('registry: registerAdapter / getActiveAdapter / listAdapters', async (t) => {
  // Isolate each sub-test with _resetRegistry so the module-level
  // registrations from store.ts don't interfere.

  await t.test('getActiveAdapter() throws when no adapters are registered', () => {
    _resetRegistry();
    assert.throws(() => getActiveAdapter(), /no storage adapter/i);
  });

  await t.test('getActiveAdapter() skips unavailable adapters and returns the first available', () => {
    _resetRegistry();

    const unavailable: StorageAdapter = {
      id: 'unavailable',
      label: 'Unavailable',
      isAvailable: () => false,
      load: async () => [],
      save: async () => {},
      clear: async () => {},
    };

    const available: StorageAdapter = {
      id: 'available',
      label: 'Available',
      isAvailable: () => true,
      load: async () => [],
      save: async () => {},
      clear: async () => {},
    };

    registerAdapter(unavailable);
    registerAdapter(available);

    const active = getActiveAdapter();
    assert.equal(active.id, 'available');
  });

  await t.test('getAdapterById() returns the matching adapter or undefined', () => {
    _resetRegistry();

    const a: StorageAdapter = {
      id: 'alpha',
      label: 'Alpha',
      isAvailable: () => true,
      load: async () => [],
      save: async () => {},
      clear: async () => {},
    };

    registerAdapter(a);
    assert.equal(getAdapterById('alpha')?.id, 'alpha');
    assert.equal(getAdapterById('nope'), undefined);
  });

  await t.test('listAdapters() returns a copy of the registered adapters', () => {
    _resetRegistry();

    const a: StorageAdapter = {
      id: 'a',
      label: 'A',
      isAvailable: () => true,
      load: async () => [],
      save: async () => {},
      clear: async () => {},
    };
    const b: StorageAdapter = {
      id: 'b',
      label: 'B',
      isAvailable: () => false,
      load: async () => [],
      save: async () => {},
      clear: async () => {},
    };

    registerAdapter(a);
    registerAdapter(b);

    const list = listAdapters();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'a');
    assert.equal(list[1].id, 'b');

    // Mutating the returned array must not affect the registry.
    (list as StorageAdapter[]).push({
      id: 'c',
      label: 'C',
      isAvailable: () => true,
      load: async () => [],
      save: async () => {},
      clear: async () => {},
    });
    assert.equal(listAdapters().length, 2);
  });

  await t.test('first available adapter takes priority', () => {
    _resetRegistry();

    const first: StorageAdapter = {
      id: 'first',
      label: 'First',
      isAvailable: () => true,
      load: async () => [],
      save: async () => {},
      clear: async () => {},
    };

    const second: StorageAdapter = {
      id: 'second',
      label: 'Second',
      isAvailable: () => true,
      load: async () => [],
      save: async () => {},
      clear: async () => {},
    };

    registerAdapter(first);
    registerAdapter(second);

    assert.equal(getActiveAdapter().id, 'first');
  });

  // Clean up after these sub-tests so the module is in a clean state.
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// FileSystem adapter availability guard
// ---------------------------------------------------------------------------

test('fileSystemAdapter is unavailable in Node (no showDirectoryPicker)', async () => {
  const { fileSystemAdapter } = await import('./fileSystemAdapter');
  // In Node there is no window.showDirectoryPicker, so it must return false.
  assert.equal(fileSystemAdapter.isAvailable(), false);
});
