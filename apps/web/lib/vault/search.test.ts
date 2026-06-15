import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NoteSearchIndex, searchNotes } from './search';
import { indexNotes } from './vault';
import type { Note } from './types';

function corpus(): Note[] {
  return [
    {
      path: 'graph.md',
      content: '---\ntitle: Graph view ideas\ntags: [graph]\n---\nforce directed layout',
      ctime: 0,
      mtime: 0,
    },
    {
      path: 'sync.md',
      content: '---\ntitle: Sync overview\ntags: [sync]\n---\nconflicts preserved as copies',
      ctime: 0,
      mtime: 0,
    },
    {
      path: 'welcome.md',
      content: '---\ntitle: Welcome\n---\nintro to the graph and sync',
      ctime: 0,
      mtime: 0,
    },
  ];
}

test('searchNotes matches titles and bodies', () => {
  const idx = indexNotes(corpus());
  const results = searchNotes(idx, 'graph');
  const paths = results.map((r) => r.path);
  assert.ok(paths.includes('graph.md'));
  assert.ok(paths.includes('welcome.md'));
});

test('title matches rank above body-only matches', () => {
  const idx = indexNotes(corpus());
  const results = searchNotes(idx, 'graph');
  assert.equal(results[0].path, 'graph.md');
});

test('empty query returns nothing', () => {
  const idx = indexNotes(corpus());
  assert.deepEqual(searchNotes(idx, '   '), []);
});

test('prefix search returns partial matches', () => {
  const idx = indexNotes(corpus());
  const results = searchNotes(idx, 'conf');
  assert.ok(results.some((r) => r.path === 'sync.md'));
});

test('NoteSearchIndex.replaceAll refreshes the corpus', () => {
  const index = new NoteSearchIndex(indexNotes(corpus()));
  index.replaceAll(indexNotes([{ path: 'only.md', content: '# Solo note', ctime: 0, mtime: 0 }]));
  assert.deepEqual(
    index.search('graph').map((r) => r.path),
    [],
  );
  assert.ok(index.search('solo').some((r) => r.path === 'only.md'));
});
