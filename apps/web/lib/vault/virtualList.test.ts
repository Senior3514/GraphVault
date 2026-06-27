import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeVirtualWindow, flattenTree } from './virtualList';

// ---------------------------------------------------------------------------
// computeVirtualWindow
// ---------------------------------------------------------------------------

test('computeVirtualWindow: empty list returns zeros', () => {
  const w = computeVirtualWindow(0, 28, 0, 600);
  assert.deepEqual(w, { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 });
});

test('computeVirtualWindow: renders all when list fits in viewport', () => {
  // 10 items × 28 px = 280 px, viewport 600 px - all visible
  const w = computeVirtualWindow(10, 28, 0, 600, 0 /* no overscan for determinism */);
  assert.equal(w.startIndex, 0);
  assert.equal(w.endIndex, 10);
  assert.equal(w.paddingTop, 0);
  assert.equal(w.paddingBottom, 0);
});

test('computeVirtualWindow: windows at top with overscan', () => {
  // 1000 items, 28 px each, scroll at top, viewport 300 px, overscan 2
  const w = computeVirtualWindow(1000, 28, 0, 300, 2);
  assert.equal(w.startIndex, 0); // clamped to 0
  // Visible: 0..ceil(300/28)=11, +2 overscan = 13; clamped to min(1000,13)
  assert.equal(w.endIndex, Math.min(1000, Math.ceil(300 / 28) + 2));
  assert.equal(w.paddingTop, 0);
  assert.ok(w.paddingBottom > 0);
});

test('computeVirtualWindow: windows in the middle', () => {
  // 1000 items, 28 px each, scrolled to item 50, viewport 300 px, overscan 0
  const scrollTop = 50 * 28; // 1400 px
  const w = computeVirtualWindow(1000, 28, scrollTop, 300, 0);
  assert.equal(w.startIndex, 50);
  assert.equal(w.endIndex, 50 + Math.ceil(300 / 28));
  assert.equal(w.paddingTop, 50 * 28);
  assert.equal(w.paddingBottom, (1000 - w.endIndex) * 28);
});

test('computeVirtualWindow: paddingTop + rendered height + paddingBottom = total height', () => {
  const total = 500;
  const h = 28;
  const w = computeVirtualWindow(total, h, 200, 300, 3);
  const renderedHeight = (w.endIndex - w.startIndex) * h;
  assert.equal(w.paddingTop + renderedHeight + w.paddingBottom, total * h);
});

test('computeVirtualWindow: clamps endIndex to totalItems', () => {
  const w = computeVirtualWindow(5, 28, 0, 600, 10);
  assert.equal(w.endIndex, 5);
});

test('computeVirtualWindow: returns zeros for zero viewport height', () => {
  const w = computeVirtualWindow(100, 28, 0, 0);
  assert.deepEqual(w, { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 });
});

// ---------------------------------------------------------------------------
// flattenTree
// ---------------------------------------------------------------------------

interface Node {
  id: string;
  children: Node[];
}

function open(ids: string[]) {
  return (node: Node) => ids.includes(node.id);
}

function children(node: Node): Node[] {
  return node.children;
}

test('flattenTree: single root leaf', () => {
  const roots: Node[] = [{ id: 'a', children: [] }];
  const rows = flattenTree(roots, children, open([]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item.id, 'a');
  assert.equal(rows[0].depth, 0);
});

test('flattenTree: folder closed - children hidden', () => {
  const roots: Node[] = [{ id: 'folder', children: [{ id: 'child', children: [] }] }];
  const rows = flattenTree(roots, children, open([])); // folder NOT open
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item.id, 'folder');
});

test('flattenTree: folder open - children visible', () => {
  const roots: Node[] = [{ id: 'folder', children: [{ id: 'child', children: [] }] }];
  const rows = flattenTree(roots, children, open(['folder']));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].item.id, 'folder');
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[1].item.id, 'child');
  assert.equal(rows[1].depth, 1);
});

test('flattenTree: nested open folders recurse correctly', () => {
  const roots: Node[] = [
    {
      id: 'a',
      children: [
        {
          id: 'b',
          children: [{ id: 'c', children: [] }],
        },
      ],
    },
  ];
  // a and b open
  const rows = flattenTree(roots, children, open(['a', 'b']));
  assert.deepEqual(
    rows.map((r) => ({ id: r.item.id, depth: r.depth })),
    [
      { id: 'a', depth: 0 },
      { id: 'b', depth: 1 },
      { id: 'c', depth: 2 },
    ],
  );
});

test('flattenTree: only top-level open - grandchildren hidden', () => {
  const roots: Node[] = [
    {
      id: 'a',
      children: [{ id: 'b', children: [{ id: 'c', children: [] }] }],
    },
  ];
  // only 'a' open, not 'b'
  const rows = flattenTree(roots, children, open(['a']));
  assert.deepEqual(
    rows.map((r) => r.item.id),
    ['a', 'b'],
  );
});

test('flattenTree: multiple roots', () => {
  const roots: Node[] = [
    { id: 'x', children: [] },
    { id: 'y', children: [] },
  ];
  const rows = flattenTree(roots, children, open([]));
  assert.deepEqual(
    rows.map((r) => r.item.id),
    ['x', 'y'],
  );
});

test('flattenTree: empty roots', () => {
  assert.deepEqual(flattenTree([], children, open([])), []);
});
