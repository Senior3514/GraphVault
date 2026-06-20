/**
 * Regression test for the storage-switch "reload" path (fix #5).
 *
 * Before the fix, the Settings storage-switch handlers called
 * `useVault.resetVault()` after migrating to a new backend. `resetVault()` does
 * `store.clear()` + reseed, which WIPED the freshly-migrated backend and broke
 * the migration's "source preserved" promise.
 *
 * The fix adds a non-destructive `reload()` to `useVault` that does `store.load()`
 * → setRawNotes with NO clear. We can't mount the React hook in `node --test`,
 * but we CAN assert the contract that distinguishes the two paths on the
 * `AdapterVaultStore` the hook delegates to:
 *
 *   - reload  → adapter.load()  only           (clear NEVER called)
 *   - reset   → adapter.clear() then load()    (data wiped)
 *
 * This pins the behavioural difference the fix relies on.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AdapterVaultStore } from './store';
import type { StorageAdapter } from './storage/index';
import type { Note } from './types';

function makeNote(path: string, content = '# x'): Note {
  return { path, content, mtime: 1, ctime: 1 };
}

/** A spy adapter recording load/clear/save calls over an in-memory note set. */
function makeSpyAdapter(initial: Note[]): {
  adapter: StorageAdapter;
  calls: { load: number; clear: number; save: number };
  current(): Note[];
} {
  let data = [...initial];
  const calls = { load: 0, clear: 0, save: 0 };
  const adapter: StorageAdapter = {
    id: 'spy',
    label: 'Spy',
    isAvailable: () => true,
    async load() {
      calls.load++;
      return [...data];
    },
    async save(notes: Note[]) {
      calls.save++;
      data = [...notes];
    },
    async clear() {
      calls.clear++;
      data = [];
    },
  };
  return { adapter, calls, current: () => data };
}

test('reload path (store.load) returns migrated notes WITHOUT clearing the backend', async () => {
  const migrated = [makeNote('a.md'), makeNote('b.md')];
  const { adapter, calls } = makeSpyAdapter(migrated);
  const store = new AdapterVaultStore(adapter);

  // This is exactly what useVault.reload() does: load, no clear.
  const loaded = await store.load();

  assert.equal(calls.clear, 0, 'reload must NOT clear the active backend');
  assert.equal(calls.load, 1);
  assert.deepEqual(
    loaded.map((n) => n.path),
    ['a.md', 'b.md'],
    'reload surfaces the migrated notes intact',
  );
});

test('reset path (store.clear) wipes the backend — showing why reload is required', async () => {
  const migrated = [makeNote('a.md'), makeNote('b.md')];
  const { adapter, calls, current } = makeSpyAdapter(migrated);
  const store = new AdapterVaultStore(adapter);

  // This is the OLD, destructive behaviour the storage-switch handlers used.
  await store.clear();

  assert.equal(calls.clear, 1);
  assert.deepEqual(current(), [], 'clear() wipes the just-migrated backend (the bug)');
});
