/**
 * Unit tests for openFolder.ts pure helpers.
 *
 * The browser API (`showDirectoryPicker`) is shimmed on `globalThis` only for
 * the tests that exercise `openFolder()` itself. All pure helpers
 * (`isImportableFilename`, `walkDirectory`, `readFileEntry`,
 * `collectEntriesFromDirectory`) are tested with in-memory stubs so they
 * can run in Node without a browser.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectEntriesFromDirectory,
  isFolderPickerSupported,
  isImportableFilename,
  openFolder,
  readFileEntry,
  walkDirectory,
  type GVFileData,
  type GVFileEntryHandle,
  type GVFolderHandle,
} from './openFolder';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

/** Create a stub file handle with given metadata. */
function makeFileHandle(
  name: string,
  content: string,
  lastModified = 1_700_000_000_000,
): GVFileEntryHandle {
  const size = new TextEncoder().encode(content).length;
  const fileData: GVFileData = {
    name,
    size,
    lastModified,
    text: async () => content,
  };
  return {
    kind: 'file',
    name,
    getFile: async () => fileData,
  };
}

/** Create a stub file handle that throws on `getFile`. */
function makeUnreadableFileHandle(name: string): GVFileEntryHandle {
  return {
    kind: 'file',
    name,
    getFile: async () => {
      throw new Error('Permission denied');
    },
  };
}

/** Create an in-memory stub directory handle from a flat mapping of path->content. */
function makeDirHandle(files: Record<string, string>, name = '<root>'): GVFolderHandle {
  // Build a tree from the flat mapping.
  interface DirNode {
    dirs: Map<string, DirNode>;
    files: Map<string, GVFileEntryHandle>;
  }

  function makeNode(): DirNode {
    return { dirs: new Map(), files: new Map() };
  }

  const root: DirNode = makeNode();

  for (const [filePath, content] of Object.entries(files)) {
    const parts = filePath.split('/');
    const filename = parts[parts.length - 1];
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.dirs.has(seg)) node.dirs.set(seg, makeNode());
      node = node.dirs.get(seg)!;
    }
    node.files.set(filename, makeFileHandle(filename, content));
  }

  function buildHandle(node: DirNode, nodeName: string): GVFolderHandle {
    const entries: (GVFolderHandle | GVFileEntryHandle)[] = [];
    for (const [dirName, child] of node.dirs) {
      entries.push(buildHandle(child, dirName));
    }
    for (const fh of node.files.values()) {
      entries.push(fh);
    }
    return {
      kind: 'directory',
      name: nodeName,
      values: async function* () {
        yield* entries;
      },
    };
  }

  return buildHandle(root, name);
}

// ---------------------------------------------------------------------------
// isImportableFilename
// ---------------------------------------------------------------------------

test('isImportableFilename accepts .md', () => {
  assert.equal(isImportableFilename('note.md'), true);
});

test('isImportableFilename accepts .MD (case-insensitive)', () => {
  assert.equal(isImportableFilename('NOTE.MD'), true);
});

test('isImportableFilename accepts .markdown', () => {
  assert.equal(isImportableFilename('readme.markdown'), true);
});

test('isImportableFilename accepts .txt', () => {
  assert.equal(isImportableFilename('plain.txt'), true);
});

test('isImportableFilename rejects .png', () => {
  assert.equal(isImportableFilename('image.png'), false);
});

test('isImportableFilename rejects .json', () => {
  assert.equal(isImportableFilename('data.json'), false);
});

test('isImportableFilename rejects no extension', () => {
  assert.equal(isImportableFilename('Makefile'), false);
});

// ---------------------------------------------------------------------------
// walkDirectory
// ---------------------------------------------------------------------------

test('walkDirectory yields a flat .md file', async () => {
  const dir = makeDirHandle({ 'note.md': '# Hello' });
  const results: { relativePath: string }[] = [];
  for await (const r of walkDirectory(dir, '')) results.push(r);
  assert.equal(results.length, 1);
  assert.equal(results[0].relativePath, 'note.md');
});

test('walkDirectory recurses into subdirectories', async () => {
  const dir = makeDirHandle({
    'top.md': '# Top',
    'sub/child.md': '# Child',
    'sub/deep/nested.md': '# Nested',
  });
  const results: { relativePath: string }[] = [];
  for await (const r of walkDirectory(dir, '')) results.push(r);
  const paths = results.map((r) => r.relativePath).sort();
  assert.deepEqual(paths, ['sub/child.md', 'sub/deep/nested.md', 'top.md'].sort());
});

test('walkDirectory skips non-importable files', async () => {
  const dir = makeDirHandle({
    'note.md': '# Yes',
    'image.png': 'binary',
    'data.json': '{}',
  });
  const results: { relativePath: string }[] = [];
  for await (const r of walkDirectory(dir, '')) results.push(r);
  assert.equal(results.length, 1);
  assert.equal(results[0].relativePath, 'note.md');
});

test('walkDirectory preserves the prefix for nested entries', async () => {
  const dir = makeDirHandle({ 'a.md': 'content' });
  const results: { relativePath: string }[] = [];
  for await (const r of walkDirectory(dir, 'prefix')) results.push(r);
  assert.equal(results[0].relativePath, 'prefix/a.md');
});

test('walkDirectory yields .txt and .markdown files', async () => {
  const dir = makeDirHandle({
    'a.txt': 'plain text',
    'b.markdown': '# Markdown',
  });
  const results: { relativePath: string }[] = [];
  for await (const r of walkDirectory(dir, '')) results.push(r);
  assert.equal(results.length, 2);
});

