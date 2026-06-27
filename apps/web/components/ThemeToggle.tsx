'use client';

/**
 * ThemeToggle - a compact segmented control for Light / Dark / System.
 *
 * Styling mirrors the Sidebar's interactive surfaces (neutral-on-neutral with a
 * sky active accent) so it sits naturally in the icon-rail footer. It flips
 * automatically in light mode because those `neutral-*` utilities are driven by
 * CSS variables (see globals.css).
 *
 * Accessibility: rendered as a radiogroup-style segmented control. Each segment
 * is a button with `aria-pressed` reflecting the active mode and a descriptive
 * `aria-label`/`title`. Fully keyboard reachable (native buttons); the active
 * segment also reads as pressed to screen readers.
 *
 * When `collapsed` (icon rail), only the active segment's icon is shown as a
 * single cycling button to save space; expanded shows all three segments.
 */

import { useTheme } from './ThemeProvider';
import type { ThemeMode } from '../lib/theme';

interface Segment {
  mode: ThemeMode;
  label: string;
  hint: string;
}

const SEGMENTS: Segment[] = [
  { mode: 'light', label: 'Light', hint: 'Light theme' },
  { mode: 'dark', label: 'Dark', hint: 'Dark theme' },
  { mode: 'system', label: 'System', hint: 'Match system preference' },
];

export function ThemeToggle({ collapsed = false }: { collapsed?: boolean }) {
  const { mode, setMode } = useTheme();

  // Collapsed icon rail: one button that cycles light → dark → system.
  if (collapsed) {
    const order: ThemeMode[] = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(mode) + 1) % order.length];
    const current = SEGMENTS.find((s) => s.mode === mode) ?? SEGMENTS[2];
    return (
      <button
        type="button"
        onClick={() => setMode(next)}
        aria-label={`Theme: ${current.label}. Activate to switch to ${
          SEGMENTS.find((s) => s.mode === next)?.label
        }.`}
        title={`Theme: ${current.label} (click to cycle)`}
        className="flex min-h-[44px] w-full items-center justify-center rounded-md p-2 text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
      >
        <ThemeIcon mode={mode} className="h-5 w-5" />
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900/60 p-1"
    >
      {SEGMENTS.map((seg) => {
        const active = seg.mode === mode;
        return (
          <button
            key={seg.mode}
            type="button"
            onClick={() => setMode(seg.mode)}
            aria-pressed={active}
            aria-label={seg.hint}
            title={seg.hint}
            className={[
              'flex min-h-[32px] flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
              active
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300',
            ].join(' ')}
          >
            <ThemeIcon
              mode={seg.mode}
              className={['h-4 w-4 shrink-0', active ? 'text-sky-400' : ''].join(' ')}
            />
            <span>{seg.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ThemeIcon({ mode, className }: { mode: ThemeMode; className?: string }) {
  if (mode === 'light') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
        <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
        <path
          d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (mode === 'dark') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
        <path
          d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  // system - monitor glyph
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 20h8M12 16v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
