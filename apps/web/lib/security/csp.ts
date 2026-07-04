/**
 * Content-Security-Policy for the static export - single source of truth.
 *
 * Extracted out of `app/layout.tsx` (which renders it into a `<meta
 * http-equiv="Content-Security-Policy">`) so `csp.test.ts` can assert it stays
 * byte-for-byte in sync with the `Content-Security-Policy` response header in
 * `vercel.json` (the authoritative enforcement point on Vercel - see the
 * "why two places" note in `app/layout.tsx`). Same pattern as
 * `lib/themeScript.ts` being extracted for the same reason.
 *
 * WHY 'unsafe-inline' FOR SCRIPTS:
 *   Next.js App Router static export (`output: 'export'`) injects RSC flight
 *   data as inline <script> tags (e.g. `self.__next_f.push([…])`). These are
 *   emitted at build time with content that changes every build, so nonces
 *   (server-side, per-request only) and precomputed SHA-256 hashes (change
 *   every build) are both impractical for a fully-static site. All application
 *   JS still loads from '/_next/static/' (same origin), so the practical XSS
 *   attack surface is limited to injected script elements - which DOMPurify
 *   already prevents in the markdown preview path.
 *
 * WHY 'unsafe-inline' FOR STYLES:
 *   Two sources require it:
 *   1. JSX style={} attributes (e.g. animation-delay on the landing page star
 *      row) become inline style="" attributes in the static HTML.
 *   2. Next.js renders a 404 fallback that contains an inline <style> block.
 *   Hashing is not feasible in a static export; scoping 'unsafe-inline' to
 *   style-src only (never to script-src alone) is the narrowest safe relaxation.
 *
 * WHY img-src data::
 *   The react-force-graph-2d canvas renderer may export the graph as a data URI
 *   via canvas.toDataURL(). Allowing data: here is safe because no
 *   user-controlled HTML reaches an <img src> - DOMPurify strips all URLs.
 *
 * All remote origins are absent: no CDN scripts, no external fonts, no analytics.
 * frame-ancestors is ignored in <meta> per spec; it is enforced as a response
 * header in vercel.json (and X-Frame-Options as a belt-and-suspenders fallback).
 *
 * ---------------------------------------------------------------------------
 * TRUSTED TYPES - investigated, NOT yet enforced via CSP. Read before retrying.
 * ---------------------------------------------------------------------------
 * `require-trusted-types-for 'script'; trusted-types <name>;` is deliberately
 * NOT in this list yet. `lib/security/trustedTypes.ts` registers a single,
 * narrowly-scoped policy (`graphvault-sanitized-html`) and all 3
 * `dangerouslySetInnerHTML` sites in this app (MarkdownPreview, AssistantPanel,
 * layout.tsx's theme-boot script) already wrap their already-DOMPurify-
 * sanitized HTML through it via `toTrustedHTML()` - that groundwork is real,
 * tested, and harmless whether or not the CSP directive is ever added (with no
 * `trusted-types` CSP directive present, Trusted Types simply isn't enforced,
 * so `toTrustedHTML()` is a no-op-shaped passthrough today).
 *
 * What blocks turning enforcement ON, found empirically with a real headless-
 * Chromium run serving this exact CSP as a response header (not just a green
 * `pnpm build`): the third-party `force-graph` library (wrapped by
 * `react-force-graph-2d`, used on `/graph` and `/embed`) does
 * `domNode.innerHTML = '';` directly in its own `init()` to wipe its mount
 * container (`force-graph/src/force-graph.js`, the `init: function(domNode,
 * state)` Kapsule hook) - completely outside our code, called via
 * `react-kapsule`'s `useLayoutEffect` the instant the graph mounts (before our
 * own component's effects can run - child layout effects/refs fire before a
 * parent's in React's commit order, so there is no user-space hook that can
 * intercept it in time). Once the `trusted-types` directive is present, that
 * bare-string assignment throws `TypeError: ... requires 'TrustedHTML'
 * assignment`, which is an uncaught page error - it breaks the graph view (a
 * flagship feature) on every Chromium user, on page load, unconditionally.
 *
 * (Two OTHER frameworks-internal policies were found and would need
 * allow-listing too - `nextjs` and `nextjs#bundler`, which Next.js/webpack
 * register unconditionally for their own code-split chunk loading - but those
 * are solvable by just adding the two names. DOMPurify's own internal
 * `dompurify` policy was also investigated and turned out to be a non-issue:
 * it parses into a `document.implementation.createHTMLDocument()`-created
 * document, which carries no CSP of its own, so Trusted Types isn't enforced
 * there regardless. The `force-graph` issue is the one genuine blocker.)
 *
 * The only fixes available for the `force-graph` sink are either (a) a
 * blanket `'default'` Trusted Types policy - which this project deliberately
 * rejects, since it would silently rubber-stamp every *other* future
 * `innerHTML =` call app-wide with no review - or (b) patching the
 * `force-graph` dependency itself (fragile across upgrades, and out of scope
 * for a minimal, `apps/web/**`-only change). See
 * `docs/agent-company/lessons.md` for the full investigation. Re-attempt this
 * once `force-graph` ships Trusted-Types-aware internals (track upstream) or
 * the graph renderer is swapped for one that is, and re-verify with the same
 * real-Chromium, real-CSP-header method - a green `pnpm build` alone will not
 * catch this class of regression.
 */

export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https: http:",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
] as const;

export const CSP = CSP_DIRECTIVES.join('; ');
