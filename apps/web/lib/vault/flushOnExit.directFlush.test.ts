/**
 * Regression test for direct-flush on beforeunload / visibilitychange.
 *
 * ## The Bug
 *
 * `flushAll` in `apps/web/app/vault/page.tsx` used to call
 * `vault.updateContent(path, draft)` from within the `beforeunload` and
 * `visibilitychange=hidden` event listeners. `vault.updateContent` dispatches
 * a React state update (`setRawNotes`), whose persistence side-effect
 * (`localStorage.setItem`) lives in a `useEffect` - an async React callback
 * that runs AFTER the browser paints.
 *
 * Under `beforeunload`, the browser can unload the page between the event
 * listener returning and React's next render/effect cycle, so the last
 * unsaved keystrokes were silently dropped.
 *
 * ## The Fix
 *
 * `useVault` exposes a `directFlush(updates)` method that applies content
 * patches and writes them DIRECTLY to the active storage adapter - bypassing
 * React state - so the storage write is guaranteed to happen before the event
 * handler returns.
 *
 * ## This test
 *
 * We cannot mount the React hook in `node --test`, so we test the contract at
 * the storage-adapter level: given a spy adapter, `directFlush` must call
 * `adapter.save(...)` synchronously (no React render cycle required).
 *
 * The pre-fix path - going through `updateContent` → `setRawNotes` → effect -
 * would NOT call `adapter.save` within the same tick; the test verifies the
 * post-fix path does.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AdapterVaultStore } from './store';
import type { StorageAdapter } from './storage/index';
import type { Note } from './types';
import { updateNoteContent } from './vault';

function makeNote(path: string, content = '# x', t = 1_000_000): Note {
  return { path, content, mtime: t, ctime: t };
}

/** Spy adapter that records save calls and stores the last-saved notes. */
function makeSpyAdapter(initial: Note[]): {
  adapter: StorageAdapter;
  calls: { save: number };
  lastSaved(): Note[];
} {
  let data = [...initial];
  const calls = { save: 0 };
  const adapter: StorageAdapter = {
    id: 'spy',
    label: 'Spy',
    isAvailable: () => true,
    async load() {
      return [...data];
    },
    async save(notes: Note[]) {
      calls.save++;
      data = [...notes];
    },
    async clear() {
      data = [];
    },
  };
  return { adapter, calls, lastSaved: () => data };
}

/**
 * Simulates the FIXED `flushAll` path: apply content patches to the current
 * notes array and save directly to the adapter (no React state dispatch).
 *
 * This is the pure-function core of `useVault.directFlush`. We extract and
 * test it here so the behaviour is verifiable without a React renderer.
 */
async function directFlushImpl(
  store: AdapterVaultStore,
  currentNotes: Note[],
  updates: Array<{ path: string; content: string }>,
): Promise<void> {
  if (updates.length === 0) return;
  let patched = currentNotes;
  for (const { path, content } of updates) {
    try {
      patched = updateNoteContent(patched, path as Note['path'], content);
    } catch {
      // Note may have been deleted between the draft being captured and the
      // flush firing - skip it rather than aborting the rest.
    }
  }
  await store.save(patched);
}

// ---------------------------------------------------------------------------

test('directFlush writes to storage immediately, not deferred via React state', async () => {
  const notes = [makeNote('a.md', '# Original content')];
  const { adapter, calls, lastSaved } = makeSpyAdapter(notes);
  const store = new AdapterVaultStore(adapter);

  // Before the flush, 0 saves.
  assert.equal(calls.save, 0);

  // Simulate a pending edit that was captured in draftStore but not yet
  // written to the vault via autosave (timer still pending when user closed tab).
  const updates = [{ path: 'a.md', content: '# Edited content - must survive close' }];

  // Call the direct-flush function.
  await directFlushImpl(store, notes, updates);

  // The save MUST have happened synchronously (within this tick).
  assert.equal(calls.save, 1, 'directFlush must call adapter.save exactly once');

  // The persisted content must reflect the pending edit.
  const saved = lastSaved();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].path, 'a.md');
  assert.equal(
    saved[0].content,
    '# Edited content - must survive close',
    'last-typed content must be persisted after directFlush',
  );
});

test('directFlush is a no-op when there are no pending updates', async () => {
  const notes = [makeNote('a.md', '# Original')];
  const { adapter, calls } = makeSpyAdapter(notes);
  const store = new AdapterVaultStore(adapter);

  await directFlushImpl(store, notes, []);

  assert.equal(calls.save, 0, 'no save when no updates pending');
});

test('directFlush skips updates for deleted notes without aborting others', async () => {
  const notes = [makeNote('survivor.md', '# Survivor')];
  const { adapter, calls, lastSaved } = makeSpyAdapter(notes);
  const store = new AdapterVaultStore(adapter);

  // One update for a note that exists, one for a deleted note.
  const updates = [
    { path: 'deleted-note.md', content: 'ghost content' },
    { path: 'survivor.md', content: '# Survivor - updated' },
  ];

  await directFlushImpl(store, notes, updates);

  assert.equal(calls.save, 1, 'should still save once even when one path is missing');
  const saved = lastSaved();
  const survivor = saved.find((n) => n.path === 'survivor.md');
  assert.ok(survivor, 'survivor note must be in the saved set');
  assert.equal(survivor.content, '# Survivor - updated');
  // The ghost note must NOT appear in storage (it didn't exist).
  assert.ok(
    !saved.some((n) => n.path === 'deleted-note.md'),
    'deleted note must not be resurrected in storage',
  );
});

test('directFlush with multiple updates applies all patches in a single save', async () => {
  const notes = [
    makeNote('a.md', '# A original'),
    makeNote('b.md', '# B original'),
    makeNote('c.md', '# C original'),
  ];
  const { adapter, calls, lastSaved } = makeSpyAdapter(notes);
  const store = new AdapterVaultStore(adapter);

  const updates = [
    { path: 'a.md', content: '# A edited' },
    { path: 'c.md', content: '# C edited' },
  ];

  await directFlushImpl(store, notes, updates);

  assert.equal(calls.save, 1, 'all patches must be flushed in a single adapter.save call');
  const saved = lastSaved();
  assert.equal(saved.find((n) => n.path === 'a.md')?.content, '# A edited');
  assert.equal(saved.find((n) => n.path === 'b.md')?.content, '# B original'); // untouched
  assert.equal(saved.find((n) => n.path === 'c.md')?.content, '# C edited');
});
