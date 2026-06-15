# DESIGN.md — GraphVault design direction

This is a high-level design summary. Detailed specs live in `docs/`.

## Product in one line

> Local-first notes. Self-hosted sync. A graph you can think in.

GraphVault is for people who want Obsidian-style local Markdown notes but with
**sync they fully own** and a **graph view that earns its place** in daily
thinking — not a decorative hairball.

## Design principles

1. **Your files, not ours.** A vault is a plain folder of `.md` files plus an
   optional `.graphvault/` metadata folder. Everything degrades gracefully to
   "just text files." No proprietary database is required to read your notes.
2. **Self-hosted, no lock-in, no subscription.** Sync is a small server the user
   runs. The protocol is open and documented (`docs/sync-protocol.md`).
3. **Never lose data.** Conflicts are made visible and preserved as side-by-side
   files; the app never silently overwrites.
4. **Fast and quiet.** Snappy editing and search; no telemetry by default;
   minimal background chatter.
5. **A graph for thinking.** The graph is a first-class navigation and sense-
   making tool, with filters, typed relations, and good performance at scale.

## Experience pillars

### Editing

- Markdown-first. Split-pane or toggled editor + preview.
- `[[wikilink]]` autocomplete, backlinks panel, tags via YAML frontmatter or
  inline `#tags`.
- Fast title + full-text search over the local index.

### Sync

- One-click connect to a self-hosted server; per-device tokens.
- Clear sync status: last sync time, pending changes, conflicts list.
- Conflicts surfaced explicitly with side-by-side copies to merge.

### Graph

- **Local graph** around the current note (configurable depth) and a **global
  graph**.
- Filters: tags, folders, date ranges, link types.
- Layouts: force-directed (default) and radial.
- Smooth pan/zoom; node/edge culling and sensible limits on huge graphs with
  clear messaging rather than freezing.
- Selection opens a side panel: title, tags, backlinks, "open note".

## Visual direction

- Calm, dark-first, high-contrast, content-forward UI.
- The graph is the hero surface: legible typography on nodes, restrained color
  used to encode meaning (tags / link types), not decoration.
- Tailwind CSS for a consistent, themeable system.

## Architecture stance

- Keep the **sync core** (`@graphvault/sync-core`), **indexer**, and **graph
  engine** (`@graphvault/engine`) as UI-independent libraries so the desktop
  app, web app, and future tooling can share them. The graph engine is the
  client-side brain behind the hero graph surface.
- The server stores bytes and revisions; it stays ignorant of note semantics.
  Intelligence (links, graph, search) lives client-side.

## Security & operations stance

- **Self-hosted by design.** The server is packaged as a small Docker image and
  a Compose stack (server + PostgreSQL + on-disk blob storage). It speaks plain
  HTTP and runs **behind a TLS-terminating reverse proxy** (Caddy/nginx).
- **Defense in depth, plainly.** Argon2id password hashing, opaque
  device-bound bearer tokens, per-request vault ownership checks, rate limiting,
  and optional AES-256-GCM at-rest blob encryption — content addressing is over
  the plaintext, so encryption never changes the wire protocol.
- **No telemetry, never lose data.** No outbound calls by default; conflicts are
  preserved as side-by-side copies, never silently overwritten.

See `docs/sync-protocol.md` for the sync design, `docs/security-basics.md` for
the security model, `docs/deployment.md` for self-hosting, and `CLAUDE.md` for
build scope.
