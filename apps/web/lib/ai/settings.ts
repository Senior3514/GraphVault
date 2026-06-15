/**
 * Persistence helpers for AISettings.
 *
 * Storage strategy — sessionStorage (not localStorage):
 *  - Keys are cleared automatically when the tab or browser closes.
 *  - Prevents the raw API key from persisting to disk in a browser profile
 *    that could be read by another process or synced to a cloud browser account.
 *  - The setting "kind" (off/local/byok) and non-secret fields are also kept in
 *    sessionStorage so they reset each session — a deliberate conservative choice
 *    that keeps the user in control and prevents silent background activation.
 *
 * This module is pure (no React) and can be used from both client components
 * and lib/ utility code. It is client-only (accesses sessionStorage).
 */

import { DEFAULT_AI_SETTINGS, type AISettings } from './types';

const SS_KEY = 'graphvault.ai.settings';

/**
 * Load AI settings from sessionStorage, returning the default (off) settings
 * if none are stored or if parsing fails. Never throws.
 */
export function loadAISettings(): AISettings {
  if (typeof window === 'undefined') return { ...DEFAULT_AI_SETTINGS };
  try {
    const raw = window.sessionStorage.getItem(SS_KEY);
    if (!raw) return { ...DEFAULT_AI_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AISettings>;
    return { ...DEFAULT_AI_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

/**
 * Persist AI settings to sessionStorage. The raw key is stored as-is
 * (sessionStorage is local to the browser tab; cleared on close).
 * Never throws.
 */
export function saveAISettings(settings: AISettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SS_KEY, JSON.stringify(settings));
  } catch {
    /* sessionStorage unavailable (private mode quota) — silently skip */
  }
}

/** Clear all AI settings from sessionStorage (e.g. on sign-out or explicit reset). */
export function clearAISettings(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SS_KEY);
  } catch {
    /* ignore */
  }
}
