import assert from 'node:assert/strict';
import { test } from 'node:test';

import { colorForKey, distinctSorted, GRAPH_NEUTRAL, notesToInputs } from './model';

test('notesToInputs maps ctime/mtime onto createdAt/updatedAt', () => {
  const inputs = notesToInputs([
    { path: 'a.md', content: '# A', ctime: 100, mtime: 200 },
    { path: 'notes/b.md', content: '# B', ctime: 5, mtime: 9 },
  ]);
  assert.deepEqual(inputs, [
    { path: 'a.md', content: '# A', createdAt: 100, updatedAt: 200 },
    { path: 'notes/b.md', content: '# B', createdAt: 5, updatedAt: 9 },
  ]);
});

test('colorForKey is deterministic and falls back to neutral', () => {
  assert.equal(colorForKey('project'), colorForKey('project'));
  assert.equal(colorForKey(undefined), GRAPH_NEUTRAL);
  assert.equal(colorForKey(''), GRAPH_NEUTRAL);
  assert.match(colorForKey('project'), /^#[0-9a-f]{6}$/i);
});

test('distinctSorted de-duplicates and sorts', () => {
  assert.deepEqual(distinctSorted(['b', 'a', 'b', 'c', 'a']), ['a', 'b', 'c']);
});
