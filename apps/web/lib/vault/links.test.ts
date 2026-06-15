import assert from 'node:assert/strict';
import { test } from 'node:test';

import { backlinksFor, buildLinkResolver, computeBacklinks } from './links';
import { indexNotes } from './vault';
import type { Note } from './types';

function notes(): Note[] {
  const t = 0;
  return [
    { path: 'a.md', content: '---\ntitle: Note A\n---\nlinks to [[Note B]]', ctime: t, mtime: t },
    { path: 'sub/b.md', content: '---\ntitle: Note B\n---\nlinks to [[Note A]] and [[Note C]]', ctime: t, mtime: t },
    { path: 'c.md', content: '# Note A duplicate title?\nlinks to [[sub/b]]', ctime: t, mtime: t },
  ];
}

test('buildLinkResolver resolves by title, basename, and path', () => {
  const idx = indexNotes(notes());
  const r = buildLinkResolver(idx);
  assert.equal(r.resolve('Note B'), 'sub/b.md');
  assert.equal(r.resolve('b'), 'sub/b.md');
  assert.equal(r.resolve('sub/b'), 'sub/b.md');
  assert.equal(r.resolve('sub/b.md'), 'sub/b.md');
  assert.equal(r.resolve('does not exist'), null);
});

test('computeBacklinks maps inbound links per note', () => {
  const idx = indexNotes(notes());
  const back = computeBacklinks(idx);
  const toB = back.get('sub/b.md') ?? [];
  const froms = toB.map((b) => b.from).sort();
  assert.deepEqual(froms, ['a.md', 'c.md']);
});

test('backlinksFor excludes self-links and unresolved targets', () => {
  const idx = indexNotes(notes());
  // Note C is referenced but does not exist -> no backlink entry created.
  assert.deepEqual(backlinksFor(idx, 'missing.md'), []);
  const toA = backlinksFor(idx, 'a.md').map((b) => b.from);
  assert.deepEqual(toA, ['sub/b.md']);
});
