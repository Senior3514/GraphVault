/**
 * Theme model for light/dark theming via CSS-variable design tokens.
 *
 * The user picks a *mode* (`light | dark | system`); the *resolved* theme is the
 * concrete `light | dark` value actually applied to the document. `system`
 * follows the OS `prefers-color-scheme` at runtime.
 *
 * Everything here is pure or SSR-guarded so it is safe to import from both the
 * no-flash inline boot script (via the serialised constants below) and the
 * React provider.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/** The persisted localStorage key. Kept in lockstep with the inline boot script. */
export const THEME_STORAGE_KEY = 'gv-theme';

/** The default mode when nothing is persisted: follow the OS preference. */
export const DEFAULT_THEME_MODE: ThemeMode = 'system';

const MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** Type guard for a value read back from storage (which may be anything). */
export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/**
 * Resolve a mode + the current system preference into a concrete theme.
 * Pure - the single source of truth for the `system` mapping. Unit-tested.
 */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return systemPrefersDark ? 'dark' : 'light';
}

/**
 * Read the persisted mode. SSR-safe: returns {@link DEFAULT_THEME_MODE} when
 * `window`/`localStorage` are unavailable or the stored value is invalid.
 */
export function loadThemeMode(): ThemeMode {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return DEFAULT_THEME_MODE;
  }
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

/** Persist the chosen mode. Silently ignores errors (private mode, quota). */
export function saveThemeMode(mode: ThemeMode): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* ignore persistence failures */
  }
}

/**
 * Whether the OS currently prefers a dark scheme. SSR-safe (returns `true`,
 * matching our dark-first default, when `matchMedia` is unavailable).
 */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Apply a resolved theme to the document root (sets `data-theme`). */
export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
}
