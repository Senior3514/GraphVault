/**
 * Unit tests for exportToDirectory.ts.
 *
 * `showDirectoryPicker` is a browser API that cannot run in Node. We stub the
 * `FileSystemDirectoryHandle` / `FileSystemFileHandle` / `FileSystemWritableFileStream`
 * interface in-process so the pure logic - path segmentation, subfolder
 * creation, write calls - can be verified without a browser.
 *
 * `isDirectoryExportSupported` is also covered: it must read from `window`
 * without throwing in environments where `window` is absent.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  exportToDirectory,
  isDirectoryExportSupported,
  writeNoteToDirectory,
} from './exportToDirectory';
import type { Note } from './types';

// ---------------------------------------------------------------------------
// Minimal in-memory stubs for the File System Access API
// ---------------------------------------------------------------------------

/** A writable stream stub that collects written content. */
class StubWritable {
  chunks: string[] = [];
  closed = false;

  async write(data: string) {
    this.chunks.push(data);
  }
  async close() {
    this.closed = true;
  }
}

/** A file handle stub that exposes its writable stream for assertions. */
class StubFileHandle {
  name: string;
  _writable = new StubWritable();

  constructor(name: string) {
    this.name = name;
  }

  async createWritable() {
    return this._writable;
  }
}

/** A directory handle stub that records `getDirectoryHandle` / `getFileHandle` calls. */
class StubDirHandle {
  name: string;
  /** Sub-directories created or navigated. */
  dirs = new Map<string, StubDirHandle>();
  /** Files created or accessed. */
  files = new Map<string, StubFileHandle>();

  constructor(name = '<root>') {
    this.name = name;
  }

  async getDirectoryHandle(segment: string, opts?: { create?: boolean }) {
    if (!this.dirs.has(segment)) {
      if (!opts?.create) throw new Error(`Dir not found: ${segment}`);
      this.dirs.set(segment, new StubDirHandle(segment));
    }
    return this.dirs.get(segment)!;
  }

  async getFileHandle(filename: string, opts?: { create?: boolean }) {
    if (!this.files.has(filename)) {
      if (!opts?.create) throw new Error(`File not found: ${filename}`);
      this.files.set(filename, new StubFileHandle(filename));
    }
    return this.files.get(filename)!;
  }
}

function makeNote(path: string, content: string): Note {
  return { path, content, ctime: 1000, mtime: 2000 };
}

// ---------------------------------------------------------------------------
// isDirectoryExportSupported
// ---------------------------------------------------------------------------

test('isDirectoryExportSupported returns false when window is undefined', () => {
  // In a Node test environment there is no `window`.
  // The function guards with `typeof window !== 'undefined'`.
  const result = isDirectoryExportSupported();
  // In Node.js `window` is undefined, so expect false.
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// writeNoteToDirectory - path segmentation
// ---------------------------------------------------------------------------

test('writeNoteToDirectory writes a flat note to the root directory', async () => {
  const root = new StubDirHandle();
  const note = makeNote('Welcome.md', '# Hello\n');

  await writeNoteToDirectory(root as unknown as FileSystemDirectoryHandle, note);

  assert.ok(root.files.has('Welcome.md'), 'root should have Welcome.md');
  const file = root.files.get('Welcome.md')!;
  assert.equal(file._writable.chunks.join(''), '# Hello\n');
  assert.ok(file._writable.closed, 'writable should be closed');
});

test('writeNoteToDirectory creates subfolders for nested paths', async () => {
  const root = new StubDirHandle();
  const note = makeNote('notes/deep/nested.md', 'nested body');

  await writeNoteToDirectory(root as unknown as FileSystemDirectoryHandle, note);

  assert.ok(root.dirs.has('notes'), 'root/notes dir should exist');
  const notesDir = root.dirs.get('notes')!;
  assert.ok(notesDir.dirs.has('deep'), 'notes/deep dir should exist');
  const deepDir = notesDir.dirs.get('deep')!;
  assert.ok(deepDir.files.has('nested.md'), 'nested.md should be in notes/deep');
  const file = deepDir.files.get('nested.md')!;
  assert.equal(file._writable.chunks.join(''), 'nested body');
});

test('writeNoteToDirectory reuses an existing subfolder', async () => {
  const root = new StubDirHandle();
  // Pre-create the subdir so the handle call goes through getDirectoryHandle
  // without create=true being the first thing that creates it.
  root.dirs.set('existing', new StubDirHandle('existing'));

  const note = makeNote('existing/note.md', 'content');
  await writeNoteToDirectory(root as unknown as FileSystemDirectoryHandle, note);

  // Should not have duplicated the directory.
  assert.equal(root.dirs.size, 1);
  assert.ok(root.dirs.get('existing')!.files.has('note.md'));
});

// ---------------------------------------------------------------------------
// exportToDirectory - summary and error handling
// ---------------------------------------------------------------------------

test('exportToDirectory returns correct written count for multiple notes', async () => {
  const root = new StubDirHandle();
  const notes: Note[] = [
    makeNote('a.md', 'aaa'),
    makeNote('sub/b.md', 'bbb'),
    makeNote('sub/deep/c.md', 'ccc'),
  ];

  // Stub showDirectoryPicker on globalThis so exportToDirectory can find it.
  const originalPicker = (globalThis as Record<string, unknown>).showDirectoryPicker;
  (globalThis as Record<string, unknown>).showDirectoryPicker = async () => root;

  try {
    const summary = await exportToDirectory(notes);
    assert.equal(summary.written, 3);
    assert.equal(summary.errors.length, 0);
  } finally {
    if (originalPicker === undefined) {
      delete (globalThis as Record<string, unknown>).showDirectoryPicker;
    } else {
      (globalThis as Record<string, unknown>).showDirectoryPicker = originalPicker;
    }
  }
});

test('exportToDirectory collects per-note errors without aborting the batch', async () => {
  // Root that throws on getFileHandle for a specific name.
  class FailingRoot extends StubDirHandle {
    override async getFileHandle(filename: string, opts?: { create?: boolean }) {
      if (filename === 'bad.md') throw new Error('Simulated write failure');
      return super.getFileHandle(filename, opts);
    }
  }

  const root = new FailingRoot();
  const notes: Note[] = [makeNote('ok.md', 'fine'), makeNote('bad.md', 'will fail')];

  const originalPicker = (globalThis as Record<string, unknown>).showDirectoryPicker;
  (globalThis as Record<string, unknown>).showDirectoryPicker = async () => root;

  try {
    const summary = await exportToDirectory(notes);
    assert.equal(summary.written, 1, 'one note should succeed');
    assert.equal(summary.errors.length, 1, 'one error should be collected');
    assert.equal(summary.errors[0].path, 'bad.md');
    assert.match(summary.errors[0].message, /Simulated write failure/);
  } finally {
    if (originalPicker === undefined) {
      delete (globalThis as Record<string, unknown>).showDirectoryPicker;
    } else {
      (globalThis as Record<string, unknown>).showDirectoryPicker = originalPicker;
    }
  }
});

test('exportToDirectory throws when API is unavailable', async () => {
  // Ensure showDirectoryPicker is not defined.
  const originalPicker = (globalThis as Record<string, unknown>).showDirectoryPicker;
  delete (globalThis as Record<string, unknown>).showDirectoryPicker;

  try {
    await assert.rejects(
      () => exportToDirectory([makeNote('x.md', 'x')]),
      /File System Access API is not available/,
    );
  } finally {
    if (originalPicker !== undefined) {
      (globalThis as Record<string, unknown>).showDirectoryPicker = originalPicker;
    }
  }
});
