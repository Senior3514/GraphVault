# Changelog

All notable changes to GraphVault are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows
[Semantic Versioning](https://semver.org/). GraphVault is pre-1.0, so `0.x`
releases may still refine APIs.

## [0.1.0] — 2026-06-17

First tagged release. GraphVault is a **local-first Markdown notes app** with
self-hosted sync and a graph you can actually think in — plain `.md` files on
disk, no lock-in, no telemetry, security-conscious by default.

### Notes, editor & workspace

- Local-first vault of plain Markdown; live preview with clickable wikilinks and
  inline `#tags`; backlinks panel and full-text search.
- Resizable panes (sidebar ↔ editor ↔ details) with collapse/maximize, editor
  tabs with per-tab autosave that flushes before switch/close, and split view.
- Command palette (`Cmd/Ctrl+K`): quick-open, create, navigate; `[[` wikilink and
  `#` tag autocomplete; collapsible icon-rail shell with a tag cloud.
- **Focus mode** (`Cmd/Ctrl+Shift+F`): distraction-free, non-destructive editing.
- **Light / dark / system theming** ("Prism2") via design tokens, with a no-flash
  boot and a persisted override.

### Graph

- Force-directed graph with colour-by-type/tag/cluster, hover/neighbour glow,
  in-graph search, drag-to-pin, zoom controls, a time-slider, and group overlays.
- Lazy-loaded canvas (`ssr:false`), retina-aware, reduced-motion aware.
- **Embeddable read-only graph** and **public shareable snapshots** — share a
  self-contained `/embed?s=` link, or an opt-in short `/embed?id=&srv=` link
  backed by the server snapshot store.

### Sync, storage & portability

- Self-hosted sync server (Fastify + PostgreSQL/in-memory): register → vault →
  blob → push/pull with a deterministic three-way conflict model (conflict
  copies; never silently loses data). Optional at-rest blob encryption (AES-256).
- E2E vault encryption (PBKDF2 + AES-256-GCM), automatic local backups / version
  history, lossless `.zip` + JSON export and collision-safe import.
- Pluggable `StorageAdapter`s: localStorage, File System Access (disk), Tauri
  native disk, and **server-proxied WebDAV, S3-compatible, Azure Blob, and Google
  Cloud Storage** — provider credentials never touch the browser.

### AI, MCP & connectors (privacy-first, opt-in, off by default)

- Assistant (summarize / outline / find connections / organize) with a privacy
  spectrum: local → bring-your-own-key → server-side AI proxy (BFF) with
  OpenRouter; keys never in the browser.
- **MCP server** (`@graphvault/mcp`): exposes the vault to external agents over
  stdio — read + conflict-safe write tools, notes as `graphvault://note/<path>`
  **resources**, and ready-made **prompts** (summarize / find-connections /
  search-and-synthesize).
- One-click importers (Obsidian / Notion / Roam / Logseq), email (`.eml`/`.mbox`)
  and RSS/Atom/OPML import, URL web-clipper (SSRF-guarded), a browser extension,
  and a **"connect anything" inbound webhook** with a per-connector audit log.
- **CLI** (`@graphvault/cli`): `list` / `search` / `stats` / `graph` plus a
  read-only local HTTP API (`graphvault serve`).

### Apps, packaging & security

- Installable PWA (offline service worker) and a Tauri 2 desktop shell
  (Win/macOS/Linux installers via CI on `v*` tags).
- Strict CSP, security headers, rate limiting, accessibility pass (WCAG AA), and
  **VPS deployment hardening**: production-config safety preflight, graceful
  shutdown, connection/timeout limits, hardened Docker/compose, and a hardening
  guide (nginx TLS, UFW, fail2ban, systemd).

[0.1.0]: https://github.com/Senior3514/GraphVault/releases/tag/v0.1.0
