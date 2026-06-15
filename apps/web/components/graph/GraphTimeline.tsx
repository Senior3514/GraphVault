'use client';

/**
 * The graph time-slider control.
 *
 * Renders as a compact panel that sits inside the graph controls rail (desktop)
 * or the mobile drawer. It exposes:
 *   - A toggle switch to enable/disable the timeline filter
 *   - A dual-handle range scrubber (start and end date handles)
 *   - A date display showing the current window
 *   - A Play / Pause button that animates the window sweeping through history
 *
 * This component is purely presentational. All timeline state lives in the
 * page; the timeline helper functions (in lib/graph/timeline.ts) are pure and
 * framework-free.
 *
 * The animation loop runs inside the component via `setInterval` and drives
 * the parent's `onChange` on each tick. The current state is read through a
 * ref so the interval closure always sees fresh values without re-registration.
 */

import { useCallback, useEffect, useRef } from 'react';

import {
  ANIMATION_INTERVAL_MS,
  formatDateLabel,
  msToSlider,
  nextAnimationFrame,
  sliderToMs,
  TIMELINE_STEPS,
  type TimelineState,
} from '../../lib/graph/timeline';

export interface GraphTimelineProps {
  /** The full timeline state. `null` means no nodes have timestamps → hide. */
  state: TimelineState | null;
  onChange: (patch: Partial<TimelineState>) => void;
}

