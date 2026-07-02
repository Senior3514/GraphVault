import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boxesOverlap, labelBox, selectVisibleLabels, type LabelCandidate } from './labelLayout';

/** Deterministic fake measurer: monospace-ish, 6 world-units per character. */
const measure = (text: string) => text.length * 6;

function candidate(
  overrides: Partial<LabelCandidate> & Pick<LabelCandidate, 'id'>,
): LabelCandidate {
  return {
    x: 0,
    y: 0,
    radius: 4,
    text: overrides.id,
    forced: false,
    priority: 0,
    ...overrides,
  };
}

test('boxesOverlap detects overlap and rejects merely-touching boxes', () => {
  const a = { x0: 0, y0: 0, x1: 10, y1: 10 };
  const overlapping = { x0: 5, y0: 5, x1: 15, y1: 15 };
  const touching = { x0: 10, y0: 0, x1: 20, y1: 10 };
  const disjoint = { x0: 20, y0: 20, x1: 30, y1: 30 };
  assert.equal(boxesOverlap(a, overlapping), true);
  assert.equal(boxesOverlap(a, touching), false);
  assert.equal(boxesOverlap(a, disjoint), false);
});

test('labelBox sits below the node (matches textBaseline top, textAlign center)', () => {
  const box = labelBox({ x: 100, y: 50, radius: 5 }, 30, 10, 1);
  // top = y + radius + 1 = 56, minus pad
  assert.equal(box.y0, 55);
  assert.equal(box.y1, 56 + 10 * 1.3 + 1);
  assert.equal(box.x0, 100 - 15 - 1);
  assert.equal(box.x1, 100 + 15 + 1);
});

test('selectVisibleLabels shows every label when nodes are far apart', () => {
  const candidates = [
    candidate({ id: 'a', x: 0, y: 0, text: 'Alpha' }),
    candidate({ id: 'b', x: 500, y: 0, text: 'Beta' }),
    candidate({ id: 'c', x: 0, y: 500, text: 'Gamma' }),
  ];
  const visible = selectVisibleLabels(candidates, 10, measure);
  assert.deepEqual([...visible].sort(), ['a', 'b', 'c']);
});

test('selectVisibleLabels drops a lower-priority label that would overlap a higher one', () => {
  // Two nodes 10 world-units apart - their labels (well over 10 units wide at
  // fontSize 10) necessarily collide.
  const candidates = [
    candidate({ id: 'hub', x: 0, y: 0, text: 'Hub', priority: 10 }),
    candidate({ id: 'leaf', x: 10, y: 0, text: 'Leaf', priority: 1 }),
  ];
  const visible = selectVisibleLabels(candidates, 10, measure);
  assert.equal(visible.has('hub'), true);
  assert.equal(visible.has('leaf'), false);
});

test('selectVisibleLabels places higher-priority candidates first regardless of input order', () => {
  const candidates = [
    candidate({ id: 'leaf', x: 10, y: 0, text: 'Leaf', priority: 1 }),
    candidate({ id: 'hub', x: 0, y: 0, text: 'Hub', priority: 10 }),
  ];
  const visible = selectVisibleLabels(candidates, 10, measure);
  assert.equal(visible.has('hub'), true);
  assert.equal(visible.has('leaf'), false);
});

test('selectVisibleLabels always shows forced candidates even if they overlap each other', () => {
  const candidates = [
    candidate({ id: 'a', x: 0, y: 0, text: 'Alpha', forced: true }),
    candidate({ id: 'b', x: 1, y: 0, text: 'Beta', forced: true }),
  ];
  const visible = selectVisibleLabels(candidates, 10, measure);
  assert.deepEqual([...visible].sort(), ['a', 'b']);
});

test('selectVisibleLabels lets a forced candidate block a non-forced one', () => {
  const candidates = [
    candidate({ id: 'forced', x: 0, y: 0, text: 'Forced', forced: true }),
    candidate({ id: 'blocked', x: 5, y: 0, text: 'Blocked', priority: 100 }),
  ];
  const visible = selectVisibleLabels(candidates, 10, measure);
  assert.equal(visible.has('forced'), true);
  assert.equal(visible.has('blocked'), false);
});

test('selectVisibleLabels: a later non-overlapping candidate can still be placed after a skip', () => {
  const candidates = [
    candidate({ id: 'hub', x: 0, y: 0, text: 'Hub', priority: 10 }),
    candidate({ id: 'nearby', x: 8, y: 0, text: 'Nearby', priority: 5 }), // collides with hub
    candidate({ id: 'far', x: 1000, y: 0, text: 'Far', priority: 1 }), // clear of everything
  ];
  const visible = selectVisibleLabels(candidates, 10, measure);
  assert.equal(visible.has('hub'), true);
  assert.equal(visible.has('nearby'), false);
  assert.equal(visible.has('far'), true);
});

test('selectVisibleLabels returns an empty set for no candidates', () => {
  assert.deepEqual(selectVisibleLabels([], 10, measure), new Set());
});
