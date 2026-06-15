import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampPhysics,
  DEFAULT_PHYSICS,
  PHYSICS_BOUNDS,
  radiusForDegree,
  shouldShowLabel,
} from './physics';

test('clampPhysics merges a patch onto the base', () => {
  const next = clampPhysics(DEFAULT_PHYSICS, { linkDistance: 90 });
  assert.equal(next.linkDistance, 90);
  assert.equal(next.chargeStrength, DEFAULT_PHYSICS.chargeStrength);
});

test('clampPhysics clamps each field into its bounds', () => {
  const tooBig = clampPhysics(DEFAULT_PHYSICS, {
    linkDistance: 10_000,
    chargeStrength: 10, // positive → clamped to the max (least negative) bound
    centerGravity: 5,
    labelThreshold: 100,
  });
  assert.equal(tooBig.linkDistance, PHYSICS_BOUNDS.linkDistance.max);
  assert.equal(tooBig.chargeStrength, PHYSICS_BOUNDS.chargeStrength.max);
  assert.equal(tooBig.centerGravity, PHYSICS_BOUNDS.centerGravity.max);
  assert.equal(tooBig.labelThreshold, PHYSICS_BOUNDS.labelThreshold.max);

  const tooSmall = clampPhysics(DEFAULT_PHYSICS, {
    linkDistance: -50,
    chargeStrength: -99_999,
    centerGravity: -1,
    labelThreshold: -1,
  });
  assert.equal(tooSmall.linkDistance, PHYSICS_BOUNDS.linkDistance.min);
  assert.equal(tooSmall.chargeStrength, PHYSICS_BOUNDS.chargeStrength.min);
  assert.equal(tooSmall.centerGravity, PHYSICS_BOUNDS.centerGravity.min);
  assert.equal(tooSmall.labelThreshold, PHYSICS_BOUNDS.labelThreshold.min);
});

test('clampPhysics maps NaN to the lower bound', () => {
  const next = clampPhysics(DEFAULT_PHYSICS, { linkDistance: Number.NaN });
  assert.equal(next.linkDistance, PHYSICS_BOUNDS.linkDistance.min);
});

test('radiusForDegree grows with degree but saturates for hubs', () => {
  assert.ok(radiusForDegree(0) < radiusForDegree(4));
  assert.ok(radiusForDegree(4) < radiusForDegree(40));
  // Square-root curve with a cap: a 1000-degree hub is not absurdly large.
  assert.ok(radiusForDegree(1000) <= 3 + 7);
});

test('shouldShowLabel always shows focused nodes, otherwise gates on zoom', () => {
  assert.equal(shouldShowLabel({ globalScale: 0.5, threshold: 1.6, isFocused: true }), true);
  assert.equal(shouldShowLabel({ globalScale: 0.5, threshold: 1.6, isFocused: false }), false);
  assert.equal(shouldShowLabel({ globalScale: 2, threshold: 1.6, isFocused: false }), true);
  assert.equal(shouldShowLabel({ globalScale: 1.6, threshold: 1.6, isFocused: false }), true);
});
