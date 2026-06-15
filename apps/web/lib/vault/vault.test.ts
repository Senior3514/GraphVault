import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildTree,
  createNote,
  deleteNote,
  ensureMdExtension,
  normalizePath,
  renameNote,
  updateNoteContent,
  VaultError,
} from './vault';
import { indexNotes } from './vault';
import type { Note } from './types';

const base: Note[] = [{ path: 'a.md', content: 'x', ctime: 0, mtime: 0 }];

test('normalizePath cleans slashes and dot segments', () => {
  assert.equal(normalizePath('/notes//./a.md'), 'notes/a.md');
  assert.equal(normalizePath('a\\b.md'), 'a/b.md');
});

test('ensureMdExtension appends .md once', () => {
  assert.equal(ensureMdExtension('note'), 'note.md');
  assert.equal(ensureMdExtension('note.md'), 'note.md');
});

test('createNote adds a note and rejects duplicates', () => {
  const next = createNote(base, 'b');
  assert.equal(next.length, 2);
  assert.ok(next.some((n) => n.path === 'b.md'));
  assert.throws(() => createNote(next, 'a.md'), VaultError);
});

test('updateNoteContent updates and bumps mtime, throws if missing', () => {
  const next = updateNoteContent(base, 'a.md', 'new');
  assert.equal(next[0].content, 'new');
  assert.throws(() => updateNoteContent(base, 'missing.md', 'x'), VaultError);
});

test('renameNote moves and rejects collisions', () => {
  const two = createNote(base, 'b');
  const renamed = renameNote(two, 'a.md', 'sub/a');
  assert.ok(renamed.some((n) => n.path === 'sub/a.md'));
  assert.throws(() => renameNote(two, 'a.md', 'b.md'), VaultError);
});

test('deleteNote removes by path and is a no-op when absent', () => {
  assert.equal(deleteNote(base, 'a.md').length, 0);
  assert.equal(deleteNote(base, 'nope.md').length, 1);
});

test('buildTree nests folders before files', () => {
  const idx = indexNotes([
    { path: 'z.md', content: '# Z', ctime: 0, mtime: 0 },
    { path: 'sub/a.md', content: '# A', ctime: 0, mtime: 0 },
  ]);
  const tree = buildTree(idx);
  assert.equal(tree[0].name, 'sub');
  assert.ok(tree[0].children);
  assert.equal(tree[1].name, 'z.md');
});
