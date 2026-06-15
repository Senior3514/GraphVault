import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildTimelineState,
  computeTimelineDomain,
  endOfDay,
  formatDateLabel,
  msToSlider,
  nextAnimationFrame,
  nodeTimestamp,
  sliderToMs,
  startOfDay,
  TIMELINE_STEPS,
  timelineVisibleIds,
} from './timeline';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal GraphNode-like for testing. */
function n(id: string, createdAt?: number, updatedAt?: number) {
  return { id, createdAt, updatedAt };
}

// Handy epoch values (DAY is used in formatDateLabel test indirectly through Date calculations)
const D1 = Date.parse('2025-01-01T00:00:00.000Z'); // 1735689600000
const D2 = Date.parse('2025-01-15T00:00:00.000Z');
const D3 = Date.parse('2025-03-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// startOfDay / endOfDay
// ---------------------------------------------------------------------------

test('startOfDay snaps to midnight UTC', () => {
  const noon = Date.parse('2025-06-15T12:34:56.789Z');
  const sod = startOfDay(noon);
  assert.equal(new Date(sod).toISOString(), '2025-06-15T00:00:00.000Z');
});

test('endOfDay returns 23:59:59.999 UTC', () => {
  const noon = Date.parse('2025-06-15T12:34:56.789Z');
  const eod = endOfDay(noon);
  assert.equal(new Date(eod + 1).toISOString(), '2025-06-16T00:00:00.000Z');
});

test('startOfDay of an exact midnight is itself', () => {
  assert.equal(startOfDay(D1), D1);
});

// ---------------------------------------------------------------------------
// nodeTimestamp
// ---------------------------------------------------------------------------

test('nodeTimestamp prefers createdAt', () => {
  assert.equal(nodeTimestamp({ createdAt: 100, updatedAt: 200 }), 100);
});

test('nodeTimestamp falls back to updatedAt when createdAt absent', () => {
  assert.equal(nodeTimestamp({ updatedAt: 200 }), 200);
});

test('nodeTimestamp returns undefined when both absent', () => {
  assert.equal(nodeTimestamp({}), undefined);
});

// ---------------------------------------------------------------------------
// computeTimelineDomain
// ---------------------------------------------------------------------------

test('computeTimelineDomain returns null for empty list', () => {
  assert.equal(computeTimelineDomain([]), null);
});

test('computeTimelineDomain returns null when no timestamps', () => {
  assert.equal(computeTimelineDomain([n('a'), n('b')]), null);
});

test('computeTimelineDomain snaps to day boundaries', () => {
  const mid = D1 + 6 * 3600_000; // noon on 2025-01-01
  const result = computeTimelineDomain([n('a', mid)]);
  assert.ok(result !== null);
  assert.equal(result.domainStart, D1); // start of 2025-01-01
  assert.equal(result.domainEnd, endOfDay(D1));
});

test('computeTimelineDomain spans from min to max across nodes', () => {
  const nodes = [n('a', D1), n('b', D2), n('c', undefined, D3)];
  const result = computeTimelineDomain(nodes);
  assert.ok(result !== null);
  assert.equal(result.domainStart, startOfDay(D1));
  assert.equal(result.domainEnd, endOfDay(D3));
});

test('computeTimelineDomain expands single-day domain by 1 day', () => {
  const result = computeTimelineDomain([n('a', D1), n('b', D1 + 3600_000)]);
  assert.ok(result !== null);
  // domainStart = D1, domainEnd = endOfDay(D1) which is > D1
  assert.ok(result.domainEnd > result.domainStart);
});

// ---------------------------------------------------------------------------
// sliderToMs / msToSlider round-trip
// ---------------------------------------------------------------------------

test('sliderToMs returns domainStart at step 0', () => {
  assert.equal(sliderToMs(0, D1, D3), D1);
});

test('sliderToMs returns domainEnd at TIMELINE_STEPS', () => {
  assert.equal(sliderToMs(TIMELINE_STEPS, D1, D3), D3);
});

test('sliderToMs clamps out-of-range inputs', () => {
  assert.equal(sliderToMs(-10, D1, D3), D1);
  assert.equal(sliderToMs(TIMELINE_STEPS + 50, D1, D3), D3);
});

test('msToSlider returns 0 for domainStart', () => {
  assert.equal(msToSlider(D1, D1, D3), 0);
});

test('msToSlider returns TIMELINE_STEPS for domainEnd', () => {
  assert.equal(msToSlider(D3, D1, D3), TIMELINE_STEPS);
});

test('sliderToMs / msToSlider round-trip within ±1 step', () => {
  const domain = { start: D1, end: D3 };
  for (const step of [0, 25, 50, 100, 150, 200]) {
    const ms = sliderToMs(step, domain.start, domain.end);
    const back = msToSlider(ms, domain.start, domain.end);
    assert.ok(Math.abs(back - step) <= 1, `step ${step} round-trip ${back}`);
  }
});

test('msToSlider returns 0 when span is 0', () => {
  assert.equal(msToSlider(D1, D1, D1), 0);
});

// ---------------------------------------------------------------------------
// timelineVisibleIds
// ---------------------------------------------------------------------------

test('timelineVisibleIds returns null when disabled', () => {
  const nodes = [n('a', D1)];
  assert.equal(timelineVisibleIds(nodes, D1, D3, false), null);
});

test('timelineVisibleIds includes nodes inside window', () => {
  const nodes = [n('a', D1), n('b', D2), n('c', D3)];
  const result = timelineVisibleIds(nodes, D1, D2, true);
  assert.ok(result !== null);
  assert.ok(result.has('a'));
  assert.ok(result.has('b'));
  assert.ok(!result.has('c'));
});

test('timelineVisibleIds always includes nodes with no timestamp', () => {
  const nodes = [n('stamped', D1), n('unstamped')];
  // window that excludes D1
  const result = timelineVisibleIds(nodes, D2, D3, true);
  assert.ok(result !== null);
  assert.ok(!result.has('stamped'));
  assert.ok(result.has('unstamped'));
});

test('timelineVisibleIds uses inclusive bounds', () => {
  const nodes = [n('a', D1), n('b', D3)];
  const result = timelineVisibleIds(nodes, D1, D3, true);
  assert.ok(result !== null);
  assert.ok(result.has('a'));
  assert.ok(result.has('b'));
});

test('timelineVisibleIds empty set when window excludes all timestamped', () => {
  const nodes = [n('a', D3)];
  const result = timelineVisibleIds(nodes, D1, D2, true);
  assert.ok(result !== null);
  assert.equal(result.size, 0);
});

// ---------------------------------------------------------------------------
// nextAnimationFrame
// ---------------------------------------------------------------------------

test('nextAnimationFrame advances the window', () => {
  const span = D3 - D1;
  const frame = nextAnimationFrame(D1 + span * 0.5, D1, D3);
  assert.ok(frame !== null);
  assert.ok(frame.windowEnd > D1 + span * 0.5);
  assert.ok(frame.windowStart <= frame.windowEnd);
});

test('nextAnimationFrame returns null when at end', () => {
  assert.equal(nextAnimationFrame(D3, D1, D3), null);
});

test('nextAnimationFrame returns null when past end', () => {
  assert.equal(nextAnimationFrame(D3 + 1000, D1, D3), null);
});

test('nextAnimationFrame window clamps start to domainStart', () => {
  // Start the animation very close to domainStart
  const frame = nextAnimationFrame(D1 + 1000, D1, D3);
  assert.ok(frame !== null);
  assert.ok(frame.windowStart >= D1);
});

test('nextAnimationFrame uses custom stepMs', () => {
  const stepMs = 86_400_000 * 7; // 7 days
  const frame = nextAnimationFrame(D1, D1, D3, stepMs);
  assert.ok(frame !== null);
  assert.equal(frame.windowEnd, D1 + stepMs);
});

// ---------------------------------------------------------------------------
// formatDateLabel
// ---------------------------------------------------------------------------

test('formatDateLabel formats a known date', () => {
  assert.equal(formatDateLabel(D1), '01 Jan 2025');
});

test('formatDateLabel formats another date', () => {
  assert.equal(formatDateLabel(Date.parse('2026-06-15T00:00:00.000Z')), '15 Jun 2026');
});

test('formatDateLabel uses two-digit day', () => {
  const d = Date.parse('2025-03-07T00:00:00.000Z');
  assert.match(formatDateLabel(d), /^07 Mar 2025$/);
});

// ---------------------------------------------------------------------------
// buildTimelineState
// ---------------------------------------------------------------------------

test('buildTimelineState returns null when no timestamps', () => {
  assert.equal(buildTimelineState([n('a'), n('b')]), null);
});

test('buildTimelineState initialises full window, disabled, not playing', () => {
  const nodes = [n('a', D1), n('b', D3)];
  const state = buildTimelineState(nodes);
  assert.ok(state !== null);
  assert.equal(state.domainStart, startOfDay(D1));
  assert.equal(state.domainEnd, endOfDay(D3));
  assert.equal(state.windowStart, state.domainStart);
  assert.equal(state.windowEnd, state.domainEnd);
  assert.equal(state.enabled, false);
  assert.equal(state.playing, false);
});
