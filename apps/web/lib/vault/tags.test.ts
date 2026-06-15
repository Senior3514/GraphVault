import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregateTags, notesWithTag } from './tags';
import { indexNotes } from './vault';
import type { Note } from './types';

function note(path: string, content: string): Note {
  return { path, content, ctime: 0, mtime: 0 };
}

const NOTES = indexNotes([
  note('a.md', '# A\n#idea #project'),
  note('b.md', '# B\n#idea'),
  note('c.md', '---\ntags: [project, archive]\n---\n# C'),
]);

test('aggregateTags counts tags and sorts by frequency then name', () => {
  const tags = aggregateTags(NOTES);
  assert.deepEqual(tags, [
    { tag: 'idea', count: 2 },
    { tag: 'project', count: 2 },
    { tag: 'archive', count: 1 },
  ]);
});

test('aggregateTags returns an empty list when no notes carry tags', () => {
  assert.deepEqual(aggregateTags(indexNotes([note('x.md', '# X\nno tags here')])), []);
});

test('notesWithTag matches case-insensitively and ignores a leading #', () => {
  assert.deepEqual(notesWithTag(NOTES, 'idea'), ['a.md', 'b.md']);
  assert.deepEqual(notesWithTag(NOTES, '#Project'), ['a.md', 'c.md']);
  assert.deepEqual(notesWithTag(NOTES, 'archive'), ['c.md']);
});

test('notesWithTag returns nothing for an unknown or empty tag', () => {
  assert.deepEqual(notesWithTag(NOTES, 'missing'), []);
  assert.deepEqual(notesWithTag(NOTES, '   '), []);
});
