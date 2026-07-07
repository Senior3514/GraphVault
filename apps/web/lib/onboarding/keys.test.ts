/**
 * Onboarding coordination key tests.
 *
 * `OnboardingHint` and `Tour` cover overlapping ground (command palette,
 * wikilinks, tags) and used to be mounted independently, which meant both
 * showed on screen at once on a brand-new user's first vault view. They now
 * coordinate via these two keys - `Tour`'s dismiss handler marks the hint
 * dismissed too, and the hint refuses to show until the tour is dismissed.
 * These tests lock the stable string values (a change would silently reset
 * dismissed-state for every existing user) and guard against the two keys
 * ever colliding, which would make the two components fight over one flag.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ONBOARDING_HINT_DISMISSED_KEY,
  TOUR_DISMISSED_KEY,
} from '../../components/onboarding/keys';

test('ONBOARDING_HINT_DISMISSED_KEY is the expected stable string', () => {
  assert.equal(ONBOARDING_HINT_DISMISSED_KEY, 'graphvault.onboarding.dismissed');
});

test('TOUR_DISMISSED_KEY is the expected stable string', () => {
  assert.equal(TOUR_DISMISSED_KEY, 'graphvault.tour.dismissed');
});

test('the two dismissed keys are distinct', () => {
  assert.notEqual(ONBOARDING_HINT_DISMISSED_KEY, TOUR_DISMISSED_KEY);
});
