import type { Metadata, Viewport } from 'next';
import './globals.css';
import { fontDisplay, fontMono, fontSans } from './fonts';
import { AppFrame } from '../components/AppFrame';
import { ServiceWorkerRegistrar } from '../components/ServiceWorkerRegistrar';
import { ThemeProvider } from '../components/ThemeProvider';
import { THEME_BOOT_SCRIPT } from '../lib/themeScript';
import { toTrustedHTML } from '../lib/security/trustedTypes';
import { CSP_META } from '../lib/security/csp';

export const metadata: Metadata = {
  title: 'GraphVault - open and write. No folders, no file access.',
  description:
    'A dynamic, cloud-ready notes vault with a graph you can think in. Open the app and start writing - no folders to pick, no file permissions, no setup.',
};

/**
 * Viewport configuration. CRITICAL for mobile:
 *  - `width: 'device-width'` makes the layout responsive (without it the page
 *    renders at a 980px desktop width and is unreadable on phones).
 *  - `viewportFit: 'cover'` is what makes `env(safe-area-inset-*)` return
 *    non-zero values on notched devices - the mobile chrome already pads with
 *    those insets, but they are inert until the viewport opts into the full
 *    display with `cover`.
 *  - `themeColor` drives the browser/status-bar tint; matched to the dark and
 *    light backgrounds so the chrome blends with whichever theme is active.
 *  - Pinch-zoom is intentionally left enabled (no `maximumScale`) for
 *    accessibility; only the initial scale is pinned.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    // Matched to the refined cool-neutral --n-950 page backgrounds (globals.css):
    // dark rgb(11 13 17) → #0b0d11, light rgb(250 251 253) → #fafbfd.
    { media: '(prefers-color-scheme: dark)', color: '#0b0d11' },
    { media: '(prefers-color-scheme: light)', color: '#fafbfd' },
  ],
};

/**
 * Content-Security-Policy for the static export.
 *
 * The directive list (with full rationale for every directive, and a note on
 * why Trusted Types enforcement is investigated-but-not-yet-enabled) lives in
 * `lib/security/csp.ts` - the single source of truth, kept byte-for-byte in
 * sync with the `Content-Security-Policy` response header in `vercel.json`
 * (asserted by `lib/security/csp.test.ts`).
 *
 * On Vercel the response header set in `vercel.json` takes precedence and is
 * the authoritative enforcement point; the `<meta>` tag below is a
 * defence-in-depth fallback for other static hosts (GitHub Pages, Netlify,
 * Caddy serving `/out` directly). Note: `frame-ancestors` is ignored in
 * `<meta>` per spec (CSP Level 2 §6.2) - the header in `vercel.json` and
 * `X-Frame-Options` both enforce the no-frame policy.
 */

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the no-flash boot script sets `data-theme` on
    // <html> before React hydrates, so the server-rendered <html> (no attr)
    // and the client DOM (attr present) differ by design. This silences the
    // expected attribute mismatch warning without affecting children.
    <html
      lang="en"
      suppressHydrationWarning
      // Self-hosted font CSS variables (see app/fonts.ts). `--font-sans` is the
      // body/UI face (Inter), `--font-display` the heading face (Geist), and
      // `--font-mono` the editor face (JetBrains Mono). Tailwind's fontFamily
      // tokens read these vars so `font-sans` / `font-display` / `font-mono`
      // resolve app-wide in both themes. `font-sans` here sets the document
      // default so the cascade picks up Inter without a per-element class.
      className={`${fontSans.variable} ${fontDisplay.variable} ${fontMono.variable} font-sans`}
    >
      <head>
        {/*
         * No-flash theme boot: set `data-theme` from persisted mode (default
         * `system`) BEFORE first paint to avoid a light/dark flash. Inline and
         * eval-free, so it is allowed under `script-src 'self' 'unsafe-inline'`
         * (no 'unsafe-eval' needed). Must be the first thing in <head>.
         *
         * Trusted Types note: this is a Server Component, so this
         * `dangerouslySetInnerHTML` is resolved once at build time into the
         * static export's literal HTML bytes - the browser's HTML parser
         * executes it as an ordinary parser-inserted <script> (governed by
         * `script-src`, same as any inline script written directly in the
         * page source), not via a runtime `Element.innerHTML =` JS call. Per
         * the HTML spec, only script content assigned dynamically through a
         * DOM API (`.innerHTML`/`.textContent`/`.text` on an *already-existing*
         * node, or a nested `<script>` produced by re-parsing an `.innerHTML`
         * string on a *different* element) goes through the Trusted Types
         * "HTML sink" / "script sink" checks - a script that's part of the
         * initial parse never does, because there is no live sink call for
         * Trusted Types to intercept. `toTrustedHTML()` is applied anyway,
         * defensively and at zero cost: at build time there is no `window`,
         * so it's a pure passthrough (see `lib/security/trustedTypes.ts`).
         * The CSP doesn't enforce Trusted Types yet (see the blocker note in
         * `lib/security/csp.ts`), but this call site is ready for when it does.
         */}
        <script dangerouslySetInnerHTML={{ __html: toTrustedHTML(THEME_BOOT_SCRIPT) }} />
        {/*
         * CSP via <meta> covers the static-file and self-hosted cases.
         * On Vercel the Content-Security-Policy response header set in vercel.json
         * takes precedence and is the authoritative enforcement point; the meta tag
         * is a defence-in-depth fallback for other static hosts (e.g. GitHub Pages,
         * Netlify, Caddy serving the /out directory directly).
         * Note: frame-ancestors is intentionally omitted here because browsers
         * ignore it in <meta> (per CSP Level 2 spec, section 6.2). The header in
         * vercel.json and X-Frame-Options both enforce the no-frame policy.
         */}
        <meta httpEquiv="Content-Security-Policy" content={CSP_META} />
        {/* PWA manifest. theme-color + viewport-fit are emitted by the
            `viewport` export above (Next.js merges them into <meta> tags). */}
        <link rel="manifest" href="/manifest.webmanifest" />
        {/* Apple PWA meta - iOS uses these when added to Home Screen */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="GraphVault" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        {/* Explicit favicon so the browser doesn't fall back to probing
            `/favicon.ico` (which doesn't exist and 404s in the console on
            every single page load otherwise). Reuses the existing PWA icon -
            no separate .ico asset needed. */}
        <link rel="icon" href="/icons/icon-192.png" type="image/png" />
      </head>
      <body>
        {/*
         * Skip-to-content link: first focusable element in the page so that
         * keyboard users can bypass the navigation rail and jump directly to the
         * main content area. Visually hidden until focused (via .skip-link in
         * globals.css). The `#main-content` anchor is placed on the page
         * content container inside AppFrame.
         */}
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        {/*
         * ServiceWorkerRegistrar is a tiny 'use client' component that calls
         * navigator.serviceWorker.register('/sw.js') on mount. It renders
         * nothing - purely a side-effect. Keeping it separate avoids making
         * the entire layout a client component.
         */}
        <ServiceWorkerRegistrar />
        {/*
         * ThemeProvider owns the theme mode (light/dark/system), persists it,
         * and keeps <html data-theme> reactive after the boot script's initial
         * set. It's a client component but renders children straight through,
         * so the server layout stays a server component.
         */}
        <ThemeProvider>
          <AppFrame>{children}</AppFrame>
        </ThemeProvider>
      </body>
    </html>
  );
}
