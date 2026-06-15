/**
 * Pure, framework-free helpers for the graph time-slider.
 *
 * The time-slider shows how the graph "grew" over time by highlighting nodes
 * whose `createdAt` or `updatedAt` timestamp falls within a selected window.
 * Nodes outside the window are dimmed (not removed) so the layout stays stable
 * while scrubbing or animating.
 *
 * Design notes:
 * - All functions are pure and tested — no React, no DOM.
 * - The slider works in Unix epoch milliseconds internally; the UI converts
 *   slider values (integers 0..STEPS) to epoch ms via `sliderToMs`.
 * - "Effective timestamp" of a node: `createdAt` if available, else `updatedAt`,
 *   else `undefined`. Nodes with no timestamp are always considered in-window so
 *   they never disappear (they were created "from the beginning").
 * - The animation player increments the right-edge (windowEnd) from the
 *   first node's timestamp to the last, sweeping through the full history.
 */

import type { GraphNode } from '@graphvault/engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The UI state for the time-slider. All epoch-ms values are rounded to the
 * nearest day boundary so the slider steps feel like calendar dates.
 */
export interface TimelineState {
  /** Epoch ms of the earliest node in the graph (start of that UTC day). */
  domainStart: number;
  /** Epoch ms of the latest node in the graph (end of that UTC day). */
  domainEnd: number;
  /** Left edge of the selection window (epoch ms, >= domainStart). */
  windowStart: number;
  /** Right edge of the selection window (epoch ms, <= domainEnd). */
  windowEnd: number;
  /** True when the timeline is enabled (slider is visible and active). */
  enabled: boolean;
  /** True when the play animation is running. */
  playing: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of discrete steps across the full domain. Controls slider granularity. */
export const TIMELINE_STEPS = 200;

/** Animation frame interval in milliseconds (approx 24 fps). */
export const ANIMATION_INTERVAL_MS = 42;

/**
 * Fraction of the domain that the sliding window covers during animation.
 * A value of 0.25 means the window spans roughly a quarter of the history.
 */
export const ANIMATION_WINDOW_FRACTION = 0.25;

// ---------------------------------------------------------------------------
// Domain computation
// ---------------------------------------------------------------------------

/** Start of the UTC day containing `ms`. */
export function startOfDay(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

/** End of the UTC day containing `ms` (23:59:59.999). */
export function endOfDay(ms: number): number {
  return startOfDay(ms) + 86_400_000 - 1;
}

/**
 * Compute the effective timestamp for a node: `createdAt` if present, else
 * `updatedAt`. Returns `undefined` when neither is available.
 */
export function nodeTimestamp(
  node: Pick<GraphNode, 'createdAt' | 'updatedAt'>,
): number | undefined {
  return node.createdAt ?? node.updatedAt;
}

/**
 * Derive the timeline domain from a collection of graph nodes.
 * Returns `null` when no nodes have timestamps (timeline is pointless).
 *
 * The domain is snapped to UTC day boundaries so the display always starts and
 * ends at midnight, keeping calendar labels clean.
 */
export function computeTimelineDomain(
  nodes: ReadonlyArray<Pick<GraphNode, 'createdAt' | 'updatedAt'>>,
): { domainStart: number; domainEnd: number } | null {
  let min = Infinity;
  let max = -Infinity;

  for (const node of nodes) {
    const ts = nodeTimestamp(node);
    if (ts === undefined) continue;
    if (ts < min) min = ts;
    if (ts > max) max = ts;
  }

  if (!isFinite(min) || !isFinite(max)) return null;

  // Identical start/end (all notes same day): give a 1-day domain so the
  // slider still renders meaningfully.
  const domainStart = startOfDay(min);
  const rawEnd = endOfDay(max);
  const domainEnd = rawEnd > domainStart ? rawEnd : domainStart + 86_400_000 - 1;

  return { domainStart, domainEnd };
}

// ---------------------------------------------------------------------------
// Slider ↔ epoch-ms conversion
// ---------------------------------------------------------------------------

/**
 * Convert a slider integer (0..TIMELINE_STEPS) to an epoch-ms value within
 * [domainStart, domainEnd]. Clamped so rounding never exceeds the domain.
 */
export function sliderToMs(
  step: number,
  domainStart: number,
  domainEnd: number,
  steps: number = TIMELINE_STEPS,
): number {
  const clamped = Math.max(0, Math.min(steps, step));
  return domainStart + Math.round((clamped / steps) * (domainEnd - domainStart));
}

/**
 * Convert an epoch-ms value to the nearest slider integer (0..TIMELINE_STEPS).
 */
export function msToSlider(
  ms: number,
  domainStart: number,
  domainEnd: number,
  steps: number = TIMELINE_STEPS,
): number {
  const span = domainEnd - domainStart;
  if (span <= 0) return 0;
  const ratio = (ms - domainStart) / span;
  return Math.round(Math.max(0, Math.min(1, ratio)) * steps);
}

// ---------------------------------------------------------------------------
// Window filtering
// ---------------------------------------------------------------------------

/**
 * Return the set of node IDs whose effective timestamp falls within
 * [windowStart, windowEnd] (inclusive). Nodes with no timestamp are always
 * included (treated as existing from the beginning of time).
 *
 * Returns `null` when the timeline is disabled so the canvas can distinguish
 * "no timeline active" from "timeline active, nothing in window".
 */
export function timelineVisibleIds(
  nodes: ReadonlyArray<Pick<GraphNode, 'id' | 'createdAt' | 'updatedAt'>>,
  windowStart: number,
  windowEnd: number,
  enabled: boolean,
): Set<string> | null {
  if (!enabled) return null;

  const ids = new Set<string>();
  for (const node of nodes) {
    const ts = nodeTimestamp(node);
    if (ts === undefined) {
      // No timestamp → always visible.
      ids.add(node.id);
      continue;
    }
    if (ts >= windowStart && ts <= windowEnd) {
      ids.add(node.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

/**
 * Compute the next animation frame's window bounds. The animation sweeps the
 * right edge (windowEnd) from domainStart to domainEnd while keeping the window
 * a fixed fraction of the domain wide.
 *
 * Returns `null` when the animation has reached the end (caller should stop).
 */
export function nextAnimationFrame(
  currentWindowEnd: number,
  domainStart: number,
  domainEnd: number,
  stepMs?: number,
): { windowStart: number; windowEnd: number } | null {
  const span = domainEnd - domainStart;
  const windowSize = Math.max(1, Math.round(span * ANIMATION_WINDOW_FRACTION));
  const advanceMs = stepMs ?? Math.max(1, Math.round(span / TIMELINE_STEPS));

  const nextEnd = currentWindowEnd + advanceMs;
  if (nextEnd > domainEnd) return null; // animation complete

  const nextStart = Math.max(domainStart, nextEnd - windowSize);
  return { windowStart: nextStart, windowEnd: nextEnd };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format an epoch-ms value as a short human date label (`DD MMM YYYY`).
 * Pure, locale-independent (uses UTC so it matches the UTC day boundaries).
 */
export function formatDateLabel(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const month = months[d.getUTCMonth()] ?? 'Jan';
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

/**
 * Build the initial `TimelineState` from a set of nodes. Returns `null` if the
 * graph has no timestamped nodes (slider should be hidden entirely).
 */
export function buildTimelineState(
  nodes: ReadonlyArray<Pick<GraphNode, 'id' | 'createdAt' | 'updatedAt'>>,
): TimelineState | null {
  const domain = computeTimelineDomain(nodes);
  if (!domain) return null;
  return {
    domainStart: domain.domainStart,
    domainEnd: domain.domainEnd,
    windowStart: domain.domainStart,
    windowEnd: domain.domainEnd,
    enabled: false,
    playing: false,
  };
}
