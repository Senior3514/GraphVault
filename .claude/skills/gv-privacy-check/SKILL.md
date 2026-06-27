---
name: gv-privacy-check
description: >-
  Verify GraphVault's privacy invariants hold after any change: zero telemetry,
  network off by default, credentials server-side never in the browser, rendered
  content sanitized, strict CSP. Use when adding AI/connectors/storage/analytics,
  when reviewing anything that makes a network request or stores a secret, when
  asked "does this leak / is this private / any telemetry", or as a gate before
  shipping outward-facing features. Privacy is a promise, not a setting.
---

# Privacy invariant check

The local-first, zero-telemetry promise is core to the product's trust. This
skill confirms a change doesn't quietly break it.

## Invariants

- **Zero telemetry by default.** No analytics SDKs, no phone-home, no usage
  beacons. (We previously had to drop an auto-added analytics package - watch for
  these creeping back via dependencies.)
- **Network off by default.** The app works 100% offline with no account. AI and
  connectors are **opt-in, off by default** - when off, there is literally no
  network call. The assistant UI is hidden when the mode is `off`.
- **Credentials never in the browser.** AI keys and storage credentials
  (WebDAV/S3/Azure/GCS) live encrypted on the user's self-hosted server; the
  browser only talks to that server proxy. Keys are never returned by config
  GETs, never logged, never persisted client-side beyond a transient form.
- **Privacy spectrum is honored.** local (on-device) → BYO-key → server-BFF →
  off (default). A new provider must slot into this, not bypass it.
- **Rendered content is sanitized.** Any HTML/Markdown rendered to the DOM goes
  through DOMPurify. AI output is confirm-before-send and sanitized.
- **Strict CSP + headers** stay intact (`vercel.json` + meta): no `unsafe-eval`,
  `connect-src` scoped, plus X-Content-Type-Options / Referrer-Policy /
  X-Frame-Options / Permissions-Policy.
- **No secrets or internal info in the public repo / README.**

## Method

1. Diff the change for: new dependencies (any telemetry?), new `fetch`/network
   calls (gated behind explicit opt-in? to our own server only?), any place a
   credential could reach the client or a log.
2. Confirm the off/default path makes **no** network request.
3. Confirm any rendered string is sanitized and any CSP change is a tightening,
   not a loosening.
4. Flag violations precisely; fix or block the ship. Verify with gv-gauntlet.
