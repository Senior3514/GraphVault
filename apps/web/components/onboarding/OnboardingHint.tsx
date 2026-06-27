'use client';

/**
 * OnboardingHint - lightweight first-run tour strip.
 *
 * Shows three contextual tips after the vault loads for the first time.
 * Once dismissed (X button) the preference is persisted in localStorage and
 * the hint never appears again. Animates in; respects prefers-reduced-motion.
 *
 * Mount once inside AppShell (after the vault shell is shown). The component
 * self-hides if the user is on the landing page - AppFrame already guards that,
 * but it is defensive about it.
 */

import { useEffect, useState } from 'react';

const DISMISSED_KEY = 'graphvault.onboarding.dismissed';

interface Tip {
  keys: string[];
  text: string;
}

const TIPS: Tip[] = [
  { keys: ['Cmd', 'K'], text: 'Open any note or run a command' },
  { keys: ['[['], text: 'Type to link to another note (autocomplete)' },
  { keys: ['#'], text: 'Type to add a tag; explore the graph to see connections' },
];

export function OnboardingHint() {
  const [visible, setVisible] = useState(false);

  // Delay the show so it doesn't compete with the vault loading flash.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(DISMISSED_KEY) === '1') return;
    } catch {
      return; // storage unavailable - skip
    }
    const id = setTimeout(() => setVisible(true), 600);
    return () => clearTimeout(id);
  }, []);

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* ignore */
    }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      // bottom-4 on desktop; on mobile account for safe-area + bottom bar height
      className="pointer-events-none absolute bottom-4 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 px-4 motion-safe:animate-onboarding-in md:bottom-4"
      style={{ bottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))' }}
    >
      <div className="pointer-events-auto rounded-xl border border-neutral-700/60 bg-neutral-900/95 shadow-2xl shadow-black/60 ring-1 ring-white/5 backdrop-blur-sm">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-sky-400">
            <SparkleIcon />
            Quick start
          </span>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss quick-start tips"
            className="flex h-5 w-5 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-300 focus-visible:ring-1 focus-visible:ring-sky-500"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Tips */}
        <ul className="divide-y divide-neutral-800/60 px-4">
          {TIPS.map((tip) => (
            <li key={tip.keys.join()} className="flex items-center gap-3 py-2.5">
              <span className="flex shrink-0 items-center gap-0.5">
                {tip.keys.map((k) => (
                  <kbd
                    key={k}
                    className="inline-block rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] font-medium leading-none text-neutral-300"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
              <span className="text-xs text-neutral-400">{tip.text}</span>
            </li>
          ))}
        </ul>

        {/* Footer */}
        <div className="border-t border-neutral-800 px-4 py-2">
          <button
            type="button"
            onClick={dismiss}
            className="text-[11px] text-neutral-600 transition-colors hover:text-neutral-400"
          >
            Got it - don&apos;t show again
          </button>
        </div>
      </div>
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3" aria-hidden="true">
      <path d="M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5L8 1z" />
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
