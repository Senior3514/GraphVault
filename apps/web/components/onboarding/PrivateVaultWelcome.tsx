'use client';

/**
 * PrivateVaultWelcome - a one-time, first-entry framing shown the FIRST time a
 * user crosses from the public landing page into their private workspace.
 *
 * Why it exists: user feedback was "it's unclear what separates the public
 * landing page from a user's own private notebook." This card makes the
 * transition explicit and reassuring: the vault lives only on this device, no
 * account, no one else can see it. It is the conceptual counterpart to the
 * landing page's "this page is public; your vault is private" cue.
 *
 * Behaviour:
 *  - Shows once, then never again (persisted in localStorage). Dismissible by
 *    button, Escape, backdrop click, or the primary "Start writing" action.
 *  - Centered modal with a focus trap + restore, labelled for screen readers.
 *  - Entrance animation gated behind `motion-safe:`; reduced-motion users get
 *    an instant, non-animated card.
 *  - Re-openable via the `graphvault.privateWelcome.open` custom event (e.g.
 *    from the command palette) without resetting the "seen" flag.
 *
 * Mount once inside the app shell (AppFrame), NOT on the landing page.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useFocusTrap } from '../../lib/a11y/useFocusTrap';

const SEEN_KEY = 'graphvault.privateWelcome.seen';
export const OPEN_PRIVATE_WELCOME_EVENT = 'graphvault.privateWelcome.open';

export function PrivateVaultWelcome() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // First-run auto-open. Delayed slightly so it doesn't collide with the
  // vault's initial load flash. Skipped entirely if already seen or if storage
  // is unavailable (defensive - never block the app).
  useEffect(() => {
    let seen = true;
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === '1';
    } catch {
      return;
    }
    if (seen) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const id = setTimeout(() => setOpen(true), 450);
    return () => clearTimeout(id);
  }, []);

  // Allow re-opening on demand without clearing the seen flag.
  useEffect(() => {
    const reopen = () => {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    window.addEventListener(OPEN_PRIVATE_WELCOME_EVENT, reopen);
    return () => window.removeEventListener(OPEN_PRIVATE_WELCOME_EVENT, reopen);
  }, []);

  const close = useCallback(() => {
    try {
      window.localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* ignore persistence failures */
    }
    setOpen(false);
    requestAnimationFrame(() => restoreFocusRef.current?.focus?.());
  }, []);

  useFocusTrap(dialogRef, open, restoreFocusRef);

  // Escape + backdrop close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" role="presentation">
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={close}
        className="absolute inset-0 bg-neutral-950/80 backdrop-blur-sm motion-safe:animate-fade-in"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="private-welcome-title"
        aria-describedby="private-welcome-desc"
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-elevation-xl ring-1 ring-white/[0.06] motion-safe:animate-onboarding-in"
      >
        {/* Accent glow header */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-[radial-gradient(30rem_10rem_at_50%_-40%,theme(colors.accent.500/30),transparent)]"
        />

        <div className="relative px-6 pb-6 pt-7 text-center">
          {/* Shield/lock badge */}
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-accent-400/30 bg-accent-500/12 text-accent-300">
            <ShieldLockIcon />
          </div>

          <p className="mt-4 text-xs font-semibold uppercase tracking-widest text-accent-400">
            Your private vault
          </p>
          <h2
            id="private-welcome-title"
            className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-neutral-50"
          >
            This space is yours alone.
          </h2>
          <p id="private-welcome-desc" className="mt-3 text-sm leading-relaxed text-neutral-400">
            You&apos;ve just left the public product page. Everything from here lives{' '}
            <span className="font-medium text-neutral-200">only on this device</span> - no account,
            no upload, no one else can see it. Sync is optional and self-hosted, and you turn it on
            yourself.
          </p>

          {/* Three reassurance chips */}
          <ul className="mt-5 grid grid-cols-3 gap-2 text-[11px]">
            <ReassureChip icon={<DeviceIcon />} label="On this device" />
            <ReassureChip icon={<NoAccountIcon />} label="No account" />
            <ReassureChip icon={<OfflineIcon />} label="Works offline" />
          </ul>

          <button
            type="button"
            onClick={close}
            className="mt-6 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-accent-500 px-5 py-2.5 font-semibold text-accent-fg shadow-md shadow-accent-500/25 transition-all duration-150 ease-out hover:-translate-y-px hover:bg-accent-400 active:translate-y-0 focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          >
            Start writing
            <ArrowRightIcon />
          </button>
          <button
            type="button"
            onClick={close}
            className="mt-2 text-[11px] text-neutral-600 transition-colors hover:text-neutral-400"
          >
            Got it - don&apos;t show this again
          </button>
        </div>
      </div>
    </div>
  );
}

function ReassureChip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <li className="flex flex-col items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-950/50 px-2 py-2.5 text-neutral-400">
      <span className="text-accent-300/90" aria-hidden="true">
        {icon}
      </span>
      <span className="font-medium">{label}</span>
    </li>
  );
}

function ShieldLockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
      <path
        d="M12 3l7 2.5v5c0 4.5-3 8.2-7 9.5-4-1.3-7-5-7-9.5v-5L12 3z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 11.5v-1a2.5 2.5 0 015 0v1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <rect x="8.5" y="11.5" width="7" height="5" rx="1" fill="currentColor" opacity="0.9" />
    </svg>
  );
}

function DeviceIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <rect x="3" y="4" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 16h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function NoAccountIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M4.5 16a5.5 5.5 0 0111 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function OfflineIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <path
        d="M3 8.5a9 9 0 0114 0M6 11.5a5 5 0 018 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="10" cy="15" r="1" fill="currentColor" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M4 10h12M12 6l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
