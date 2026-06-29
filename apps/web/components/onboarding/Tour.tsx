'use client';

/**
 * Guided tour - multi-step coachmark/spotlight shown on first run.
 *
 * ## Behaviour
 * - Shown once; dismissed state persisted in localStorage.
 * - Re-openable: dispatches `graphvault.tour.open` custom event (listen from
 *   any component, e.g. CommandPalette or a "Replay tour" button).
 * - 6 steps pointing at key features: command palette, wikilinks, tags,
 *   graph, AI assistant, and version history/backups.
 * - Keyboard: Esc → close; ArrowRight/Enter → next; ArrowLeft → prev.
 * - Focus trapped inside the coachmark while open.
 * - `prefers-reduced-motion` respected (animation class is motion-safe).
 * - Fully responsive - falls back to centred modal when no target element
 *   is found or the step is designated center-only.
 *
 * ## Architecture
 * - Pure client component with zero new dependencies.
 * - Mounted additively in AppFrame; does not replace OnboardingHint.
 * - The spotlight ring uses a fixed overlay with a CSS mask cutout.
 */

import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TOUR_DISMISSED_KEY = 'graphvault.tour.dismissed';
export const TOUR_OPEN_EVENT = 'graphvault.tour.open';

// ---------------------------------------------------------------------------
// Tour step definitions
// ---------------------------------------------------------------------------

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** CSS selector for the element to highlight. Null → centred modal. */
  targetSelector: string | null;
  /** Where to place the card relative to the highlighted element. */
  placement: 'top' | 'bottom' | 'left' | 'right' | 'center';
  /** Short keyboard hint shown in the coachmark (optional). */
  shortcut?: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'command-palette',
    title: 'Command Palette',
    body: 'Press Cmd K (or Ctrl K) to open any note, run commands, or search your entire vault - from anywhere in the app. This is your fastest way to navigate.',
    targetSelector: null,
    placement: 'center',
    shortcut: 'Cmd K',
  },
  {
    id: 'wikilinks',
    title: 'Link notes with [[ ]]',
    body: 'Type [[ in the editor to link to another note. Autocomplete pops up immediately. Every link you write becomes an edge in your knowledge graph - no orphans.',
    targetSelector: null,
    placement: 'center',
    shortcut: '[[',
  },
  {
    id: 'tags',
    title: 'Organise with #tags',
    body: 'Add a #tag anywhere in a note (or in frontmatter). Tags cluster nodes in the graph and power the filter panel - great for cross-cutting themes.',
    targetSelector: null,
    placement: 'center',
    shortcut: '#',
  },
  {
    id: 'graph',
    title: 'Your knowledge graph',
    body: 'Every wikilink becomes a graph edge. Open the Graph view to see your notes as a living map - filter by tag, scrub through time, or let AI name your clusters.',
    targetSelector: 'a[href="/graph"], [data-tour="graph-link"]',
    placement: 'right',
  },
  {
    id: 'ai',
    title: 'Privacy-first AI assistant',
    body: 'The AI assistant is off by default. Enable it in Settings and choose: local model (fully private), bring-your-own-key (direct to provider), or keep it off. Note content never leaves your device unless you choose a cloud provider.',
    targetSelector: '[data-tour="assistant-button"]',
    placement: 'top',
  },
  {
    id: 'backups',
    title: 'Version history & backups',
    body: 'GraphVault snapshots every note automatically as you edit. Open the Command Palette and search "backup" to browse and restore any previous version.',
    targetSelector: null,
    placement: 'center',
    shortcut: 'Cmd K → "backup"',
  },
];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function getTargetRect(selector: string): TargetRect | null {
  try {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  } catch {
    return null;
  }
}

const SPOTLIGHT_PAD = 12; // padding around the target element (px)
const CARD_WIDTH = 320; // coachmark card width (px)
const CARD_HEIGHT_EST = 170; // estimated card height for placement calc (px)