export function GraphTimeline({ state, onChange }: GraphTimelineProps) {
  // Keep a ref so the animation interval always reads the latest state.
  const stateRef = useRef(state);
  stateRef.current = state;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Animation interval handle.
  const animRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopAnimation = useCallback(() => {
    if (animRef.current !== null) {
      clearInterval(animRef.current);
      animRef.current = null;
    }
  }, []);

  const startAnimation = useCallback(() => {
    stopAnimation();
    animRef.current = setInterval(() => {
      const s = stateRef.current;
      if (!s) {
        stopAnimation();
        return;
      }
      const frame = nextAnimationFrame(s.windowEnd, s.domainStart, s.domainEnd);
      if (frame === null) {
        // Animation complete: stop and open the full window.
        stopAnimation();
        onChangeRef.current({
          playing: false,
          windowStart: s.domainStart,
          windowEnd: s.domainEnd,
        });
        return;
      }
      onChangeRef.current({ windowStart: frame.windowStart, windowEnd: frame.windowEnd });
    }, ANIMATION_INTERVAL_MS);
  }, [stopAnimation]);

  // React to playing state changes.
  useEffect(() => {
    if (state?.playing) {
      startAnimation();
    } else {
      stopAnimation();
    }
  }, [state?.playing, startAnimation, stopAnimation]);

  // Cleanup on unmount.
  useEffect(() => () => stopAnimation(), [stopAnimation]);

  if (!state) return null;

  const { domainStart, domainEnd, windowStart, windowEnd, enabled, playing } = state;

  const startStep = msToSlider(windowStart, domainStart, domainEnd);
  const endStep = msToSlider(windowEnd, domainStart, domainEnd);

  const handleStartChange = (step: number) => {
    const ms = sliderToMs(step, domainStart, domainEnd);
    // Don't let start exceed end.
    onChange({ windowStart: ms, windowEnd: Math.max(ms, windowEnd) });
  };

  const handleEndChange = (step: number) => {
    const ms = sliderToMs(step, domainStart, domainEnd);
    // Don't let end precede start.
    onChange({ windowStart: Math.min(windowStart, ms), windowEnd: ms });
  };

  const handlePlayPause = () => {
    if (playing) {
      onChange({ playing: false });
      return;
    }
    // If window is at the end, restart from the beginning.
    const atEnd = windowEnd >= domainEnd;
    const span = domainEnd - domainStart;
    const windowSize = Math.round(span * 0.25);
    if (atEnd) {
      onChange({
        playing: true,
        windowStart: domainStart,
        windowEnd: domainStart + windowSize,
      });
    } else {
      onChange({ playing: true });
    }
  };

  const toggleEnabled = () => {
    if (playing) onChange({ playing: false });
    onChange({ enabled: !enabled });
  };

  // Fill percentages for the active range track.
  const startPct = (startStep / TIMELINE_STEPS) * 100;
  const endPct = (endStep / TIMELINE_STEPS) * 100;

  return (
    <div
      className={[
        'flex flex-col gap-2 rounded-lg border bg-neutral-950 px-3 py-2.5',
        enabled ? 'border-neutral-600' : 'border-neutral-800',
      ].join(' ')}
    >
      {/* Header row: label + toggle */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Timeline
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={toggleEnabled}
          title={enabled ? 'Disable timeline filter' : 'Enable timeline filter'}
          className={[
            'relative inline-flex h-4 w-8 shrink-0 cursor-pointer rounded-full border-0 transition-colors duration-200',
            enabled ? 'bg-blue-500' : 'bg-neutral-700',
          ].join(' ')}
        >
          <span
            className={[
              'mt-px inline-block h-3 w-3 rounded-full bg-white shadow transition-transform duration-200',
              enabled ? 'translate-x-4' : 'translate-x-0.5',
            ].join(' ')}
          />
        </button>
      </div>

      {enabled && (
        <>
          {/* Date window display */}
          <div className="flex items-center justify-between text-[11px] text-neutral-400">
            <span className="font-mono tabular-nums">{formatDateLabel(windowStart)}</span>
            <span className="text-neutral-600">—</span>
            <span className="font-mono tabular-nums">{formatDateLabel(windowEnd)}</span>
          </div>

          {/* Dual-range scrubber
              Two stacked <input type=range> rendered transparently so the
              browser handles hit-testing; visual thumbs are positioned absolutely
              to match. */}
          <div className="relative flex h-5 items-center">
            {/* Track background */}
            <div className="pointer-events-none absolute inset-x-0 h-1 rounded-full bg-neutral-800" />
            {/* Active range fill */}
            <div
              className="pointer-events-none absolute h-1 rounded-full bg-blue-500/60"
              style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
            />
            {/* Start handle — lower z-index when start is beyond midpoint so end stays on top */}
            <input
              type="range"
              min={0}
              max={TIMELINE_STEPS}
              step={1}
              value={startStep}
              onChange={(e) => handleStartChange(Number(e.target.value))}
              aria-label="Timeline window start"
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
              style={{ zIndex: startStep >= TIMELINE_STEPS / 2 ? 3 : 4 }}
            />
            {/* End handle */}
            <input
              type="range"
              min={0}
              max={TIMELINE_STEPS}
              step={1}
              value={endStep}
              onChange={(e) => handleEndChange(Number(e.target.value))}
              aria-label="Timeline window end"
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
              style={{ zIndex: startStep >= TIMELINE_STEPS / 2 ? 4 : 3 }}
            />
            {/* Visual thumb for start */}
            <div
              className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-blue-400 bg-neutral-900 shadow"
              style={{ left: `${startPct}%`, zIndex: 2 }}
              aria-hidden
            />
            {/* Visual thumb for end */}
            <div
              className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-blue-300 bg-neutral-900 shadow"
              style={{ left: `${endPct}%`, zIndex: 2 }}
              aria-hidden
            />
          </div>

          {/* Domain boundary labels */}
          <div className="flex justify-between text-[10px] text-neutral-700">
            <span>{formatDateLabel(domainStart)}</span>
            <span>{formatDateLabel(domainEnd)}</span>
          </div>

          {/* Play/Pause button */}
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={handlePlayPause}
              aria-label={playing ? 'Pause timeline animation' : 'Play timeline animation'}
              title={playing ? 'Pause' : 'Play — animate through history'}
              className={[
                'flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs font-medium transition-colors',
                playing
                  ? 'border-blue-700 bg-blue-900/40 text-blue-300 hover:bg-blue-800/50'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100',
              ].join(' ')}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
              {playing ? 'Pause' : 'Play'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor" aria-hidden>
      <path d="M3 1.5 10.5 6 3 10.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor" aria-hidden>
      <rect x="2" y="1.5" width="3" height="9" rx="0.5" />
      <rect x="7" y="1.5" width="3" height="9" rx="0.5" />
    </svg>
  );
}
