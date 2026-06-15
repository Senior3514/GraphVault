import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildVaultZip,
  exportNotesToJson,
  parseJsonExport,
  readVaultZip,
  safeImportPath,
} from './portability';
import { mergeImport } from './vault';
import type { Note } from './types';

function note(path: string, content: string, t = 1000): Note {
  return { path, content, ctime: t, mtime: t };
}

const sample: Note[] = [
  note('Welcome.md', '# Welcome\n\nHello [[notes/ideas]].'),
  note('notes/ideas.md', '# Ideas\n\n#brainstorm a thought.'),
  note('notes/deep/nested.md', 'nested body'),
];

test('JSON export round-trips losslessly', () => {
  const json = exportNotesToJson(sample);
  const entries = parseJsonExport(json);
  assert.equal(entries.length, sample.length);
  for (const n of sample) {
    const found = entries.find((e) => e.path === n.path);
    assert.ok(found, `missing ${n.path}`);
    assert.equal(found!.content, n.content);
  }
});

test('parseJsonExport rejects a non-GraphVault file', () => {
  assert.throws(() => parseJsonExport('{"format":"something-else"}'));
  assert.throws(() => parseJsonExport('not json at all'));
});

test('ZIP (store) round-trips content and paths exactly', async () => {
  const zip = buildVaultZip(sample);
  const entries = await readVaultZip(zip);
  assert.equal(entries.length, sample.length);
  for (const n of sample) {
    const found = entries.find((e) => e.path === n.path);
    assert.ok(found, `missing ${n.path}`);
    assert.equal(found!.content, n.content);
  }
});

test('safeImportPath blocks zip-slip and absolute/traversal paths', () => {
  assert.equal(safeImportPath('../../etc/passwd.md'), null);
  assert.equal(safeImportPath('/etc/passwd.md'), null);
  assert.equal(safeImportPath('C:\\secrets\\x.md'), null);
  assert.equal(safeImportPath('notes/../../escape.md'), null);
  assert.equal(safeImportPath('folder/'), null); // directory entry
  assert.equal(safeImportPath('image.png'), null); // non-text
  assert.equal(safeImportPath('notes/ok.md'), 'notes/ok.md');
  assert.equal(safeImportPath('./a/b.md'), 'a/b.md');
});

test('mergeImport adds new notes', () => {
  const { notes, summary } = mergeImport(sample, [{ path: 'fresh.md', content: 'new' }]);
  assert.equal(summary.added, 1);
  assert.equal(summary.renamed.length, 0);
  assert.ok(notes.some((n) => n.path === 'fresh.md'));
});

test('mergeImport never overwrites — keeps a conflict copy', () => {
  const { notes, summary } = mergeImport(sample, [
    { path: 'Welcome.md', content: 'DIFFERENT content' },
  ]);
  assert.equal(summary.added, 0);
  assert.equal(summary.renamed.length, 1);
  assert.equal(summary.renamed[0].from, 'Welcome.md');
  assert.equal(summary.renamed[0].to, 'Welcome (imported).md');
  // Original survives untouched.
  const original = notes.find((n) => n.path === 'Welcome.md');
  assert.equal(original!.content, '# Welcome\n\nHello [[notes/ideas]].');
  // Imported copy is kept alongside.
  assert.ok(notes.some((n) => n.path === 'Welcome (imported).md'));
});

test('mergeImport skips byte-identical notes', () => {
  const { summary } = mergeImport(sample, [
    { path: 'Welcome.md', content: '# Welcome\n\nHello [[notes/ideas]].' },
  ]);
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.added, 0);
});

test('export then import is an idempotent round-trip into the same vault', async () => {
  const zip = buildVaultZip(sample);
  const entries = await readVaultZip(zip);
  const { summary } = mergeImport(sample, entries);
  // Re-importing the same content changes nothing.
  assert.equal(summary.added, 0);
  assert.equal(summary.renamed.length, 0);
  assert.equal(summary.unchanged, sample.length);
});
