# GraphVault Roadmap — road to a finished, best-in-class product

> Living document. The agent company updates this after every slice: tick boxes,
> add lessons, re-order by impact. The goal is a **local-first, no-lock-in,
> secure, fast, beautiful** notes app that beats Obsidian / Notepad / CherryTree.

## North star

- **Local-first & private**: works 100% offline, no account required, no telemetry.
- **No lock-in**: plain Markdown on disk; export/import anywhere, anytime.
- **A graph you can think in**: not decoration — a real tool for navigating ideas.
- **Secure & fast**: untrusted input is validated; encryption available; UI stays smooth.

## Status legend

✅ done · 🟡 in progress · ⬜ planned

---

## v0 foundation (shipped)

- ✅ Monorepo, shared wire types, sync protocol draft
- ✅ Sync server (auth + health), security hardening (rate limit, headers, at-rest enc)
- ✅ Web shell: vault editor, markdown render, backlinks, search
- ✅ Graph engine (parse, link/tag index, local/global queries) + Graph UI v1
- ✅ End-to-end sync (scan/diff/pull/push/reconcile + conflict copies)
- ✅ Docker packaging + docs
- ✅ Static export → deployable to any static host (Vercel)

## Milestone 11 — Portability & "your data, any storage" 🟡

- ✅ Export vault as Markdown `.zip` (lossless) and JSON backup
- ✅ Import from `.zip` / `.json` / `.md`, collision-safe (never overwrites)
- ✅ Hardened import (zip-slip / size / count guards) + tests
- ✅ Pluggable storage backend seam: `StorageAdapter` + localStorage + File System Access disk adapter
- ✅ Settings UI to pick storage location (folder on disk) with copy-verify-switch migration
- ✅ Drag-and-drop import + "export to a folder" (File System Access)

> Decision: **open-core** — auditable client + engine, optional paid hosted sync.

## Milestone 12 — Workspace, panes & window controls ✅

- ✅ Resizable panes with drag dividers (sidebar ↔ editor ↔ details)
- ✅ Collapse / expand / maximize-restore controls per pane; layout persisted
- ✅ Editor tabs: open/close/reorder, dirty indicator, "+"; split view (editor+preview / two notes)
- ✅ Per-tab autosave that flushes before switch/close/unmount (no lost edits)
- ⬜ Pop-out windows / focus mode (nice-to-have)

## Milestone 13 — Command palette & power editing ✅

- ✅ Command palette (Cmd/Ctrl+K): quick-open, create note, navigate, toggle preview
- ✅ `[[` wikilink autocomplete and `#` tag autocomplete in the editor
- ✅ Interactive preview: wikilinks navigate, inline `#tags` are clickable filters
- ✅ Collapsible icon-rail shell, tag cloud + tag-filtered note list

## Milestone 14 — Spectacular graph ✅

- ✅ Color by node type (note / attachment / unresolved) + accurate legend
- ✅ Hover glow + neighbor highlight, dim the rest; smooth settled physics
- ✅ Click → select; double-click → open note (`/vault?note=`)
- ✅ Live force controls (link distance, repel, gravity, label threshold)
- ✅ Zoom-to-fit / reset; degree-scaled nodes; reduced-motion aware

## Milestone 15 — Security, encryption & speed 🟡

- ✅ E2E vault encryption library: PBKDF2(310k)+AES-256-GCM, tamper-rejecting, versioned (`lib/crypto`)
- ✅ Security review of render/XSS + import paths (passed)
- ✅ Encryption wired into Settings: `EncryptedVaultStore` decorator + passphrase gate + safe enable/disable
- ✅ Strict CSP (`<meta>` + `vercel.json` headers) + X-Content-Type-Options / Referrer-Policy / X-Frame-Options / Permissions-Policy
- ✅ Performance: virtualized note list + debounced search
- ✅ Automatic backups / version history (IndexedDB, non-destructive restore) — data-loss safety net
- ✅ VPS deployment hardening: production-config safety preflight (fail-fast on
  insecure prod), graceful shutdown, connection/timeout limits, split JSON vs
  blob body caps, hardened Dockerfile/compose (non-root, cap_drop, read-only +
  tmpfs, healthcheck), `docs/hardening.md` (nginx TLS, UFW, fail2ban, systemd)
