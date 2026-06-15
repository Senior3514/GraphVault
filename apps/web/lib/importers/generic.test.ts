/**
 * Unit tests for the generic fallback importer.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { genericImporter } from './generic';

// ---------------------------------------------------------------------------
// .json (GraphVault export)
// ---------------------------------------------------------------------------

const VALID_GV_JSON = JSON.stringify({
  format: 'graphvault-vault',
  version: 1,
  exportedAt: 1700000000000,
  notes: [
    { path: 'note1.md', content: '# Note 1', ctime: 1700000000000, mtime: 1700001000000 },
    { path: 'folder/note2.md', content: '# Note 2', ctime: 1700002000000, mtime: 1700003000000 },
  ],
});

test('genericImporter parses GraphVault JSON export', async () => {
  const bytes = new TextEncoder().encode(VALID_GV_JSON);
  const entries = await genericImporter.convert(bytes, 'backup.json');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, 'note1.md');
  assert.equal(entries[1].path, 'folder/note2.md');
});

test('genericImporter preserves timestamps from JSON', async () => {
  const bytes = new TextEncoder().encode(VALID_GV_JSON);
  const entries = await genericImporter.convert(bytes, 'backup.json');
  assert.equal(entries[0].ctime, 1700000000000);
  assert.equal(entries[0].mtime, 1700001000000);
});

test('genericImporter rejects non-GraphVault JSON', async () => {
  const bytes = new TextEncoder().encode('{"foo": "bar"}');
  await assert.rejects(() => genericImporter.convert(bytes, 'data.json'), /graphvault/i);
});

test('genericImporter rejects invalid JSON', async () => {
  const bytes = new TextEncoder().encode('not-json');
  await assert.rejects(() => genericImporter.convert(bytes, 'data.json'));
});

// ---------------------------------------------------------------------------
// .md / .txt single file
// ---------------------------------------------------------------------------

test('genericImporter imports a single .md file', async () => {
  const content = '# My Note\n\nSome content';
  const bytes = new TextEncoder().encode(content);
  const entries = await genericImporter.convert(bytes, 'my-note.md');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'my-note.md');
  assert.equal(entries[0].content, content);
});

test('genericImporter imports a single .txt file', async () => {
  const content = 'Plain text content';
  const bytes = new TextEncoder().encode(content);
  const entries = await genericImporter.convert(bytes, 'readme.txt');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'readme.txt');
});

test('genericImporter rejects unsafe .md path', async () => {
  const bytes = new TextEncoder().encode('content');
  await assert.rejects(() => genericImporter.convert(bytes, '../escape.md'), /unsafe/i);
});

// ---------------------------------------------------------------------------
// Unsupported types
// ---------------------------------------------------------------------------

test('genericImporter rejects unsupported extension', async () => {
  await assert.rejects(
    () => genericImporter.convert(new Uint8Array(0), 'file.rtf'),
    /unsupported file type/i,
  );
});
