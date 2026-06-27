/**
 * Tests for the vault storage migration helper.
 *
 * Run: node --test --import tsx apps/web/lib/vault/encryption/migrationHelper.test.ts
 *
 * Test matrix:
 *  - Normal migration: all notes copied to destination, verified intact.
 *  - Empty source: destination initialised with empty vault.
 *  - Source unaffected after successful migration.
 *  - Destination cleared on verification failure (corrupt write).
 *  - MigrationResult has correct counts and labels.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { migrateAdapter, type MigrationResult } from './migrationHelper';
import type { StorageAdapter } from '../storage/index';
import type { Note } from '../types';

// ---------------------------------------------------------------------------
// In-memory StorageAdapter for tests
// ---------------------------------------------------------------------------

function makeNote(path: string, content = '# Test', offset = 0): Note {
  const t = 1_000_000 + offset;
  return { path, content, mtime: t, ctime: t };
}

/**
 * Build a fake StorageAdapter backed by an in-memory array. Supports an
 * optional `corruptSave` flag to simulate a write that scrambles content
 * (for the verification-failure test).
 */
function makeAdapter(
  id: string,
  initial: Note[] = [],
  opts: { corruptSave?: boolean } = {},
): StorageAdapter & { readonly _notes: Note[]; readonly _clearCalled: boolean } {
  let _notes: Note[] = [...initial];
  let _clearCalled = false;

  return {
    id,
    label: `Adapter(${id})`,
    isAvailable: () => true,
    get _notes() {
      return _notes;
    },
    get _clearCalled() {
      return _clearCalled;
    },
    async load() {
      return [..._notes];
    },
    async save(notes: Note[]) {
      if (opts.corruptSave) {
        // Simulate corruption: save notes with scrambled content.
        _notes = notes.map((n) => ({ ...n, content: n.content + '<!-- CORRUPT -->' }));
      } else {
        _notes = [...notes];
      }
    },
    async clear() {
      _notes = [];
      _clearCalled = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Normal migration
// ---------------------------------------------------------------------------

test('migrateAdapter: all notes are present in destination after migration', async () => {
  const source = makeAdapter('src', [
    makeNote('a.md', '# Alpha', 0),
    makeNote('b.md', '# Beta', 1),
    makeNote('notes/c.md', '# Nested', 2),
  ]);
  const dest = makeAdapter('dst');

  const result: MigrationResult = await migrateAdapter(source, dest);

  assert.equal(result.noteCount, 3);
  assert.equal(result.notes.length, 3);

  // Destination must have all three notes with exact values.
  for (const note of source._notes) {
    const found = result.notes.find((n) => n.path === note.path);
    assert.ok(found, `${note.path} should be in destination`);
    assert.equal(found.content, note.content);
    assert.equal(found.mtime, note.mtime);
    assert.equal(found.ctime, note.ctime);
  }
});

test('migrateAdapter: result carries correct adapter labels', async () => {
  const source = makeAdapter('localStorage', [makeNote('a.md')]);
  const dest = makeAdapter('fileSystem');
  const result = await migrateAdapter(source, dest);
  assert.ok(result.from.includes('localStorage'));
  assert.ok(result.to.includes('fileSystem'));
});

// ---------------------------------------------------------------------------
// Empty source
// ---------------------------------------------------------------------------

test('migrateAdapter: empty source writes empty vault to destination', async () => {
  const source = makeAdapter('src', []);
  const dest = makeAdapter('dst');
  const result = await migrateAdapter(source, dest);
  assert.equal(result.noteCount, 0);
  assert.deepEqual(result.notes, []);
});

// ---------------------------------------------------------------------------
// Source unaffected
// ---------------------------------------------------------------------------

test('migrateAdapter: source is NOT cleared after successful migration', async () => {
  const source = makeAdapter('src', [makeNote('a.md'), makeNote('b.md')]);
  const dest = makeAdapter('dst');
  await migrateAdapter(source, dest);

  // Source must still have the notes.
  assert.equal(source._notes.length, 2, 'source should still have its notes');
  assert.equal(source._clearCalled, false);
});

// ---------------------------------------------------------------------------
// Verification failure - destination cleared, source unaffected
// ---------------------------------------------------------------------------

test('migrateAdapter: throws on verification failure and clears destination', async () => {
  const source = makeAdapter('src', [makeNote('a.md', '# Real content')]);
  const dest = makeAdapter('dst', [], { corruptSave: true });

  await assert.rejects(
    () => migrateAdapter(source, dest),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'should throw an Error');
      assert.ok(
        err.message.toLowerCase().includes('migration verification failed'),
        `unexpected message: ${err.message}`,
      );
      return true;
    },
  );

  // Destination must be cleared after verification failure.
  assert.equal(dest._notes.length, 0, 'destination should be cleared after failure');

  // Source must be untouched.
  assert.equal(source._notes.length, 1);
  assert.equal(source._notes[0].path, 'a.md');
});

// ---------------------------------------------------------------------------
// Large vault
// ---------------------------------------------------------------------------

test('migrateAdapter: handles 500 notes correctly', async () => {
  const notes = Array.from({ length: 500 }, (_, i) =>
    makeNote(`note-${i}.md`, `# Note ${i}\nContent line ${i}.`, i),
  );
  const source = makeAdapter('src', notes);
  const dest = makeAdapter('dst');

  const result = await migrateAdapter(source, dest);
  assert.equal(result.noteCount, 500);
  assert.equal(result.notes.length, 500);
});
