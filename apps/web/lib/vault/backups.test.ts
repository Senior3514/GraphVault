/**
 * Tests for BackupStore.
 *
 * Uses an in-memory fake IDBStore - no browser or IndexedDB APIs required.
 * Runs in Node via `node --test`.
 *
 * Test matrix:
 *  - takeSnapshot stores a snapshot with correct metadata and notesJson.
 *  - listSnapshots returns newest-first without notesJson.
 *  - getSnapshot returns the full snapshot including notesJson.
 *  - deleteSnapshot removes it from the store.
 *  - pruneOld: keeps RETENTION_RECENT newest unconditionally.
 *  - pruneOld: keeps one-per-day within the daily window.
 *  - pruneOld: deletes snapshots outside both windows.
 *  - restoreSnapshot: takes a pre-restore snapshot before restoring.
 *  - restoreSnapshot: applies collision-safe merge (identical notes de-duped).
 *  - restoreSnapshot: collision with different content becomes "(imported)" copy.
 *  - restoreSnapshot: returns undefined for unknown id (no state mutation).
 *  - restoreSnapshot: throws on corrupt notesJson.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BackupStore,
  RETENTION_RECENT,
  RETENTION_DAILY_DAYS,
  type IDBStore,
  type Snapshot,
} from './backups';
import { mergeImport } from './vault';
import type { Note } from './types';

// ---------------------------------------------------------------------------
// Fake IDBStore
// ---------------------------------------------------------------------------

function makeFakeStore(): IDBStore & { _map: Map<string, Snapshot> } {
  const _map = new Map<string, Snapshot>();
  return {
    _map,
    async put(s: Snapshot) {
      _map.set(s.id, s);
    },
    async get(id: string) {
      return _map.get(id);
    },
    async getAll() {
      return Array.from(_map.values()).sort((a, b) => a.takenAt - b.takenAt);
    },
    async delete(id: string) {
      _map.delete(id);
    },
  };
}

function makeNote(path: string, content = `# ${path}`, offset = 0): Note {
  const t = 1_000_000 + offset;
  return { path, content, mtime: t, ctime: t };
}

function makeStore() {
  const fake = makeFakeStore();
  const backup = new BackupStore(fake);
  return { backup, fake };
}

// ---------------------------------------------------------------------------
// takeSnapshot
// ---------------------------------------------------------------------------

test('takeSnapshot stores a snapshot with correct metadata', async () => {
  const { backup, fake } = makeStore();
  const notes = [makeNote('a.md'), makeNote('b.md')];

  const id = await backup.takeSnapshot(notes, 'test-label');

  assert.ok(typeof id === 'string' && id.length > 0, 'id should be a non-empty string');
  const stored = fake._map.get(id);
  assert.ok(stored, 'snapshot should be in store');
  assert.equal(stored.noteCount, 2);
  assert.equal(stored.label, 'test-label');
  assert.ok(stored.takenAt > 0);
  const parsed = JSON.parse(stored.notesJson) as Note[];
  assert.deepEqual(parsed, notes);
});

test('takeSnapshot without label stores no label field', async () => {
  const { backup, fake } = makeStore();
  const id = await backup.takeSnapshot([makeNote('a.md')]);
  const stored = fake._map.get(id);
  assert.ok(stored);
  assert.equal(stored.label, undefined);
});

// ---------------------------------------------------------------------------
// listSnapshots
// ---------------------------------------------------------------------------

test('listSnapshots returns newest-first without notesJson', async () => {
  const { backup } = makeStore();
  const id1 = await backup.takeSnapshot([makeNote('a.md')]);
  const id2 = await backup.takeSnapshot([makeNote('b.md')]);

  const list = await backup.listSnapshots();
  assert.equal(list.length, 2);
  // newest first
  assert.equal(list[0].id, id2);
  assert.equal(list[1].id, id1);
  // no notesJson on meta
  for (const meta of list) {
    assert.ok(!('notesJson' in meta), 'listSnapshots must not include notesJson');
  }
});

// ---------------------------------------------------------------------------
// getSnapshot
// ---------------------------------------------------------------------------

test('getSnapshot returns the full snapshot including notesJson', async () => {
  const { backup } = makeStore();
  const notes = [makeNote('x.md')];
  const id = await backup.takeSnapshot(notes);

  const snap = await backup.getSnapshot(id);
  assert.ok(snap);
  assert.equal(snap.id, id);
  assert.equal(snap.noteCount, 1);
  assert.ok(typeof snap.notesJson === 'string');
  assert.deepEqual(JSON.parse(snap.notesJson), notes);
});

test('getSnapshot returns undefined for unknown id', async () => {
  const { backup } = makeStore();
  const result = await backup.getSnapshot('does-not-exist');
  assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// deleteSnapshot
// ---------------------------------------------------------------------------

test('deleteSnapshot removes the snapshot', async () => {
  const { backup } = makeStore();
  const id = await backup.takeSnapshot([makeNote('a.md')]);

  await backup.deleteSnapshot(id);

  const after = await backup.listSnapshots();
  assert.equal(after.length, 0);
});

test('deleteSnapshot is a no-op for unknown id', async () => {
  const { backup } = makeStore();
  await backup.takeSnapshot([makeNote('a.md')]);
  // Should not throw
  await backup.deleteSnapshot('ghost-id');
  const after = await backup.listSnapshots();
  assert.equal(after.length, 1);
});

// ---------------------------------------------------------------------------
// pruneOld - retention policy
// ---------------------------------------------------------------------------

test('pruneOld keeps RETENTION_RECENT newest regardless of age', async () => {
  const { backup, fake } = makeStore();

  // Create RETENTION_RECENT + 5 snapshots far in the past (outside daily window)
  const oldTime = Date.now() - (RETENTION_DAILY_DAYS + 10) * 24 * 60 * 60 * 1000;
  for (let i = 0; i < RETENTION_RECENT + 5; i++) {
    const id = `old-${i}`;
    const snap: Snapshot = {
      id,
      takenAt: oldTime + i * 1000, // 1s apart, all old
      noteCount: 1,
      notesJson: '[]',
    };
    await fake.put(snap);
  }

  await backup.pruneOld();

  const remaining = await backup.listSnapshots();
  assert.equal(remaining.length, RETENTION_RECENT, 'should keep exactly RETENTION_RECENT');
});

test('pruneOld deletes snapshots outside both windows', async () => {
  const { backup, fake } = makeStore();

  // 1 old snapshot (outside all windows)
  const veryOld: Snapshot = {
    id: 'very-old',
    takenAt: 1_000_000, // epoch 1970
    noteCount: 0,
    notesJson: '[]',
  };
  await fake.put(veryOld);

  // RETENTION_RECENT recent snapshots (these will be kept)
  const now = Date.now();
  for (let i = 0; i < RETENTION_RECENT; i++) {
    const snap: Snapshot = {
      id: `recent-${i}`,
      takenAt: now - i * 1000,
      noteCount: 1,
      notesJson: '[]',
    };
    await fake.put(snap);
  }

  await backup.pruneOld();

  const remaining = await backup.listSnapshots();
  assert.ok(!remaining.some((s) => s.id === 'very-old'), 'very old snapshot should be pruned');
  assert.equal(remaining.length, RETENTION_RECENT);
});

test('pruneOld keeps one-per-day within daily window', async () => {
  const { backup, fake } = makeStore();

  // To exercise the per-day logic we need more than RETENTION_RECENT snapshots
  // so that the older ones actually fall out of the "keep recent" window.
  // Strategy: put RETENTION_RECENT+5 snapshots on "day 1" (5 days ago) spread
  // across the same calendar day, plus one snapshot on "day 2" (4 days ago).
  // After pruning:
  //   - The RETENTION_RECENT newest overall are kept unconditionally (day 1 newest + day2).
  //   - Among the old day-1 snapshots outside the recent window, only the
  //     per-day representative (the newest of that day) should survive.

  // Use a midnight-aligned base to ensure all day-1 entries share the same date key.
  const now = Date.now();
  const day1Base = now - 5 * 24 * 60 * 60 * 1000; // approx 5 days ago
  // Align to start-of-day in UTC to guarantee same date key regardless of local TZ.
  const day1Start = day1Base - (day1Base % (24 * 60 * 60 * 1000));

  const totalDay1 = RETENTION_RECENT + 5;
  for (let i = 0; i < totalDay1; i++) {
    const snap: Snapshot = {
      id: `d1-${i}`,
      // Each snapshot is 1 minute apart, all within the same UTC calendar day.
      takenAt: day1Start + i * 60 * 1000,
      noteCount: i + 1,
      notesJson: '[]',
    };
    await fake.put(snap);
  }

  const day2Snap: Snapshot = {
    id: 'd2-only',
    takenAt: day1Start + 25 * 60 * 60 * 1000, // one full day later
    noteCount: 99,
    notesJson: '[]',
  };
  await fake.put(day2Snap);

  await backup.pruneOld();

  const remaining = await backup.listSnapshots();
  const ids = remaining.map((s) => s.id);

  // The day-2 snapshot must always survive (it's the most recent).
  assert.ok(ids.includes('d2-only'), 'd2-only must survive');

  // The oldest day-1 snapshots (indices 0..4) fall outside the RETENTION_RECENT
  // window and must be pruned, EXCEPT the newest one of day 1 (index totalDay1-1).
  const newestDay1Id = `d1-${totalDay1 - 1}`;
  assert.ok(
    ids.includes(newestDay1Id),
    'newest day-1 snapshot must survive as per-day representative',
  );

  // The very oldest ones should be pruned (they are outside both windows).
  assert.ok(!ids.includes('d1-0'), 'd1-0 (oldest) should be pruned');
  assert.ok(!ids.includes('d1-1'), 'd1-1 should be pruned');
  assert.ok(!ids.includes('d1-2'), 'd1-2 should be pruned');
  assert.ok(!ids.includes('d1-3'), 'd1-3 should be pruned');
  assert.ok(!ids.includes('d1-4'), 'd1-4 should be pruned');
});

test('pruneOld is a no-op on empty store', async () => {
  const { backup } = makeStore();
  // Should not throw
  await backup.pruneOld();
  const list = await backup.listSnapshots();
  assert.equal(list.length, 0);
});

// ---------------------------------------------------------------------------
// restoreSnapshot
// ---------------------------------------------------------------------------

test('restoreSnapshot takes a pre-restore snapshot before merging', async () => {
  const { backup } = makeStore();
  const original = [makeNote('a.md', '# Original')];
  const snapId = await backup.takeSnapshot(original);

  const current = [makeNote('b.md', '# Current')];
  await backup.restoreSnapshot(snapId, current, mergeImport);

  // There should now be 2 snapshots: the original + the pre-restore
  const list = await backup.listSnapshots();
  assert.equal(list.length, 2, 'should have 2 snapshots after restore');

  // The newest snapshot should be the pre-restore
  const newest = list[0];
  assert.equal(newest.label, 'pre-restore', 'newest snapshot should be labeled pre-restore');
  assert.equal(newest.noteCount, current.length);
});

test('restoreSnapshot merges notes: identical notes are de-duped', async () => {
  const { backup } = makeStore();
  const noteA = makeNote('a.md', '# A');
  const snapId = await backup.takeSnapshot([noteA]);

  // Current state already has the same note
  const current = [noteA];
  const merged = await backup.restoreSnapshot(snapId, current, mergeImport);

  assert.ok(merged);
  // Identical note: de-duped → still just 1 note
  assert.equal(merged.length, 1);
  assert.equal(merged[0].path, 'a.md');
});

test('restoreSnapshot merges notes: collision with different content becomes (imported) copy', async () => {
  const { backup } = makeStore();
  const snapshotNote = makeNote('a.md', '# Old Version');
  const snapId = await backup.takeSnapshot([snapshotNote]);

  // Current has same path but different content
  const current = [makeNote('a.md', '# New Version')];
  const merged = await backup.restoreSnapshot(snapId, current, mergeImport);

  assert.ok(merged);
  // Should have 2 notes: the current one + a "(imported)" copy of the snapshot note
  assert.equal(merged.length, 2, 'collision should produce 2 notes');
  assert.ok(
    merged.some((n) => n.path === 'a.md' && n.content === '# New Version'),
    'current note should be preserved',
  );
  assert.ok(
    merged.some((n) => n.path.includes('imported') && n.content === '# Old Version'),
    'snapshot note should become an (imported) copy',
  );
});

test('restoreSnapshot returns undefined for unknown snapshot id', async () => {
  const { backup } = makeStore();
  const current = [makeNote('a.md')];
  const result = await backup.restoreSnapshot('nonexistent-id', current, mergeImport);
  assert.equal(result, undefined);
});

test('restoreSnapshot does NOT take a pre-restore snapshot for unknown id', async () => {
  const { backup } = makeStore();
  const current = [makeNote('a.md')];
  await backup.restoreSnapshot('nonexistent-id', current, mergeImport);

  const list = await backup.listSnapshots();
  assert.equal(list.length, 0, 'no snapshot should be taken when restore target is missing');
});

test('restoreSnapshot throws on corrupt notesJson', async () => {
  const { backup, fake } = makeStore();
  const corrupt: Snapshot = {
    id: 'corrupt',
    takenAt: Date.now(),
    noteCount: 0,
    notesJson: 'this is not json {{{',
  };
  await fake.put(corrupt);

  await assert.rejects(() => backup.restoreSnapshot('corrupt', [], mergeImport), /invalid JSON/i);
});

// ---------------------------------------------------------------------------
// Two-device convergence simulation
// ---------------------------------------------------------------------------

test('two-device convergence: snapshots from both devices merge without loss', async () => {
  // Simulate: Device A and Device B each have different notes.
  // Device A "restores" a snapshot that has Device B's state.
  // Verify: no notes are lost.
  const { backup } = makeStore();

  const deviceANotes = [
    makeNote('device-a/note1.md', '# A Note 1'),
    makeNote('shared/common.md', '# Shared (A version)'),
  ];
  const deviceBNotes = [
    makeNote('device-b/note1.md', '# B Note 1'),
    makeNote('shared/common.md', '# Shared (B version)'),
  ];

  // Device B's state is saved as a snapshot
  const snapId = await backup.takeSnapshot(deviceBNotes, 'device-b-state');

  // Device A restores Device B's snapshot
  const merged = await backup.restoreSnapshot(snapId, deviceANotes, mergeImport);
  assert.ok(merged);

  // All unique notes should be present
  assert.ok(
    merged.some((n) => n.path === 'device-a/note1.md'),
    'Device A note should survive',
  );
  assert.ok(
    merged.some((n) => n.path === 'device-b/note1.md'),
    'Device B note should survive',
  );

  // The shared note with different content should produce 2 copies (no loss)
  const sharedNotes = merged.filter((n) => n.path.startsWith('shared/'));
  assert.equal(sharedNotes.length, 2, 'both versions of shared note should survive');
});
