'use client';

/**
 * ThemeProvider — owns the theme *mode* (`light | dark | system`), persists it,
 * and keeps the document's `data-theme` in sync with the resolved theme.
 *
 * The no-flash inline boot script (see `lib/themeScript.ts`) has already set
 * `data-theme` before this mounts, so there is no flash; this provider takes
 * over reactive updates (toggle clicks, live OS-preference changes on `system`).
 *
 * SSR-safe: the initial render uses the default mode so server and client markup
 * agree; the persisted mode is read after mount. `data-theme` lives on <html>
 * (set imperatively), never in React's tree, so it cannot cause a hydration
 * mismatch.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  applyTheme,
  DEFAULT_THEME_MODE,
  loadThemeMode,
  resolveTheme,
  saveThemeMode,
  systemPrefersDark,
  type ResolvedTheme,
  type ThemeMode,
} from '../lib/theme';

interface ThemeContextValue {
  /** The user-chosen mode. */
  mode: ThemeMode;
  /** The concrete theme currently applied (after resolving `system`). */
  resolved: ResolvedTheme;
  /** Choose a mode (persists + applies immediately). */
  setMode(mode: ThemeMode): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Start from the default so SSR and the first client render agree; the
  // persisted mode is loaded in the effect below.
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_THEME_MODE);
  const [prefersDark, setPrefersDark] = useState<boolean>(true);

  // Hydrate persisted mode + current OS preference once on mount.
  useEffect(() => {
    setModeState(loadThemeMode());
    setPrefersDark(systemPrefersDark());
  }, []);

  // When on `system`, follow live OS-preference changes.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const resolved = resolveTheme(mode, prefersDark);

  // Keep the document attribute in sync with the resolved theme.
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    saveThemeMode(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Access the current theme + setter. Must be used within {@link ThemeProvider}. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
