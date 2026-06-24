/**
 * Tests for the pure theme helpers (resolveTheme) and the SSR-safe persistence
 * helpers (load/saveThemeMode). These run in Node.js — no DOM, no React — so we
 * stub `globalThis.window` to exercise the localStorage paths (per the wave-3
 * "shim browser APIs via globalThis" lesson), then restore it afterwards.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  DEFAULT_THEME_MODE,
  isThemeMode,
  loadThemeMode,
  resolveTheme,
  saveThemeMode,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from './theme';

// ---- resolveTheme: every mode × system combination -------------------------

describe('resolveTheme', () => {
  it('mode "light" always resolves to light regardless of system', () => {
    assert.equal(resolveTheme('light', true), 'light');
    assert.equal(resolveTheme('light', false), 'light');
  });

  it('mode "dark" always resolves to dark regardless of system', () => {
    assert.equal(resolveTheme('dark', true), 'dark');
    assert.equal(resolveTheme('dark', false), 'dark');
  });

  it('mode "system" follows the system preference', () => {
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
  });
});

// ---- isThemeMode guard -----------------------------------------------------

describe('isThemeMode', () => {
  it('accepts the three valid modes', () => {
    assert.equal(isThemeMode('light'), true);
    assert.equal(isThemeMode('dark'), true);
    assert.equal(isThemeMode('system'), true);
  });

  it('rejects junk values', () => {
    assert.equal(isThemeMode('LIGHT'), false);
    assert.equal(isThemeMode(''), false);
    assert.equal(isThemeMode(null), false);
    assert.equal(isThemeMode(undefined), false);
    assert.equal(isThemeMode(42), false);
  });
});

// ---- persistence helpers ---------------------------------------------------

/** Minimal in-memory localStorage stub. */
function makeStorageStub() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    _map: map,
  };
}

// `window` is a DOM global; in Node it is absent. We set/unset it via an
// `unknown` cast so we never partially re-declare the DOM `Window` interface
// (per the wave-3 lesson). `Reflect.deleteProperty` avoids the `delete`
// operand-must-be-optional TS error on the typed global.
function setWindow(value: unknown): void {
  (globalThis as unknown as Record<string, unknown>).window = value;
}
function clearWindow(): void {
  Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'window');
}

afterEach(() => {
  clearWindow();
});

describe('loadThemeMode / saveThemeMode', () => {
  it('defaults to "system" when nothing is stored', () => {
    setWindow({ localStorage: makeStorageStub() });
    assert.equal(loadThemeMode(), DEFAULT_THEME_MODE);
    assert.equal(loadThemeMode(), 'system');
  });

  it('round-trips each mode through storage', () => {
    const storage = makeStorageStub();
    setWindow({ localStorage: storage });
    for (const mode of ['light', 'dark', 'system'] as ThemeMode[]) {
      saveThemeMode(mode);
      assert.equal(storage.getItem(THEME_STORAGE_KEY), mode);
      assert.equal(loadThemeMode(), mode);
    }
  });

  it('falls back to default when a junk value is persisted', () => {
    const storage = makeStorageStub();
    storage.setItem(THEME_STORAGE_KEY, 'neon');
    setWindow({ localStorage: storage });
    assert.equal(loadThemeMode(), DEFAULT_THEME_MODE);
  });

  it('is SSR-safe: returns the default when window is undefined', () => {
    clearWindow();
    assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');
    assert.equal(loadThemeMode(), DEFAULT_THEME_MODE);
  });

  it('is SSR-safe: saveThemeMode is a no-op when window is undefined', () => {
    clearWindow();
    assert.doesNotThrow(() => saveThemeMode('dark'));
  });

  it('is SSR-safe: load/save tolerate window without localStorage', () => {
    setWindow({});
    assert.equal(loadThemeMode(), DEFAULT_THEME_MODE);
    assert.doesNotThrow(() => saveThemeMode('light'));
  });
});
