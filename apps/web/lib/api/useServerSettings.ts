'use client';

/**
 * Persisted server-connection settings (just the base URL for now).
 *
 * Defaults to `NEXT_PUBLIC_GRAPHVAULT_SERVER_URL`; the user can override it from
 * the Settings page. Stored in `localStorage` so it survives reloads.
 */

import { useCallback, useEffect, useState } from 'react';

import { DEFAULT_SERVER_URL } from './client';
import { SERVER_URL_STORAGE_KEY } from './storageKeys';

const STORAGE_KEY = SERVER_URL_STORAGE_KEY;

// Re-export so existing call sites can import the canonical key from here.
export { SERVER_URL_STORAGE_KEY };

export function useServerSettings() {
  const [serverUrl, setServerUrlState] = useState(DEFAULT_SERVER_URL);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) setServerUrlState(stored);
    } catch {
      /* ignore */
    }
    setLoaded(true);
  }, []);

  const setServerUrl = useCallback((url: string) => {
    const trimmed = url.trim();
    setServerUrlState(trimmed);
    try {
      window.localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      /* ignore quota/availability errors */
    }
  }, []);

  return { serverUrl, setServerUrl, loaded };
}
