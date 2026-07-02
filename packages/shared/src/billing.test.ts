import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { cloudFeatureSchema, planIncludes, planInfoSchema, planTierSchema } from './billing.js';

test('planTierSchema accepts only free and cloud', () => {
  assert.equal(planTierSchema.parse('free'), 'free');
  assert.equal(planTierSchema.parse('cloud'), 'cloud');
  assert.throws(() => planTierSchema.parse('enterprise'));
});

test('planInfoSchema requires renewsAt to be a valid ISO datetime when present', () => {
  const info = planInfoSchema.parse({
    tier: 'cloud',
    status: 'active',
    renewsAt: new Date().toISOString(),
  });
  assert.equal(info.tier, 'cloud');
  assert.throws(() =>
    planInfoSchema.parse({ tier: 'cloud', status: 'active', renewsAt: 'not-a-date' }),
  );
});

test('planInfoSchema allows renewsAt to be omitted (free tier, no subscription)', () => {
  const info = planInfoSchema.parse({ tier: 'free', status: 'none' });
  assert.equal(info.renewsAt, undefined);
});

test('planIncludes: free tier never includes a gated feature', () => {
  for (const feature of cloudFeatureSchema.options) {
    assert.equal(planIncludes('free', feature), false);
  }
});

test('planIncludes: cloud tier includes every gated feature', () => {
  for (const feature of cloudFeatureSchema.options) {
    assert.equal(planIncludes('cloud', feature), true);
  }
});
