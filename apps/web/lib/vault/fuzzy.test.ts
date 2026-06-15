import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fuzzyMatch, fuzzyMatches } from './fuzzy';

test('empty query matches everything with score 0', () => {
  const m = fuzzyMatch('Go to Graph', '');
  assert.deepEqual(m, { score: 0, indices: [] });
});

test('subsequence matches are found case-insensitively', () => {
  const m = fuzzyMatch('Go to Graph', 'gg');
  assert.ok(m);
  assert.deepEqual(m.indices, [0, 6]);
});

test('non-subsequence returns null', () => {
  assert.equal(fuzzyMatch('Go to Graph', 'xyz'), null);
  assert.equal(fuzzyMatches('Settings', 'zzz'), false);
});

test('contiguous and boundary matches outscore scattered ones', () => {
  const contiguous = fuzzyMatch('Settings', 'sett');
  const scattered = fuzzyMatch('Some extra tags', 'sett');
  assert.ok(contiguous && scattered);
  assert.ok(contiguous.score > scattered.score);
});

test('a prefix match scores higher than a mid-word match', () => {
  const prefix = fuzzyMatch('Graph view', 'gr');
  const mid = fuzzyMatch('Paragraph', 'gr');
  assert.ok(prefix && mid);
  assert.ok(prefix.score > mid.score);
});