- ⬜ Lazy-load graph; CSP Trusted Types (CSP shipped)

## Milestone 14b — Graph v2 extras ✅

- ✅ In-graph search (`/`, highlight/zoom to matches), drag-to-pin nodes, zoom buttons, 200+ label cap perf

## Milestone 16 — Desktop app 🟡

- ✅ **Installable PWA** — manifest + offline service worker + icons + Install button;
  runs as a standalone desktop app from any modern browser, auto-updating (the
  "run it right now, any OS" path)
- ✅ Tauri 2 shell scaffold (`apps/desktop`) wrapping the web export + `TauriStorageAdapter`
- ✅ CI gauntlet workflow + Tauri release workflow (Win/Mac/Linux installers on `v*` tags)
- ⬜ Native file watching; open an existing folder as a vault (web: "Open folder" ✅)

## Milestone 17 — Polish, onboarding & launch 🟡

- ✅ Stunning landing page + dismissible first-run onboarding hints (Cmd-K / `[[` / `#`)
- ✅ Global UX polish (focus rings, transitions, empty-state utilities, motion-safe animations)
- ✅ Fully responsive/mobile: single-pane mobile workspace (Notes/Editor/Details bottom bar), drawers, safe-area insets, `100dvh`
- ✅ Docs: quickstart, self-hosting, security model, data portability; public-launch README (scrubbed); one-command install table
- ✅ Accessibility pass: focus traps + restoration, skip-link, ARIA + live regions, WCAG AA
- ✅ QA gauntlet + review (data-loss / privacy / security CLEAR; 2 fixes applied)
- ✅ Light/dark theming via design tokens (system preference + persisted override) — "Prism2": CSS-variable neutral ramp, no-flash boot, segmented Light/Dark/System toggle
- ⬜ "+ to add files" primary action: bottom-thumb FAB (mobile) + file-tree header (desktop)
- ⬜ Tagged v0.1.0 release → native installers via CI

## Milestone 18 — Universal storage providers (your data, literally anywhere) 🟡

Extend the `StorageAdapter` seam so a vault of plain `.md` files can live on any
backend the user chooses. Client-side where possible; credential-bearing
providers go through the self-hosted server (keys never touch the browser).

- ✅ Seam + localStorage + File System Access (disk) + Tauri (native disk)
- ✅ WebDAV adapter (Nextcloud / any) via self-hosted server proxy — creds never in browser
- ✅ S3-compatible adapter (AWS S3 / MinIO / Backblaze / R2) via server proxy (from-scratch SigV4)
- ✅ Azure Blob + Google Cloud Storage adapters (server-proxied) — Azure Shared
  Key (HMAC) + GCS XML API via AWS SigV4 interop; creds AES-GCM at rest, never in
  browser; single-object (`graphvault-vault.json`) proxy like S3
- ⬜ Google Drive + OneDrive (OAuth, app-folder scope; tokens server-side)
- ✅ Settings provider picker with safe copy-verify-switch migration — all
  server-proxied providers (WebDAV, S3, Azure Blob, GCS) selectable from Settings;
  web `StorageAdapter`s talk only to the self-hosted proxy (creds never in browser)

## Milestone 19 — Browser extension (web-clipper → note) 🟡

- ✅ MV3 extension: clip → Markdown → save; cross-browser PNG icons + Firefox id; store-packaging zip
- ⬜ Post directly to the self-hosted sync server (once auth lands end-to-end)
- ✅ Store packaging zip (Chrome / Edge / Firefox) — publishing is a manual upload
- ⬜ Post clips directly to the self-hosted sync server

## Milestone 20 — Embed everywhere / integrations ⬜

