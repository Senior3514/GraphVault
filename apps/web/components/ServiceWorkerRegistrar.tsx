'use client';

/**
 * ServiceWorkerRegistrar
 *
 * Registers /sw.js on mount. The SW is served from the same origin as the
 * app, so this stays within the `default-src 'self'` / `script-src 'self'`
 * CSP. Renders no DOM - purely a side-effect component.
 *
 * Registration is skipped silently when:
 *  - The browser does not support service workers (e.g. non-HTTPS, old browsers).
 *  - The component mounts during SSR (window/navigator not available).
 */

import { useEffect } from 'react';

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    // Only register over secure contexts (HTTPS or localhost).
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      // Non-fatal - app works without the SW, just no offline support.
      console.warn('[GraphVault] SW registration failed:', err);
    });
  }, []);

  return null;
}