function computeCardPosition(
  rect: TargetRect,
  placement: TourStep['placement'],
  vw: number,
  vh: number,
): { top: number; left: number } {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  let top: number;
  let left: number;

  switch (placement) {
    case 'right':
      top = cy - CARD_HEIGHT_EST / 2;
      left = rect.left + rect.width + SPOTLIGHT_PAD + 8;
      break;
    case 'left':
      top = cy - CARD_HEIGHT_EST / 2;
      left = rect.left - CARD_WIDTH - SPOTLIGHT_PAD - 8;
      break;
    case 'bottom':
      top = rect.top + rect.height + SPOTLIGHT_PAD + 8;
      left = cx - CARD_WIDTH / 2;
      break;
    case 'top':
    default:
      top = rect.top - CARD_HEIGHT_EST - SPOTLIGHT_PAD - 8;
      left = cx - CARD_WIDTH / 2;
      break;
  }

  // Clamp within viewport with margin
  left = Math.max(8, Math.min(left, vw - CARD_WIDTH - 8));
  top = Math.max(8, Math.min(top, vh - CARD_HEIGHT_EST - 8));

  return { top, left };
}

// ---------------------------------------------------------------------------
// Focus trap hook
// ---------------------------------------------------------------------------

function useFocusTrap(containerRef: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !containerRef.current) return;
    const container = containerRef.current;

    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null);

    if (focusable.length > 0) {
      focusable[0].focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const all = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (all.length === 0) return;
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, containerRef]);
}

// ---------------------------------------------------------------------------
// Tour component
// ---------------------------------------------------------------------------