// ---------------------------------------------------------------------------
// readFileEntry
// ---------------------------------------------------------------------------

test('readFileEntry returns an ImportEntry for a valid file', async () => {
  const handle = makeFileHandle('note.md', '# Hello', 1_700_000_000_000);
  const entry = await readFileEntry(handle, 'note.md');
  assert.ok(entry !== null);
  assert.equal(entry.path, 'note.md');
  assert.equal(entry.content, '# Hello');
  assert.equal(entry.mtime, 1_700_000_000_000);
});

test('readFileEntry rejects an unsafe traversal path', async () => {
  const handle = makeFileHandle('escape.md', 'bad');
  const entry = await readFileEntry(handle, '../../etc/passwd.md');
  assert.equal(entry, null);
});

test('readFileEntry rejects a non-text extension', async () => {
  const handle = makeFileHandle('data.json', '{}');
  const entry = await readFileEntry(handle, 'data.json');
  assert.equal(entry, null);
});

test('readFileEntry skips a file whose reported size exceeds the cap', async () => {
  // Build a handle where size > MAX_IMPORT_FILE_BYTES (4 MiB = 4194304 bytes).
  const oversizedData: GVFileData = {
    name: 'big.md',
    size: 5 * 1024 * 1024, // 5 MiB - over cap
    lastModified: 1000,
    text: async () => 'x'.repeat(100), // content is small; size field triggers the guard
  };
  const handle: GVFileEntryHandle = {
    kind: 'file',
    name: 'big.md',
    getFile: async () => oversizedData,
  };
  const entry = await readFileEntry(handle, 'big.md');
  assert.equal(entry, null);
});

test('readFileEntry normalizes paths (removes leading ./ via safeImportPath)', async () => {
  const handle = makeFileHandle('note.md', 'content');
  const entry = await readFileEntry(handle, './folder/note.md');
  assert.ok(entry !== null);
  assert.equal(entry.path, 'folder/note.md');
});

// ---------------------------------------------------------------------------
// collectEntriesFromDirectory
// ---------------------------------------------------------------------------

test('collectEntriesFromDirectory returns all valid files', async () => {
  const dir = makeDirHandle({
    'a.md': '# A',
    'b/c.md': '# C',
    'b/d.txt': 'plain',
  });
  const entries = await collectEntriesFromDirectory(dir);
  assert.equal(entries.length, 3);
  const paths = entries.map((e) => e.path).sort();
  assert.deepEqual(paths, ['a.md', 'b/c.md', 'b/d.txt'].sort());
});

test('collectEntriesFromDirectory skips unreadable files without aborting', async () => {
  const badHandle = makeUnreadableFileHandle('broken.md');
  const dir: GVFolderHandle = {
    kind: 'directory',
    name: '<root>',
    values: async function* () {
      yield badHandle;
      yield makeFileHandle('good.md', '# Good');
    },
  };
  const entries = await collectEntriesFromDirectory(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'good.md');
});

test('collectEntriesFromDirectory skips non-importable files', async () => {
  const dir = makeDirHandle({
    'image.png': 'binary',
    'note.md': '# Real',
  });
  const entries = await collectEntriesFromDirectory(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'note.md');
});

// ---------------------------------------------------------------------------
// isFolderPickerSupported
// ---------------------------------------------------------------------------

test('isFolderPickerSupported returns false when API is absent', () => {
  const original = (globalThis as Record<string, unknown>).showDirectoryPicker;
  delete (globalThis as Record<string, unknown>).showDirectoryPicker;
  try {
    assert.equal(isFolderPickerSupported(), false);
  } finally {
    if (original !== undefined) {
      (globalThis as Record<string, unknown>).showDirectoryPicker = original;
    }
  }
});

test('isFolderPickerSupported returns true when API is shimmed', () => {
  const original = (globalThis as Record<string, unknown>).showDirectoryPicker;
  (globalThis as Record<string, unknown>).showDirectoryPicker = async () => ({});
  try {
    assert.equal(isFolderPickerSupported(), true);
  } finally {
    if (original === undefined) {
      delete (globalThis as Record<string, unknown>).showDirectoryPicker;
    } else {
      (globalThis as Record<string, unknown>).showDirectoryPicker = original;
    }
  }
});

// ---------------------------------------------------------------------------
// openFolder - integration with globalThis shim
// ---------------------------------------------------------------------------

test('openFolder throws when showDirectoryPicker is unavailable', async () => {
  const original = (globalThis as Record<string, unknown>).showDirectoryPicker;
  delete (globalThis as Record<string, unknown>).showDirectoryPicker;
  try {
    await assert.rejects(() => openFolder(), /File System Access API/);
  } finally {
    if (original !== undefined) {
      (globalThis as Record<string, unknown>).showDirectoryPicker = original;
    }
  }
});

test('openFolder returns entries from the picked directory', async () => {
  const fakeDir = makeDirHandle({
    'note.md': '# Hello',
    'sub/other.md': '# Other',
  });
  const original = (globalThis as Record<string, unknown>).showDirectoryPicker;
  (globalThis as Record<string, unknown>).showDirectoryPicker = async () => fakeDir;
  try {
    const entries = await openFolder();
    assert.equal(entries.length, 2);
    const paths = entries.map((e) => e.path).sort();
    assert.deepEqual(paths, ['note.md', 'sub/other.md'].sort());
  } finally {
    if (original === undefined) {
      delete (globalThis as Record<string, unknown>).showDirectoryPicker;
    } else {
      (globalThis as Record<string, unknown>).showDirectoryPicker = original;
    }
  }
});
