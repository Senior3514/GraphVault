/**
 * Tests for the budget / spend meter helpers (lib/ai/budget.ts).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildBudgetMeter, formatUsd } from './budget.js';
import type { AiSpendCapState } from '@graphvault/shared';

const baseState: AiSpendCapState = {
  state: 'ok',
  windowSpentUsd: 0,
  windowRequests: 0,
  windowResetsAt: '2026-06-28T00:00:00.000Z',
};

describe('formatUsd()', () => {
  it('formats whole-dollar amounts with two decimals', () => {
    assert.equal(formatUsd(5), '$5.00');
  });
  it('formats tiny per-call costs with four decimals', () => {
    assert.equal(formatUsd(0.0007), '$0.0007');
  });
  it('clamps negative / non-finite to $0.00', () => {
    assert.equal(formatUsd(-1), '$0.00');
    assert.equal(formatUsd(Number.NaN), '$0.00');
  });
});

describe('buildBudgetMeter()', () => {
  it('computes percent against the configured cap', () => {
    const m = buildBudgetMeter({ ...baseState, windowSpentUsd: 2.5 }, 5);
    assert.equal(m.percent, 50);
    assert.equal(m.spendLabel, '$2.50 / $5.00');
    assert.equal(m.exhausted, false);
  });

  it('clamps percent to 100 when over the cap', () => {
    const m = buildBudgetMeter({ ...baseState, state: 'exceeded', windowSpentUsd: 9 }, 5);
    assert.equal(m.percent, 100);
    assert.equal(m.exhausted, true);
  });

  it('shows 0% and a no-cap label when no dollar cap is set', () => {
    const m = buildBudgetMeter({ ...baseState, windowSpentUsd: 1.23 }, undefined);
    assert.equal(m.percent, 0);
    assert.ok(m.spendLabel.includes('no $ cap'));
  });

  it('honours exceeded state from the request cap even with no $ cap', () => {
    const m = buildBudgetMeter({ ...baseState, state: 'exceeded', windowRequests: 200 }, 0);
    assert.equal(m.exhausted, true);
    assert.equal(m.requestLabel, '200 requests today');
  });

  it('uses singular "request" for exactly one', () => {
    const m = buildBudgetMeter({ ...baseState, windowRequests: 1 }, 5);
    assert.equal(m.requestLabel, '1 request today');
  });

  it('maps server state through to the meter', () => {
    const m = buildBudgetMeter({ ...baseState, state: 'warning', windowSpentUsd: 4.5 }, 5);
    assert.equal(m.state, 'warning');
    assert.equal(m.percent, 90);
  });
});
