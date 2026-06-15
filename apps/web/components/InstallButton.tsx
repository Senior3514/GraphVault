'use client';

/**
 * InstallButton
 *
 * Listens for the browser's `beforeinstallprompt` event (Chrome/Edge desktop
 * and Android) and surfaces an "Install app" button that triggers the native
 * install dialog when clicked.
 *
 * Behaviour by platform:
 *  - Chrome/Edge desktop & Android: shows an "Install app" button; on click,
 *    triggers the native install prompt.
 *  - Already installed (standalone mode): renders nothing — the install button
 *    would be confusing in a standalone window.
 *  - Safari/Firefox (no beforeinstallprompt): shows a short hint directing the
 *    user to their browser's "Add to Home Screen" or "Install" menu option.
 *
 * CSP: all logic is same-origin, no external fetches. The `beforeinstallprompt`
 * event is a browser-native API; no script injection occurs.
 */

import { useEffect, useState } from 'react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type InstallState = 'waiting' | 'available' | 'installed' | 'unsupported';

export function InstallButton() {
  const [state, setState] = useState<InstallState>('waiting');
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // Already running as a standalone PWA — hide the install affordance.
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setState('installed');
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setState('available');
    };

    window.addEventListener('beforeinstallprompt', handler);

    // appinstalled fires after the user accepts the prompt.
    const installedHandler = () => {
      setState('installed');
      setDeferredPrompt(null);
    };
    window.addEventListener('appinstalled', installedHandler);

    // If no beforeinstallprompt fires within a short window, the browser
    // doesn't support programmatic install (Safari, Firefox).
    const timer = setTimeout(() => {
      setState((prev) => (prev === 'waiting' ? 'unsupported' : prev));
    }, 800);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', installedHandler);
      clearTimeout(timer);
    };
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setState('installed');
      setDeferredPrompt(null);
    }
  };

  if (state === 'installed' || state === 'waiting') return null;

  if (state === 'available') {
    return (
      <button
        onClick={handleInstall}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-5 py-2.5 font-medium text-sky-300 transition-all hover:border-sky-500/60 hover:bg-sky-500/15 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
        type="button"
      >
        <DownloadIcon className="h-4 w-4" />
        Install app
      </button>
    );
  }

  // unsupported — Safari / Firefox — show a hint instead
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
