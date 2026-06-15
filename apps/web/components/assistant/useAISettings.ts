'use client';

/**
 * React hook for AI settings — loads from sessionStorage on mount, exposes a
 * stable `update` callback, and subscribes to cross-component changes via a
 * custom storage event.
 *
 * We use sessionStorage (not localStorage) for the raw key — it is cleared
 * automatically when the tab closes, giving a sensible default privacy posture.
 */

import { useCallback, useEffect, useState } from 'react';

import { loadAISettings, saveAISettings } from '../../lib/ai/settings';
import { DEFAULT_AI_SETTINGS, type AISettings } from '../../lib/ai/types';

const STORAGE_EVENT = 'graphvault:ai-settings-changed';

export function useAISettings() {
  const [settings, setSettings] = useState<AISettings>(() => {
    // SSR-safe: return defaults during server render; actual values load in effect.
    if (typeof window === 'undefined') return { ...DEFAULT_AI_SETTINGS };
    return loadAISettings();
  });

  // Re-read on mount (handles SSR mismatch) and on cross-component change events.
  useEffect(() => {
    setSettings(loadAISettings());

    const onEvent = () => setSettings(loadAISettings());
    window.addEventListener(STORAGE_EVENT, onEvent);
    return () => window.removeEventListener(STORAGE_EVENT, onEvent);
  }, []);

  const update = useCallback((patch: Partial<AISettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveAISettings(next);
      // Notify other mounted components (e.g. the settings page and the panel
      // may both be mounted at the same time on wider viewports).
      window.dispatchEvent(new Event(STORAGE_EVENT));
      return next;
    });
  }, []);

  return { settings, update } as const;
}
