# GraphVault Roadmap - road to a finished, best-in-class product

> Living document. The agent company updates this after every slice: tick boxes,
> add lessons, re-order by impact. The goal is a **local-first, no-lock-in,
> secure, fast, beautiful** notes app that beats Obsidian / Notepad / CherryTree.

## North star

- **Local-first & private**: works 100% offline, no account required, no telemetry.
- **No lock-in**: plain Markdown on disk; export/import anywhere, anytime.
- **A graph you can think in**: not decoration - a real tool for navigating ideas.
- **Secure & fast**: untrusted input is validated; encryption available; UI stays smooth.

## Status legend

✅ done · 🟡 in progress · ⬜ planned

---

## Competitive edge (market-driven priorities)

Derived from a market + UX review against Obsidian, Notion, Logseq, Roam, and
Anytype. GraphVault is the only tool that is simultaneously open-source,
local-first / zero-telemetry, multi-storage, privacy-first AI, and one codebase
across web + mobile + desktop. The loop prioritizes the bets below in order:

1. **One-click native installers, hosted** - end users download a Windows
   `.exe` / macOS `.dmg` / Linux `.AppImage` from `/download`. Pipeline is built
   **and now verified working** (Milestone 16 - a real local Linux build
   produced valid `.deb`/`.rpm` packages after fixing four previously-hidden
   bugs); it lights up for hosted downloads the moment the owner enables
   GitHub Actions, or can be built locally today (see the README's "Get the
   app" section: `pnpm --filter @graphvault/desktop build`).
2. **Connect to everything (privacy-graded)** - web-clip via the server proxy is
   done; next is live email (IMAP / Gmail / Outlook OAuth, creds server-side).
3. **Cloud drives** - Google Drive + OneDrive (OAuth app-folder, tokens
   server-side) so a vault of `.md` lives anywhere the user already keeps files.
4. **Effortless capture & navigation** - keep sharpening the `+` / quick-capture,
   command palette, and graph so it beats Obsidian on "usable for thinking".
5. **Trust signals** - keep zero-telemetry, encryption, and the security posture
   visible and audited every maintenance sweep.

---

## v0 foundation (shipped)

- ✅ Monorepo, shared wire types, sync protocol draft
- ✅ Sync server (auth + health), security hardening (rate limit, headers, at-rest enc)
- ✅ Web shell: vault editor, markdown render, backlinks, search
- ✅ Graph engine (parse, link/tag index, local/global queries) + Graph UI v1
- ✅ End-to-end sync (scan/diff/pull/push/reconcile + conflict copies)
- ✅ Docker packaging + docs
- ✅ Static export → deployable to any static host (Vercel)

## Milestone 11 - Portability & "your data, any storage" 🟡

- ✅ Export vault as Markdown `.zip` (lossless) and JSON backup
- ✅ Import from `.zip` / `.json` / `.md`, collision-safe (never overwrites)
- ✅ Hardened import (zip-slip / size / count guards) + tests
- ✅ Pluggable storage backend seam: `StorageAdapter` + localStorage + File System Access disk adapter
- ✅ Settings UI to pick storage location (folder on disk) with copy-verify-switch migration
- ✅ Drag-and-drop import + "export to a folder" (File System Access)

> Decision: **open-core** - auditable client + engine, optional paid hosted sync.

## Milestone 12 - Workspace, panes & window controls ✅

- ✅ Resizable panes with drag dividers (sidebar ↔ editor ↔ details)
- ✅ Collapse / expand / maximize-restore controls per pane; layout persisted
- ✅ Editor tabs: open/close/reorder, dirty indicator, "+"; split view (editor+preview / two notes)
- ✅ Per-tab autosave that flushes before switch/close/unmount (no lost edits)
- ✅ Focus mode - distraction-free editing (hide rail/sidebar/details, center
  editor; `Cmd/Ctrl+Shift+F` + Esc + palette; persisted, non-destructive)
- ⬜ Pop-out windows (nice-to-have)

## Milestone 13 - Command palette & power editing ✅

- ✅ Command palette (Cmd/Ctrl+K): quick-open, create note, navigate, toggle preview
- ✅ `[[` wikilink autocomplete and `#` tag autocomplete in the editor
- ✅ Interactive preview: wikilinks navigate, inline `#tags` are clickable filters
- ✅ Collapsible icon-rail shell, tag cloud + tag-filtered note list

## Milestone 14 - Spectacular graph ✅

- ✅ Color by node type (note / attachment / unresolved) + accurate legend
- ✅ Hover glow + neighbor highlight, dim the rest; smooth settled physics
- ✅ Click → select; double-click → open note (`/vault?note=`)
- ✅ Live force controls (link distance, repel, gravity, label threshold)
- ✅ Zoom-to-fit / reset; degree-scaled nodes; reduced-motion aware

## Milestone 15 - Security, encryption & speed 🟡

- ✅ E2E vault encryption library: PBKDF2(310k)+AES-256-GCM, tamper-rejecting, versioned (`lib/crypto`)
- ✅ Security review of render/XSS + import paths (passed)
- ✅ Encryption wired into Settings: `EncryptedVaultStore` decorator + passphrase gate + safe enable/disable
- ✅ Strict CSP (`<meta>` + `vercel.json` headers) + X-Content-Type-Options / Referrer-Policy / X-Frame-Options / Permissions-Policy
- ✅ Performance: virtualized note list + debounced search
- ✅ Automatic backups / version history (IndexedDB, non-destructive restore) - data-loss safety net
- ✅ VPS deployment hardening: production-config safety preflight (fail-fast on
  insecure prod), graceful shutdown, connection/timeout limits, split JSON vs
  blob body caps, hardened Dockerfile/compose (non-root, cap_drop, read-only +
  tmpfs, healthcheck), `docs/hardening.md` (nginx TLS, UFW, fail2ban, systemd)
- ✅ Lazy-load graph (force-graph lib code-split via `next/dynamic` + accessible
  loading skeleton; kept out of First Load JS)
- ⬜ CSP Trusted Types - **investigated, blocked, not shipped.** Built and
  tested the policy/wrapper infra (`apps/web/lib/security/trustedTypes.ts`,
  `toTrustedHTML()` wired into all 3 `dangerouslySetInnerHTML` sites), but did
  **not** add `require-trusted-types-for` / `trusted-types` to the CSP: a real
  headless-Chromium run with the CSP actually enforced (not just a green
  `pnpm build`) found that the third-party `force-graph` library (graph view)
  assigns a bare string to `.innerHTML` in its own `init()` - outside our code,
  and un-interceptable in time from a React parent (child layout effects run
  before a parent's) - which throws and breaks the graph view on every
  Chromium user. The only fixes are a blanket `'default'` Trusted Types policy
  (rejected - defeats the purpose) or patching the dependency (fragile, out of
  scope). Full writeup + exact repro in `apps/web/lib/security/csp.ts` and
  `docs/agent-company/lessons.md`. Re-attempt once `force-graph` is
  Trusted-Types-aware upstream or is swapped out, re-verifying the same way.

## Milestone 14b - Graph v2 extras ✅

- ✅ In-graph search (`/`, highlight/zoom to matches), drag-to-pin nodes, zoom buttons, 200+ label cap perf

## Milestone 16 - Desktop app 🟡

- ✅ **Installable PWA** - manifest + offline service worker + icons + Install button;
  runs as a standalone desktop app from any modern browser, auto-updating (the
  "run it right now, any OS" path)
- ✅ **Native desktop build fixed and verified end-to-end** (previously silently
  broken since the scaffold was first written - never once compiled, in any
  environment, until this fix). Four real, concrete bugs found and fixed:
  1. `Cargo.toml` declared a `"dialog"` feature on the `tauri` crate itself -
     not a valid feature on any 2.x release - which failed dependency
     resolution before compilation could even start, everywhere.
  2. `main.rs` called `.pick_folder().await` on a callback-based (not
     `Future`-returning) API - switched to the crate's own documented
     `blocking_pick_folder()` for use inside an async command.
  3. The result is a `FilePath` enum (path or `file://`/`content://` URL), not
     a `PathBuf` - switched to `.into_path()`, which correctly normalizes a URL
     variant to a real OS path (a bare `Display`/`to_string()` would not).
  4. **`tauri.conf.json`'s `frontendDist` was `"../../apps/web/out"`** -
     resolved (relative to the config file's own directory) to
     `apps/apps/web/out`, which never exists - one `../` short of the repo
     root. This is _why_ every previous "missing web assets" build failure
     looked identical to the separate missing-system-library problem; fixing
     the libraries alone was never going to be enough.
     Verified for real: installed the Linux build toolchain
     (libwebkit2gtk-4.1-dev et al.), ran a full `cargo build --release` (clean,
     zero warnings) and `tauri build`, and got genuine, valid installer packages
  - `GraphVault_0.1.0_amd64.deb` and `GraphVault-0.1.0-1.x86_64.rpm` - out the
    other end. (The `.AppImage` bundling step failed only on a sandboxed-network
    403 fetching a third-party `AppRun` binary from GitHub - not a code issue;
    unaffected on a normal internet connection or GitHub's own CI runners.) This
    also means the CI-based `desktop-release.yml` workflow was never actually
    going to succeed either, independent of the GitHub Actions billing block -
    it hit the identical bug. Both paths are real now.
- ✅ Tauri 2 shell (`apps/desktop`) wraps the web export and builds real
  installers (above). **Native on-disk vault storage is now wired
  end-to-end**: `TauriStorageAdapter`
  (`apps/web/lib/vault/storage/tauriAdapter.ts` - moved there from
  `apps/desktop` so it bundles/code-splits exactly like every other storage
  adapter) is registered in the adapter registry and reachable from Settings
  → Storage location → "Open a vault folder (native)", using the same
  copy-verify-activate `migrateAdapter()` path as WebDAV/S3/File System
  Access. The `fs` plugin's static scope stays permanently empty (least
  privilege); `pick_vault_folder` (`src-tauri/src/main.rs`) is the only place
  a path is ever granted, via `app.fs_scope().allow_directory(path, true)`,
  and only for the single folder the user just picked - added a
  `capabilities/default.json` (`fs:read-all` / `fs:write-all` command
  permissions, no pre-configured path) since the app previously had _zero_
  capabilities and every fs-plugin call would have been denied at runtime.
  **Known gap, documented not fabricated**: the scope grant lives in the
  running process's memory only, so the folder isn't remembered across app
  restarts yet. The standard fix (`tauri-plugin-persisted-scope`) was
  evaluated and rejected - the only version compatible with this project's
  `rust-version = "1.77"` pulls in a `tauri "^2.0.0"` / `wry "^0.44.0"` chain
  that conflicts with the already-resolved `kuchikiki` crate and breaks
  `cargo check` outright. Re-attempt once the `rust-version` floor is raised
  or a compatible release ships.
- ⬜ Native file watching; open an existing folder as a vault (web: "Open folder" ✅)

## Milestone 17 - Polish, onboarding & launch 🟡

- ✅ Stunning landing page + dismissible first-run onboarding hints (Cmd-K / `[[` / `#`)
- ✅ Global UX polish (focus rings, transitions, empty-state utilities, motion-safe animations)
- ✅ Fully responsive/mobile: single-pane mobile workspace (Notes/Editor/Details bottom bar), drawers, safe-area insets, `100dvh`
- ✅ Docs: quickstart, self-hosting, security model, data portability; public-launch README (scrubbed); one-command install table
- ✅ Accessibility pass: focus traps + restoration, skip-link, ARIA + live regions, WCAG AA
- ✅ QA gauntlet + review (data-loss / privacy / security CLEAR; 2 fixes applied)
- ✅ Light/dark theming via design tokens (system preference + persisted override) - "Prism2": CSS-variable neutral ramp, no-flash boot, segmented Light/Dark/System toggle
- ✅ "+ to add files" primary action: `AddButton` renders a bottom-thumb FAB in
  the mobile safe-area (mounted in `AppFrame.tsx`) and an inline "+" in the
  file-tree header above `NoteTree` on desktop (`vault/page.tsx`); one tap/click
  opens New note / Import… / New folder
- 🟡 v0.1.0 release **prepped**: all workspace versions bumped to 0.1.0, CHANGELOG
  written, CI green. Final step (owner): `git tag v0.1.0 && git push origin v0.1.0`
  to trigger `desktop-release.yml` (native installers). See `docs/releasing.md`.
- ✅ **Fixed a real, reproducible hydration crash on `/vault`** (React error
  #418) - present since `AddButton`'s mobile FAB was added, and invisible to
  every prior check (`pnpm build`, unit tests, even `smoke:web`) because the
  smoke test reused one browser context across all 9 routes, and visiting any
  OTHER route before `/vault` happened to avoid the mismatch. A genuinely
  fresh visitor landing on `/vault` directly - a bookmark, a deep link, the
  first page of a new session - hit it on every single load: React discarded
  the server HTML and re-rendered from scratch, which is exactly the kind of
  visible content flash a user would describe as "bad flashes/flicker".
  Root cause: `AppFrame.tsx` mounted the FAB behind `pathname === '/vault'`
  with no SSR/first-hydration guard, and `usePathname()` did not agree
  between the statically exported HTML and the client's first render on that
  route. Fixed by gating it on the same post-mount `hydrated` flag already
  used two lines above it for the sidebar's collapsed state - same pattern,
  now applied consistently. **`scripts/smoke-web.mjs` now opens a fresh
  browser context per route** instead of one shared context for all of them,
  specifically so this class of "only wrong on a true first load" bug can
  never hide behind route ordering again.
- ✅ Console-clean pass: added a real `<link rel="icon">` (was a silent
  `/favicon.ico` 404 on every load) and split the CSP into `CSP` (full, for
  the `vercel.json` response header where `frame-ancestors` is actually
  enforced) vs `CSP_META` (`app/layout.tsx`'s `<meta>` tag, `frame-ancestors`
  removed - browsers ignore it there and logged a console error for it on
  every page, every route, for no security benefit).
- ✅ `NoteTree`'s scroll handler now coalesces to one `requestAnimationFrame`
  per frame instead of one React state update (and virtualization recompute)
  per native `scroll` event, which can fire faster than the display refreshes
  during a fast fling.

## Milestone 18 - Universal storage providers (your data, literally anywhere) 🟡

Extend the `StorageAdapter` seam so a vault of plain `.md` files can live on any
backend the user chooses. Client-side where possible; credential-bearing
providers go through the self-hosted server (keys never touch the browser).

- ✅ Seam + localStorage + File System Access (disk) + Tauri (native disk)
- ✅ WebDAV adapter (Nextcloud / any) via self-hosted server proxy - creds never in browser
- ✅ S3-compatible adapter (AWS S3 / MinIO / Backblaze / R2) via server proxy (from-scratch SigV4)
- ✅ Azure Blob + Google Cloud Storage adapters (server-proxied) - Azure Shared
  Key (HMAC) + GCS XML API via AWS SigV4 interop; creds AES-GCM at rest, never in
  browser; single-object (`graphvault-vault.json`) proxy like S3
- ⬜ Google Drive + OneDrive (OAuth, app-folder scope; tokens server-side)
- ✅ Settings provider picker with safe copy-verify-switch migration - all
  server-proxied providers (WebDAV, S3, Azure Blob, GCS) selectable from Settings;
  web `StorageAdapter`s talk only to the self-hosted proxy (creds never in browser)

## Milestone 19 - Browser extension (web-clipper → note) ✅

- ✅ MV3 extension: clip → Markdown → save; cross-browser PNG icons + Firefox id; store-packaging zip
- ✅ Store packaging zip (Chrome / Edge / Firefox) - publishing is a manual upload
- ✅ Post clips directly to the self-hosted server inbox - a "Send to server
  inbox" action posts to the already-shipped `POST /v1/inbox/:token` (token
  minted once from Settings → Advanced → Connectors on the web app); least-
  privilege `optional_host_permissions` requested only when first used; the
  bearer token lives in `chrome.storage.local` (not `.sync`, unlike the local-
  vault URL preference) so it never silently roams the browser account; honest
  per-status error messages (404/413/429/network), never a generic failure

## Milestone 20 - Embed everywhere / integrations ✅

Make GraphVault the most _usable_ knowledge tool - it goes where you are.

- ✅ One-click importers: Obsidian / Notion / Roam / Logseq / plain folders
- ✅ Embeddable read-only graph (`/embed?s=…`, privacy-safe snapshot) + Share button
- ✅ Public shareable graph snapshots (opt-in, no account) - server snapshot store
  (off by default; size/count caps, TTL sweep, hashed delete-token, stricter rate
  limit) + web "short link" (`/embed?id=&srv=`) with the self-contained `s=` link
  kept as fallback
- ✅ CLI (`@graphvault/cli`: list / search / stats / graph) + local HTTP API
  (`graphvault serve`: read-only JSON over `node:http`, localhost-default, zero-dep)
- ✅ URL scheme (`web+graphvault:`) + PWA share_target (`/share`) - clip from any app

## Milestone 21 - AI assistant (privacy-first, opt-in) 🟡

Off by default. A privacy dial the user controls; note content never leaves the
device unless the user enables a provider.

- ✅ Provider abstraction with a **privacy spectrum**: local (Ollama / OpenAI-
  compatible localhost) → bring-your-own-key (Anthropic / OpenAI) → off (default,
  no network)
- ✅ Assistant panel: summarize / outline / find connections / suggest links &
  tags / "organize this" - confirm-before-send, output sanitised via DOMPurify
- ✅ Clear in-UI privacy notice + per-action consent; no telemetry; keys in
  sessionStorage, redacted from errors, never logged; button hidden when off
- ✅ Graph intelligence: AI-named clusters, related-notes, gap-finding overlays
  (titles + topology only; off by default; confirm-before-send)
- ✅ **Server-side AI proxy (BFF)** - keys live on the user's self-hosted server,
  AES-256-GCM + HKDF encrypted at rest, never the browser; **OpenRouter** as the
  default gateway (`custom` gateway supports any OpenAI-compatible endpoint,
  e.g. Anthropic/OpenAI directly); per-user monetary (`spendCapUsd`) and daily
  request (`dailyRequestCap`) caps enforced server-side, with `spendCapState`
  surfaced to the client so the UI can show remaining budget. SSE streaming
  supported. (Research-backed: client-stored secrets are extractable.)
- ✅ MCP server - expose the vault to external agents (Claude) for interoperability
  (`@graphvault/mcp`: stdio server over the self-hosted HTTP API; read tools -
  list/read/search notes, backlinks, local graph, vault stats; reuses the engine.
  Conflict-safe **write** tools - create/update/append/delete - opt-in via
  `GRAPHVAULT_DEVICE_ID`; never clobbers (server returns conflicts, no blind retry).
  **Resources** - notes as attachable `graphvault://note/<path>` resources (list +
  read, text/markdown). **Prompts** - `summarize_note`, `find_connections`,
  `search_and_synthesize` templates that embed real vault context)

## Milestone 22 - Connectors (email & everything, privacy-graded) 🟡

Opt-in, credential-bearing flows go through the self-hosted server; each
connector shows its privacy posture.

- ✅ Connector framework + privacy posture (`local` / `server` / `byo`) + Settings panel
- ✅ RSS / Atom / OPML import (phase 1, `local` - paste/upload, parsed on-device)
- ✅ Email import (`.eml` / `.mbox`, client-side, phase 1)
- ⬜ Live email (IMAP / Gmail / Outlook OAuth) → server-side creds, phase 2
- ✅ URL-fetch / web-clip via server proxy (avoids CORS, keeps creds off the
  browser) - `POST /v1/clip` (SSRF-guarded server fetch + HTML→Markdown), shared
  zod contract, API client `clipUrl`, and a Settings WebClipPanel that lands the
  page as a collision-safe `connectors/webclip/…` note with frontmatter
- ✅ Generic webhook / "connect anything" + per-connector audit log - per-user
  inbox tokens (hashed, vault-scoped, owner-minted) → `POST /v1/inbox/:token`
  lands content as a non-clobbering `Inbox/…` note via the tested blob/sync path;
  size-capped, rate-limited; authenticated audit log of every inbound event

---

## Monetization ✅ decided (open-core), 🟡 Cloud tier not built

Owner decided: **open-core**, MIT, matching Obsidian's proven model for this
category. The app, self-hosting, and every storage backend stay free forever.

- ✅ Plan/tier data model (`packages/shared/src/billing.ts`) - `free` / `cloud`,
  reuses the existing AI spend-cap metering rather than a parallel system.
- ✅ [`docs/PRICING.md`](PRICING.md) - the public pricing page content.
- ⬜ **GraphVault Cloud** (paid, optional): managed sync relay, pooled AI
  credits, managed backups, priority support. Requires a real payment
  processor integration and a business entity - not started; needs an owner
  decision on provider (e.g. Stripe) before implementation.

## Milestone 23 - Obsidian-class UI polish ✅

Direct response to user feedback that the product felt generic.

- ✅ Spectacular, intuitive graph: on-brand lit-sphere nodes with degree-scaled
  glow, curved directional edges, hover-highlighted focus subgraph
- ✅ Self-hosted premium typography (Geist/Inter/JetBrains Mono via
  `next/font/local`, zero external font requests)
- ✅ Animated, dependency-free landing hero (CSS/SVG, motion-safe)
- ✅ Clear public-landing vs private-vault separation (lock cue, one-time
  welcome, "Private vault" sidebar identity)
- ✅ Headless-browser smoke test (`pnpm run smoke:web`) wired into the
  gauntlet - loads every route in real Chromium, catches the class of bug
  (hydration mismatches, stale-SW chunks) that unit tests and `build:web`
  both missed and that once caused a production white-screen
- ✅ README rewritten: concise, accurate, no internal/agent-company exposure

## Working agreement (every agent)

1. Inspect before changing; work in ownership-disjoint slices.
2. Build green + tests green before ship. Never silently lose user data.
3. Validate all external/untrusted input. No secrets, no telemetry by default.
4. Update this roadmap and `docs/agent-company/lessons.md` after each slice.
