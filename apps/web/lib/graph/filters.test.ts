import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dateInputToMs,
  EMPTY_FILTERS,
  filtersAreEmpty,
  filtersReducer,
  toCriteria,
} from './filters';

test('toggle actions add then remove a value', () => {
  let state = EMPTY_FILTERS;
  state = filtersReducer(state, { type: 'toggleTag', tag: 'project' });
  assert.deepEqual(state.tags, ['project']);
  state = filtersReducer(state, { type: 'toggleTag', tag: 'project' });
  assert.deepEqual(state.tags, []);
});

test('reset returns the empty state', () => {
  const dirty = filtersReducer(EMPTY_FILTERS, { type: 'toggleFolder', folder: 'notes' });
  assert.equal(filtersAreEmpty(dirty), false);
  const reset = filtersReducer(dirty, { type: 'reset' });
  assert.equal(filtersAreEmpty(reset), true);
});

test('reducer is immutable (does not mutate prior state)', () => {
  const before = filtersReducer(EMPTY_FILTERS, { type: 'toggleTag', tag: 'a' });
  const after = filtersReducer(before, { type: 'toggleTag', tag: 'b' });
  assert.deepEqual(before.tags, ['a']);
  assert.deepEqual(after.tags, ['a', 'b']);
});

test('dateInputToMs parses to UTC start-of-day, rejects empty/invalid', () => {
  assert.equal(dateInputToMs(''), undefined);
  assert.equal(dateInputToMs('not-a-date'), undefined);
  assert.equal(dateInputToMs('2026-01-01'), Date.parse('2026-01-01T00:00:00.000Z'));
});

test('toCriteria omits empty fields and makes updatedTo inclusive of the day', () => {
  assert.deepEqual(toCriteria(EMPTY_FILTERS), {});

  const c = toCriteria(
    {
      tags: ['project'],
      folders: ['notes'],
      linkTypes: ['wikilink'],
      updatedFrom: '2026-01-01',
      updatedTo: '2026-01-02',
    },
    500,
  );
  assert.deepEqual(c.tags, ['project']);
  assert.deepEqual(c.folders, ['notes']);
  assert.deepEqual(c.linkTypes, ['wikilink']);
  assert.equal(c.updatedFrom, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(c.updatedTo, Date.parse('2026-01-02T00:00:00.000Z') + (86_400_000 - 1));
  assert.equal(c.nodeCap, 500);
});