Make GraphVault the most _usable_ knowledge tool — it goes where you are.

- ✅ One-click importers: Obsidian / Notion / Roam / Logseq / plain folders
- ✅ Embeddable read-only graph (`/embed?s=…`, privacy-safe snapshot) + Share button
- ✅ Public shareable graph snapshots (opt-in, no account) — server snapshot store
  (off by default; size/count caps, TTL sweep, hashed delete-token, stricter rate
  limit) + web "short link" (`/embed?id=&srv=`) with the self-contained `s=` link
  kept as fallback
- ✅ CLI (`@graphvault/cli`: list / search / stats / graph) + local HTTP API
  (`graphvault serve`: read-only JSON over `node:http`, localhost-default, zero-dep)
- ✅ URL scheme (`web+graphvault:`) + PWA share_target (`/share`) — clip from any app

## Milestone 21 — AI assistant (privacy-first, opt-in) 🟡

Off by default. A privacy dial the user controls; note content never leaves the
device unless the user enables a provider.

- ✅ Provider abstraction with a **privacy spectrum**: local (Ollama / OpenAI-
  compatible localhost) → bring-your-own-key (Anthropic / OpenAI) → off (default,
  no network)
- ✅ Assistant panel: summarize / outline / find connections / suggest links &
  tags / "organize this" — confirm-before-send, output sanitised via DOMPurify
- ✅ Clear in-UI privacy notice + per-action consent; no telemetry; keys in
  sessionStorage, redacted from errors, never logged; button hidden when off
- ✅ Graph intelligence: AI-named clusters, related-notes, gap-finding overlays
  (titles + topology only; off by default; confirm-before-send)
- ⬜ **Server-side AI proxy (BFF)** — keys live on the user's self-hosted server
  (encrypted), never the browser; **OpenRouter** as default gateway (400+ models)
  - per-key spend caps. (Research-backed: client-stored secrets are extractable.)
- ✅ MCP server — expose the vault to external agents (Claude) for interoperability
  (`@graphvault/mcp`: stdio server over the self-hosted HTTP API; read tools —
  list/read/search notes, backlinks, local graph, vault stats; reuses the engine.
  Conflict-safe **write** tools — create/update/append/delete — opt-in via
  `GRAPHVAULT_DEVICE_ID`; never clobbers (server returns conflicts, no blind retry))

## Milestone 22 — Connectors (email & everything, privacy-graded) 🟡

Opt-in, credential-bearing flows go through the self-hosted server; each
connector shows its privacy posture.

- ✅ Connector framework + privacy posture (`local` / `server` / `byo`) + Settings panel
- ✅ RSS / Atom / OPML import (phase 1, `local` — paste/upload, parsed on-device)
- ✅ Email import (`.eml` / `.mbox`, client-side, phase 1)
- ⬜ Live email (IMAP / Gmail / Outlook OAuth) → server-side creds, phase 2
- ⬜ URL-fetch / web-clip via server proxy (avoids CORS, keeps creds off the browser)
- ✅ Generic webhook / "connect anything" + per-connector audit log — per-user
  inbox tokens (hashed, vault-scoped, owner-minted) → `POST /v1/inbox/:token`
  lands content as a non-clobbering `Inbox/…` note via the tested blob/sync path;
  size-capped, rate-limited; authenticated audit log of every inbound event

---

## Open question to resolve with the owner

- **License / source model**: open-source (recommended: open-core — auditable
  client + engine, optional paid hosted sync) vs closed. For a _local-first_
  app, user data access comes from local files + export (already shipped), **not**
  from the license — so closed source does **not** improve "access," while open
  source materially improves trust for a security-sensitive notes app. Pending decision.

## Working agreement (every agent)

1. Inspect before changing; work in ownership-disjoint slices.
2. Build green + tests green before ship. Never silently lose user data.
3. Validate all external/untrusted input. No secrets, no telemetry by default.
4. Update this roadmap and `docs/agent-company/lessons.md` after each slice.