export function Tour() {
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const totalSteps = TOUR_STEPS.length;
  const current = TOUR_STEPS[stepIndex];

  // Show on first run (after vault seeds so the sidebar is rendered).
  useEffect(() => {
    try {
      if (window.localStorage.getItem(TOUR_DISMISSED_KEY) === '1') return;
    } catch {
      return;
    }
    const id = setTimeout(() => setOpen(true), 1400);
    return () => clearTimeout(id);
  }, []);

  // Re-open when the custom event fires (e.g. "Replay tour" in CommandPalette).
  useEffect(() => {
    const handler = () => {
      setStepIndex(0);
      setOpen(true);
    };
    window.addEventListener(TOUR_OPEN_EVENT, handler);
    return () => window.removeEventListener(TOUR_OPEN_EVENT, handler);
  }, []);

  // Resolve the target element rect whenever the step changes or tour opens.
  useLayoutEffect(() => {
    if (!open) return;
    const selector = current.targetSelector;
    if (!selector) {
      setTargetRect(null);
      return;
    }
    setTargetRect(getTargetRect(selector));
  }, [open, stepIndex, current.targetSelector]);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(TOUR_DISMISSED_KEY, '1');
    } catch {
      /* ignore */
    }
    setOpen(false);
  }, []);

  const goNext = useCallback(() => {
    if (stepIndex < totalSteps - 1) {
      setStepIndex((i) => i + 1);
    } else {
      dismiss();
    }
  }, [stepIndex, totalSteps, dismiss]);

  const goPrev = useCallback(() => {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  }, [stepIndex]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismiss();
      } else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.shiftKey)) {
        goNext();
      } else if (e.key === 'ArrowLeft') {
        goPrev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, goNext, goPrev, dismiss]);

  useFocusTrap(cardRef, open);

  if (!open) return null;

  const isCenter = current.placement === 'center' || !targetRect;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;

  const cardPos =
    !isCenter && targetRect ? computeCardPosition(targetRect, current.placement, vw, vh) : null;

  // Spotlight geometry (target area + padding)
  const spotlight =
    targetRect && !isCenter
      ? {
          top: targetRect.top - SPOTLIGHT_PAD,
          left: targetRect.left - SPOTLIGHT_PAD,
          width: targetRect.width + SPOTLIGHT_PAD * 2,
          height: targetRect.height + SPOTLIGHT_PAD * 2,
        }
      : null;

  // Mask cutout: transparent at the target, black elsewhere.
  const maskValue = spotlight
    ? [
        `radial-gradient(`,
        `  ${spotlight.width}px ${spotlight.height}px at`,
        `  ${spotlight.left + spotlight.width / 2}px`,
        `  ${spotlight.top + spotlight.height / 2}px,`,
        `  transparent 90%, black 100%`,
        `)`,
      ].join(' ')
    : undefined;

  return (
    <>
      {/* Dim overlay (with optional spotlight cutout) */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-[60] bg-neutral-950/75 backdrop-blur-[1.5px]"
        style={maskValue ? { mask: maskValue, WebkitMask: maskValue } : {}}
      />

      {/* Spotlight ring border */}
      {spotlight && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[61] rounded-xl ring-2 ring-accent-400/60 motion-safe:animate-pulse"
          style={{
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
          }}
        />
      )}

      {/* Coachmark card */}
      {isCenter ? (
        <div className="fixed inset-0 z-[62] flex items-center justify-center p-4">
          <CoachmarkCard
            ref={cardRef}
            step={current}
            stepIndex={stepIndex}
            totalSteps={totalSteps}
            onPrev={goPrev}
            onNext={goNext}
            onDismiss={dismiss}
          />
        </div>
      ) : (
        <div
          className="fixed z-[62]"
          style={{ top: cardPos!.top, left: cardPos!.left, width: CARD_WIDTH }}
        >
          <CoachmarkCard
            ref={cardRef}
            step={current}
            stepIndex={stepIndex}
            totalSteps={totalSteps}
            onPrev={goPrev}
            onNext={goNext}
            onDismiss={dismiss}
          />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Coachmark card
// ---------------------------------------------------------------------------

interface CoachmarkCardProps {
  step: TourStep;
  stepIndex: number;
  totalSteps: number;
  onPrev: () => void;
  onNext: () => void;
  onDismiss: () => void;
}

const CoachmarkCard = forwardRef<HTMLDivElement, CoachmarkCardProps>(function CoachmarkCard(
  { step, stepIndex, totalSteps, onPrev, onNext, onDismiss },
  ref,
) {
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === totalSteps - 1;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={`Tour step ${stepIndex + 1} of ${totalSteps}: ${step.title}`}
      aria-live="polite"
      className="w-full max-w-sm rounded-xl border border-neutral-700/60 bg-neutral-900/98 shadow-2xl shadow-black/70 ring-1 ring-white/5 backdrop-blur-sm motion-safe:animate-onboarding-in"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <InfoIcon />
          <span className="text-xs font-semibold uppercase tracking-wide text-accent-400">
            Tour {stepIndex + 1} / {totalSteps}
          </span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close tour"
          className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-300 focus-visible:ring-1 focus-visible:ring-accent-500"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Body */}
      <div className="px-4 py-4">
        <h2 className="mb-1.5 text-sm font-semibold text-neutral-100">{step.title}</h2>
        <p className="text-xs leading-relaxed text-neutral-400">{step.body}</p>

        {step.shortcut && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-neutral-600">Try it:</span>
            <kbd className="inline-block rounded border border-neutral-700 bg-neutral-800 px-2 py-0.5 font-mono text-[11px] font-medium text-neutral-300">
              {step.shortcut}
            </kbd>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-3">
        {/* Progress dots */}
        <div className="flex items-center gap-1.5" aria-hidden="true">
          {Array.from({ length: totalSteps }, (_, i) => (
            <div
              key={i}
              className={[
                'h-1.5 rounded-full transition-all duration-200',
                i === stepIndex
                  ? 'w-4 bg-accent-400'
                  : i < stepIndex
                    ? 'w-1.5 bg-accent-700'
                    : 'w-1.5 bg-neutral-700',
              ].join(' ')}
            />
          ))}
        </div>

        {/* Navigation */}
        <div className="flex items-center gap-2">
          {!isFirst && (
            <button
              type="button"
              onClick={onPrev}
              className="rounded-md px-2.5 py-1.5 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-300 focus-visible:ring-1 focus-visible:ring-accent-500"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={onNext}
            className="rounded-md bg-accent-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-500 focus-visible:ring-1 focus-visible:ring-accent-400 focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-900"
          >
            {isLast ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function InfoIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-3.5 w-3.5 text-accent-400"
      aria-hidden="true"
    >
      <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Z" />
      <path d="M6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
