# DESIGN.md - GraphVault design direction

This is a high-level design summary. Detailed specs live in `docs/`.

## Product in one line

> Local-first notes. Self-hosted sync. A graph you can think in.

GraphVault is for people who want Obsidian-style local Markdown notes but with
**sync they fully own** and a **graph view that earns its place** in daily
thinking - not a decorative hairball.

## Design principles

1. **Your files, not ours.** A vault is a plain folder of `.md` files plus an
   optional `.graphvault/` metadata folder. Everything degrades gracefully to
   "just text files." No proprietary database is required to read your notes.
2. **Self-hosted, no lock-in, no subscription.** Sync is a small server the
   user runs. The protocol is open and documented (`docs/sync-protocol.md`).
3. **Never lose data.** Conflicts are made visible and preserved as
   side-by-side files; the app never silently overwrites. Import also never
   overwrites: existing notes with different content are kept alongside the
   incoming copy.
4. **Fast and quiet.** Snappy editing and search; no telemetry by default;
   minimal background chatter.
5. **A graph for thinking.** The graph is a first-class navigation and
   sense-making tool, with filters, typed relations, and good performance at
   scale.
6. **Open-core.** The client and engine are open and auditable. Optional
   hosted sync is the commercial layer. For a local-first app, data access
   comes from local Markdown + export - closed source would only reduce trust.

## Experience pillars

### Editing

- Markdown-first. Split / edit / preview toggle (Cmd/Ctrl+E).
- `[[wikilink]]` autocomplete and `#tag` autocomplete in the editor.
- Backlinks panel surfaced automatically.
- Fast title + full-text search over the local in-memory index.
- Command palette (Cmd/Ctrl+K): quick-open notes, run commands, navigate.

### Sync

- One self-hosted server; per-device tokens.
- Clear sync status: last sync time, pending changes, conflicts list.
- Conflicts surfaced explicitly as side-by-side conflict copies.
- Sign-in and vault registration in the web client UI are planned; the server
  API is complete.

### Graph

- **Local graph** around the current note (configurable depth) and a **global
  graph**.
- Filters: tags, folders, date ranges, link types.
- Force-directed layout with live physics controls.
- Smooth pan/zoom; degree-scaled nodes; node/edge count cap with a visible
  badge rather than browser freeze.
- Color by node type (note / unresolved) or by tag; accurate legend.
- Hover glow + neighbour highlight; click opens a selection panel with title,
  tags, backlinks, and "open note"; double-click navigates directly.

### Data portability

- Export the vault as a Markdown `.zip` (STORE method - unzip to plain `.md`
  files) or a versioned JSON backup.
- Import from `.zip`, `.json`, `.md`, `.markdown`, or `.txt`.
- Import is lossless and collision-safe: never overwrites, creates conflict
  copies instead. Hardened against zip-slip and archive bombs.

## Visual direction

- Calm, dark-first, high-contrast, content-forward UI.
- The graph is the hero surface: legible typography on nodes, restrained color
  used to encode meaning (tags / link types), not decoration.
- Tailwind CSS for a consistent, themeable system.
- Decorative animations are gated behind `motion-safe:` / `motion-reduce:` so
  `prefers-reduced-motion` is always honored.

## Architecture stance

### Engine decoupled from UI

The **sync core** (`@graphvault/sync-core`), **graph engine**
(`@graphvault/engine`), and **shared wire types** (`@graphvault/shared`) are
UI-independent libraries. The web app, the planned desktop shell, and any
future tooling can share them without rewriting.

### Browser storage seam

The web client stores notes in **browser localStorage** today. A storage seam
(`VaultProvider` + adapters) means the desktop Tauri shell will swap in real
filesystem reads/writes without touching the editor, graph, or sync logic.

### Server stores bytes; intelligence lives client-side

The sync server stores bytes, revisions, and blob metadata. It is deliberately
ignorant of note semantics. Parsing Markdown, computing the link/tag index, and
answering graph queries are all done client-side by `@graphvault/engine`.

### Portability formats

Two interchange formats are shipped, both plain and auditable:

- **Markdown ZIP** (STORE method, no compression): a `.zip` of raw `.md` files
  with folder structure preserved. Round-trips byte-for-byte; readable with any
  unzip tool. The dependency-free writer lives in
  `apps/web/lib/vault/portability.ts`.
- **JSON**: a single versioned envelope (`format: "graphvault-vault"`,
  `version: 1`) with content and timestamps. Handy for programmatic transfer
  and one-file backups.

## Security and operations stance

- **Self-hosted by design.** The server runs as a small Docker image behind a
  TLS-terminating reverse proxy (Caddy/nginx).
- **Defense in depth, plainly.** Argon2id password hashing; opaque
  device-bound bearer tokens; per-request vault ownership checks; rate
  limiting; optional AES-256-GCM at-rest blob encryption. Content addressing
  is computed over the plaintext, so encryption never changes the wire
  protocol.
- **No telemetry, never lose data.** No outbound calls by default; conflicts
  and import collisions are preserved as side-by-side copies, never silently
  overwritten.
- **Import is a security boundary.** Untrusted archives are validated for
  zip-slip traversal, per-file size, aggregate size, and file count before any
  content is written.
- **Planned: browser-side vault encryption.** WebCrypto passphrase encryption
  of the browser vault (Milestone 15); E2E key management for the sync server
  (tracked as an open question in `docs/sync-protocol.md §9`).

See `docs/sync-protocol.md` for the sync design, `docs/security-model.md` for
the full threat model, `docs/security-basics.md` for the server hardening
checklist, `docs/data-portability.md` for export/import guarantees, and
`CLAUDE.md` for build scope.
