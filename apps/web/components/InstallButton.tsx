'use client';

/**
 * InstallButton — platform-aware "Get the app" affordance.
 *
 * The decision of *what* to show is delegated to the pure, unit-tested
 * `lib/pwa/install.ts` helpers; this component only wires the live browser
 * values (user-agent, `matchMedia`, the `beforeinstallprompt` event) into them
 * and renders the result.
 *
 * Behaviour by platform (see {@link chooseInstallAffordance}):
 *  - Chromium desktop / Android / Edge: capture `beforeinstallprompt`, show an
 *    "Install app" button that triggers the native install dialog on click.
 *  - iOS Safari (no `beforeinstallprompt`): show a concise, dismissible
 *    "Add to Home Screen" hint (Share → Add to Home Screen) — the only path.
 *  - Already installed / `display-mode: standalone`: render nothing.
 *  - Other browsers (Firefox, desktop Safari): point at the browser menu.
 *
 * Accessibility: the button and hint are focusable, labelled, and the iOS hint
 * is dismissible. All motion is gated behind `motion-safe:`.
 *
 * CSP / privacy: same-origin only, no external fetches, no telemetry. The
 * `beforeinstallprompt` API is browser-native; nothing is injected.
 */

import { useEffect, useRef, useState } from 'react';

import {
  chooseInstallAffordance,
  detectIosFromNavigator,
  isStandalone,
  type InstallAffordance,
} from '../lib/pwa/install';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export function InstallButton() {
  // `null` until the first effect runs, so SSR and the pre-hydration render
  // both produce nothing (avoids a hydration mismatch / layout flash).
  const [affordance, setAffordance] = useState<InstallAffordance | null>(null);
  const [iosHintDismissed, setIosHintDismissed] = useState(false);
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const standalone = isStandalone({
      displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
      displayModeFullscreen: window.matchMedia('(display-mode: fullscreen)').matches,
      displayModeMinimalUi: window.matchMedia('(display-mode: minimal-ui)').matches,
      // iOS-only legacy flag for "added to Home Screen".
      iosStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
    });

    const recompute = (hasPromptEvent: boolean) => {
      const userAgent = detectIosFromNavigator({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
        platform: navigator.platform,
      })
        ? // Normalise iPadOS-desktop-UA so the pure helper treats it as iOS.
          `${navigator.userAgent} iPhone`
        : navigator.userAgent;
      setAffordance(chooseInstallAffordance({ userAgent, standalone, hasPromptEvent }));
    };

    // Initial decision (no prompt event captured yet).
    recompute(false);

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      deferredPrompt.current = e as BeforeInstallPromptEvent;
      recompute(true);
    };
    const onAppInstalled = () => {
      deferredPrompt.current = null;
      setAffordance('none');
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const handleInstall = async () => {
    const prompt = deferredPrompt.current;
    if (!prompt) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') {
      deferredPrompt.current = null;
      setAffordance('none');
    }
  };

  if (affordance === null || affordance === 'none') return null;

  if (affordance === 'prompt') {
    return (
      <button
        onClick={handleInstall}
        type="button"
        className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-5 py-2.5 font-medium text-sky-300 transition-all hover:border-sky-500/60 hover:bg-sky-500/15 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
      >
        <DownloadIcon className="h-4 w-4" />
        Install app
      </button>
    );
  }

  if (affordance === 'ios-hint') {
    if (iosHintDismissed) return null;
    return (
      <div
        role="note"
        aria-label="How to install on iPhone or iPad"
        className="inline-flex max-w-xs items-start gap-2.5 rounded-lg border border-neutral-800 bg-neutral-900/70 px-3.5 py-2.5 text-xs text-neutral-300"
      >
        <ShareIcon className="mt-px h-4 w-4 shrink-0 text-sky-400" />
        <span className="leading-relaxed">
          To install: tap <span className="font-semibold text-neutral-100">Share</span>, then{' '}
          <span className="font-semibold text-neutral-100">Add to Home Screen</span>.
        </span>
        <button
          type="button"
          onClick={() => setIosHintDismissed(true)}
          aria-label="Dismiss install hint"
          className="-mr-1 -mt-1 ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // manual-hint — Firefox / desktop Safari / Chrome-on-iOS.
  return (
    <p className="mt-2 text-xs text-neutral-600">
      Install from your browser menu &rarr; &ldquo;Add to Home Screen&rdquo; / &ldquo;Install&rdquo;
    </p>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
      aria-hidden="true"
    >
      <path d="M10 3v9M6 8l4 4 4-4M4 15h12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShareIcon({ className }: { className?: string }) {
  // iOS Share glyph — an upward arrow out of a box.
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M10 2.5v9m0-9L7 5.5m3-3 3 3M5 9.5v6a1 1 0 001 1h8a1 1 0 001-1v-6"
      />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
      aria-hidden="true"
    >
      <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
    </svg>
  );
}
