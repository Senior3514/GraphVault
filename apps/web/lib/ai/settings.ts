/**
 * Persistence helpers for AISettings.
 *
 * Storage strategy — sessionStorage (not localStorage):
 *  - Settings are cleared automatically when the tab or browser closes.
 *  - No API keys are stored here. For `server` mode the key lives on the GV
 *    server, encrypted at rest. For `local` mode no key is needed (Ollama / any
 *    local OpenAI-compat endpoint). The `off` mode stores nothing sensitive.
 *  - The setting "kind" (off/local/server) and non-secret fields are also kept
 *    in sessionStorage so they reset each session — a deliberate conservative
 *    choice that keeps the user in control.
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
    // Strip any legacy `byok` fields that may exist in old persisted data and
    // map the legacy 'byok' kind to 'off' — the client-side key path no longer
    // exists; the user must configure the server mode instead.
    const cleaned: Partial<AISettings> = {};
    if (parsed.kind !== undefined) cleaned.kind = parsed.kind;
    if (parsed.localEndpoint !== undefined) cleaned.localEndpoint = parsed.localEndpoint;
    if (parsed.localModel !== undefined) cleaned.localModel = parsed.localModel;
    if (parsed.serverModel !== undefined) cleaned.serverModel = parsed.serverModel;
    if ((cleaned.kind as string) === 'byok') {
      cleaned.kind = 'off';
    }
    return { ...DEFAULT_AI_SETTINGS, ...cleaned };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

/**
 * Persist AI settings to sessionStorage.
 * No API keys are stored here — there are none in the settings shape.
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
