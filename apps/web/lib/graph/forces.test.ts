import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makePositioningForce, type ForceNode } from './forces';

test('positioning force is a no-op at zero strength', () => {
  const force = makePositioningForce('x', 0);
  const node: ForceNode = { x: 100, vx: 0 };
  force.initialize([node]);
  force(1);
  assert.equal(node.vx, 0);
});

test('positioning force pulls velocity toward the target on the x axis', () => {
  const force = makePositioningForce('x', 0).strength(0.1);
  const node: ForceNode = { x: 100, vx: 0 };
  force.initialize([node]);
  force(1); // alpha = 1
  // vx += (target - x) * strength * alpha = (0 - 100) * 0.1 = -10
  assert.equal(node.vx, -10);
});

test('positioning force scales by alpha', () => {
  const force = makePositioningForce('y', 0).strength(0.2);
  const node: ForceNode = { y: 50, vy: 0 };
  force.initialize([node]);
  force(0.5);
  // vy += (0 - 50) * 0.2 * 0.5 = -5
  assert.equal(node.vy, -5);
});

test('positioning force respects a non-zero target', () => {
  const force = makePositioningForce('x', 20).strength(0.5);
  const node: ForceNode = { x: 0, vx: 0 };
  force.initialize([node]);
  force(1);
  // vx += (20 - 0) * 0.5 = 10
  assert.equal(node.vx, 10);
});

test('positioning force ignores pinned nodes (fx/fy set)', () => {
  const force = makePositioningForce('x', 0).strength(0.5);
  const pinned: ForceNode = { x: 100, vx: 0, fx: 100 };
  const free: ForceNode = { x: 100, vx: 0 };
  force.initialize([pinned, free]);
  force(1);
  assert.equal(pinned.vx, 0); // untouched - it's pinned
  assert.equal(free.vx, -50); // moved
});

test('positioning force skips nodes without a position', () => {
  const force = makePositioningForce('x', 0).strength(0.5);
  const node: ForceNode = { vx: 0 }; // no x yet
  force.initialize([node]);
  assert.doesNotThrow(() => force(1));
  assert.equal(node.vx, 0);
});

test('strength is retunable and chainable', () => {
  const force = makePositioningForce('x', 0);
  assert.equal(force.strength(0.3), force); // chainable
  const node: ForceNode = { x: 10, vx: 0 };
  force.initialize([node]);
  force(1);
  assert.equal(node.vx, -3);
  // Retune to zero → no-op.
  force.strength(0);
  node.vx = 0;
  force(1);
  assert.equal(node.vx, 0);
});
