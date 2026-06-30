'use client';

/**
 * Resolve the app's neutral colour ramp (the `--n-*` CSS variables defined in
 * `globals.css`) into concrete colours for canvas drawing, and re-resolve when
 * the theme flips.
 *
 * The graph canvas draws to a `<canvas>` with the 2D API, which cannot consume
 * CSS variables directly - it needs literal colour strings. Previously these
 * were hard-coded to the dark ramp (`#0a0a0a`, `#d4d4d8`, …), so in light theme
 * the canvas rendered as a black rectangle. This hook reads the live computed
 * values from `document.documentElement` and watches the `data-theme` attribute
 * (toggled by ThemeProvider) so the colours follow the active theme.
 *
 * SSR-safe: returns the dark-theme defaults during SSR / first paint, matching
 * the no-flash boot default, then updates after mount.
 */

import { useEffect, useState } from 'react';

export interface GraphThemeColors {
  /** Page/canvas background (`--n-950`). */
  background: string;
  /** Placeholder node fill - same as background so the disc reads as hollow. */
  placeholderFill: string;
  /** Primary label text (`--n-300`). */
  labelText: string;
  /** Dimmed label text (`--n-600`). */
  labelDimmed: string;
  /** Placeholder label text (`--n-400`). */
  labelPlaceholder: string;
  /** Label halo (background colour at 0.85 alpha). */
  labelHalo: string;
  /**
   * Brand accent (`--accent-400`) as a hex string. The default "note" colour and
   * selection ring derive from this so the graph reads as on-brand cyan in both
   * themes. Falls back to the dark accent if the token is unreadable.
   */
  accent: string;
  /** Brighter accent (`--accent-300`) for the resting hub glow / focus ring. */
  accentBright: string;
  /**
   * Edge base colour as an `{ r, g, b }` triple (theme-aware neutral). The
   * canvas draws edges at varying alpha over this triple so connections read
   * clearly on both the near-black dark page and the off-white light page
   * without hard-coding a single grey that washes out on one of them.
   */
  edge: { r: number; g: number; b: number };
}

/** Dark-theme defaults - used during SSR and as a fallback. */
const DARK_DEFAULTS: GraphThemeColors = {
  background: '#0a0a0a',
  placeholderFill: '#0a0a0a',
  labelText: '#d4d4d8',
  labelDimmed: '#52525b',
  labelPlaceholder: '#9ca3af',
  labelHalo: 'rgba(10,10,10,0.85)',
  accent: '#1fafc6',
  accentBright: '#5bcfe2',
  // Cool slate edges read cleanly over the near-black dark page.
  edge: { r: 148, g: 163, b: 184 },
};

/**
 * Read a `--n-*` variable (stored as a `"R G B"` triple) from the document root.
 * Returns `null` if unavailable/unparseable so the caller can fall back.
 */
function readTriple(style: CSSStyleDeclaration, name: string): [number, number, number] | null {
  const raw = style.getPropertyValue(name).trim();
  if (!raw) return null;
  const parts = raw.split(/[\s,]+/).map((p) => Number(p));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0], parts[1], parts[2]];
}

function toHex([r, g, b]: [number, number, number]): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function resolve(): GraphThemeColors {
  if (typeof window === 'undefined' || typeof document === 'undefined') return DARK_DEFAULTS;
  const style = getComputedStyle(document.documentElement);
  const n950 = readTriple(style, '--n-950');
  const n300 = readTriple(style, '--n-300');
  const n400 = readTriple(style, '--n-400');
  const n600 = readTriple(style, '--n-600');
  const accent400 = readTriple(style, '--accent-400');
  const accent300 = readTriple(style, '--accent-300');
  if (!n950) return DARK_DEFAULTS;

  // Edge tint follows the page: on a dark page (low background luminance) use a
  // cool light slate; on a light page use a mid slate so lines stay visible.
  const bgLum = (n950[0] * 299 + n950[1] * 587 + n950[2] * 114) / 1000;
  const edge = bgLum < 128 ? { r: 148, g: 163, b: 184 } : { r: 100, g: 116, b: 139 };

  return {
    background: toHex(n950),
    placeholderFill: toHex(n950),
    labelText: n300 ? toHex(n300) : DARK_DEFAULTS.labelText,
    labelDimmed: n600 ? toHex(n600) : DARK_DEFAULTS.labelDimmed,
    labelPlaceholder: n400 ? toHex(n400) : DARK_DEFAULTS.labelPlaceholder,
    labelHalo: `rgba(${n950[0]},${n950[1]},${n950[2]},0.85)`,
    accent: accent400 ? toHex(accent400) : DARK_DEFAULTS.accent,
    accentBright: accent300 ? toHex(accent300) : DARK_DEFAULTS.accentBright,
    edge,
  };
}

export function useGraphThemeColors(): GraphThemeColors {
  const [colors, setColors] = useState<GraphThemeColors>(DARK_DEFAULTS);

  useEffect(() => {
    setColors(resolve());
    const root = document.documentElement;
    const observer = new MutationObserver(() => setColors(resolve()));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return colors;
}
