/**
 * Self-hosted typography for GraphVault.
 *
 * ZERO external network requests: every face is bundled as a local `.woff2`
 * under `app/fonts/` and loaded via `next/font/local`. This preserves the
 * local-first / zero-telemetry / fully-offline promise - there is NO Google
 * Fonts (or any CDN) fetch at build time or runtime. Verify in the build by
 * confirming the only font requests are to `/_next/static/media/*.woff2`.
 *
 * Type system (three families, wired through Tailwind `fontFamily` tokens):
 *
 *   --font-display  Geist          a refined geometric grotesque used for
 *                                  headings + the wordmark. Characterful at
 *                                  large sizes; tight, confident tracking.
 *   --font-sans     Inter          the workhorse UI/body face. Pairs the
 *                                  existing `cv11`/`ss01`/`cv05` OpenType
 *                                  feature settings in globals.css.
 *   --font-mono     JetBrains Mono  editor / code / keycaps. Clear 0-O / 1-l-I
 *                                  disambiguation for Markdown source.
 *
 * Each face exposes a CSS variable; `tailwind.config.ts` reads those variables
 * so `font-display` / `font-sans` / `font-mono` utilities resolve to the bundled
 * faces app-wide, in both light and dark themes. `display: 'swap'` keeps text
 * visible during the (same-origin, cached) load with no FOIT.
 */
import localFont from 'next/font/local';

/**
 * Geist - display / headings. The two slices (latin + latin-ext) ship as a
 * single declared family. Weight is given as a range because Geist is a
 * variable font; the build keeps it as one woff2 covering 300-700.
 */
export const fontDisplay = localFont({
  src: [
    { path: './fonts/Geist-latin.woff2', weight: '300 700', style: 'normal' },
    { path: './fonts/Geist-latin-ext.woff2', weight: '300 700', style: 'normal' },
  ],
  variable: '--font-display',
  display: 'swap',
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
  adjustFontFallback: 'Arial',
  preload: true,
});

/**
 * Inter - body / UI. Two static instances (400 regular, 600 semibold) are
 * enough for the whole shell; heavier display weights come from Geist.
 */
export const fontSans = localFont({
  src: [
    { path: './fonts/Inter-latin-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/Inter-latin-ext-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/Inter-latin-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/Inter-latin-ext-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-sans',
  display: 'swap',
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
  adjustFontFallback: 'Arial',
  preload: true,
});

/**
 * JetBrains Mono - editor / code / keycaps. One weight (400) keeps the bundle
 * small; the markdown editor never needs bold mono.
 */
export const fontMono = localFont({
  src: [
    { path: './fonts/JetBrainsMono-latin-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/JetBrainsMono-latin-ext-400.woff2', weight: '400', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
  preload: false,
});
