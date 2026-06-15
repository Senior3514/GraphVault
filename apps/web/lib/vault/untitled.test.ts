import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nextUntitledName } from './untitled';

test('returns Untitled.md when vault is empty', () => {
  assert.equal(nextUntitledName([]), 'Untitled.md');
});

test('increments to Untitled 2.md when Untitled.md exists', () => {
  assert.equal(nextUntitledName(['Untitled.md']), 'Untitled 2.md');
});

test('skips occupied slots and returns the next free name', () => {
  const existing = ['Untitled.md', 'Untitled 2.md', 'Untitled 3.md'];
  assert.equal(nextUntitledName(existing), 'Untitled 4.md');
});

test('skips non-contiguous occupied slots', () => {
  // 1 and 3 are taken, 2 is free.
  const existing = ['Untitled.md', 'Untitled 3.md'];
  assert.equal(nextUntitledName(existing), 'Untitled 2.md');
});

test('scopes to a folder prefix', () => {
  assert.equal(nextUntitledName([], 'notes'), 'notes/Untitled.md');
  assert.equal(nextUntitledName(['notes/Untitled.md'], 'notes'), 'notes/Untitled 2.md');
});

test('normalises trailing slash in folder', () => {
  assert.equal(nextUntitledName([], 'notes/'), 'notes/Untitled.md');
});

test('normalises leading slash in folder', () => {
  assert.equal(nextUntitledName([], '/notes'), 'notes/Untitled.md');
});

test('unrelated notes in the vault do not affect the result', () => {
  assert.equal(nextUntitledName(['a.md', 'b.md', 'c.md']), 'Untitled.md');
});
