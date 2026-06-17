/**
 * Resource-handler tests against an in-memory snapshot (no network, no server).
 *
 * Covers the URI scheme round-trip, the list callback enumerating notes, the
 * read callback returning the right markdown + mimeType, and rejection of
 * unknown / traversal / non-note URIs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndex, type NoteInput } from '@graphvault/engine';
import type { FilePath } from '@graphvault/shared';
import type { VaultSnapshot } from './vault.js';
import {
  NOTE_MIME_TYPE,
  NOTE_URI_PREFIX,
  listNoteResources,
  noteUriForPath,
  pathFromNoteUri,
  readNoteResource,
} from './resources.js';

const NOTES: Array<{ path: string; content: string; mtime: number }> = [
  { path: 'index.md', content: '---\ntitle: Home\n---\n# Home\n\nSee [[graphs]].', mtime: 10 },
  {
    path: 'notes/graph theory.md',
    content: '# Graph Theory\n\nNotes about graphs. #math',
    mtime: 20,
  },
];

function makeSnapshot(): VaultSnapshot {
  const inputs: NoteInput[] = NOTES.map((n) => ({
    path: n.path as FilePath,
    content: n.content,
    updatedAt: n.mtime,
  }));
  const index = buildIndex(inputs);
  const contentByPath = new Map<string, string>(NOTES.map((n) => [n.path, n.content]));
  return {
    index,
    contentByPath,
    notes: NOTES.map((n) => ({ path: n.path as FilePath, content: n.content, mtime: n.mtime })),
    builtAt: 0,
  };
}

test('noteUriForPath / pathFromNoteUri round-trip, encoding special chars', () => {
  const uri = noteUriForPath('notes/graph theory.md');
  assert.equal(uri, `${NOTE_URI_PREFIX}notes/graph%20theory.md`);
  assert.equal(pathFromNoteUri(uri), 'notes/graph theory.md');
  // A plain path with no special chars round-trips unchanged.
  assert.equal(pathFromNoteUri(noteUriForPath('index.md')), 'index.md');
});

test('listNoteResources enumerates notes sorted by path with the markdown mime type', () => {
  const list = listNoteResources(makeSnapshot());
  assert.deepEqual(
    list.map((r) => r.name),
    ['index.md', 'notes/graph theory.md'],
  );
  assert.deepEqual(
    list.map((r) => r.uri),
    [`${NOTE_URI_PREFIX}index.md`, `${NOTE_URI_PREFIX}notes/graph%20theory.md`],
  );
  assert.ok(list.every((r) => r.mimeType === NOTE_MIME_TYPE));
  const home = list.find((r) => r.name === 'index.md');
  assert.equal(home?.title, 'Home');
});

test('readNoteResource returns the right markdown and mime type', () => {
  const snap = makeSnapshot();
  const uri = noteUriForPath('notes/graph theory.md');
  const contents = readNoteResource(snap, uri);
  assert.equal(contents.uri, uri);
  assert.equal(contents.mimeType, NOTE_MIME_TYPE);
  assert.match(contents.text, /# Graph Theory/);
});

test('readNoteResource throws a clear not-found error for an unknown note', () => {
  const snap = makeSnapshot();
  assert.throws(
    () => readNoteResource(snap, noteUriForPath('does/not/exist.md')),
    /Note not found/,
  );
});

test('pathFromNoteUri rejects non-note, traversal, and malformed URIs', () => {
  assert.throws(() => pathFromNoteUri('https://evil/note/x.md'), /Not a GraphVault note/);
  assert.throws(() => pathFromNoteUri(`${NOTE_URI_PREFIX}`), /missing note path/);
  assert.throws(() => pathFromNoteUri(`${NOTE_URI_PREFIX}a/../b.md`), /\.\.|segments/);
  assert.throws(() => pathFromNoteUri(`${NOTE_URI_PREFIX}/abs.md`), /segments/);
  // An encoded "../" segment must also be rejected after decoding.
  assert.throws(() => pathFromNoteUri(`${NOTE_URI_PREFIX}a/%2e%2e/b.md`), /segments/);
  // A reader that gets a traversal URI gets the same rejection.
  assert.throws(
    () => readNoteResource(makeSnapshot(), `${NOTE_URI_PREFIX}../escape.md`),
    /segments/,
  );
});
