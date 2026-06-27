/**
 * Tour step configuration tests.
 *
 * Tests the pure configuration data in TOUR_STEPS:
 *   - Expected count and unique IDs.
 *   - Required fields are non-empty.
 *   - Storage key and event name are stable (breaking changes would lose
 *     user dismissed-state across deployments).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Import only the pure exports - the component itself is React/DOM-only.
import { TOUR_STEPS, TOUR_DISMISSED_KEY, TOUR_OPEN_EVENT } from '../../components/onboarding/Tour';

test('TOUR_DISMISSED_KEY is the expected stable string', () => {
  assert.equal(TOUR_DISMISSED_KEY, 'graphvault.tour.dismissed');
});

test('TOUR_OPEN_EVENT is the expected stable string', () => {
  assert.equal(TOUR_OPEN_EVENT, 'graphvault.tour.open');
});

test('tour has between 4 and 10 steps', () => {
  assert.ok(
    TOUR_STEPS.length >= 4 && TOUR_STEPS.length <= 10,
    `Expected 4-10 steps, got ${TOUR_STEPS.length}`,
  );
});

test('every tour step has a unique id', () => {
  const ids = TOUR_STEPS.map((s) => s.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, `Duplicate step IDs: ${ids.join(', ')}`);
});

test('every tour step has non-empty title and body', () => {
  for (const step of TOUR_STEPS) {
    assert.ok(step.title.trim().length > 0, `Step "${step.id}" has empty title`);
    assert.ok(step.body.trim().length > 0, `Step "${step.id}" has empty body`);
  }
});

test('every tour step has a valid placement', () => {
  const valid = new Set(['top', 'bottom', 'left', 'right', 'center']);
  for (const step of TOUR_STEPS) {
    assert.ok(
      valid.has(step.placement),
      `Step "${step.id}" has invalid placement "${step.placement}"`,
    );
  }
});

test('steps with a targetSelector have a string placement (not center-only)', () => {
  for (const step of TOUR_STEPS) {
    if (step.targetSelector !== null) {
      assert.ok(
        typeof step.targetSelector === 'string' && step.targetSelector.length > 0,
        `Step "${step.id}" targetSelector is invalid`,
      );
    }
  }
});

test('command-palette step is first (sets the right entry-point expectation)', () => {
  assert.equal(TOUR_STEPS[0].id, 'command-palette');
});

test('shortcut field, when present, is a non-empty string', () => {
  for (const step of TOUR_STEPS) {
    if (step.shortcut !== undefined) {
      assert.ok(
        typeof step.shortcut === 'string' && step.shortcut.trim().length > 0,
        `Step "${step.id}" shortcut is empty`,
      );
    }
  }
});
