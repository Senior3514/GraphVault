# GraphVault

> Local-first notes. Self-hosted sync. A graph you can think in.

GraphVault is a local-first Markdown notes / PKM app. It opens straight into
your vault — no folder picker, no file-system permissions — and gives you a
graph view that is actually useful for navigating ideas.

- **Plain Markdown on disk** — your vault is a folder of `.md` files. No
  lock-in; open it in any editor. Export to a standard `.zip` of `.md` files
  anytime.
- **Self-hosted sync** — a small server you run on your own VPS or NAS. No
  subscription, no third-party cloud.
- **A graph view built for thinking** — filters, typed relations, local and
  global views, good performance on thousands of notes.
- **Security by default** — no telemetry, TLS via a reverse proxy, Argon2id
  password hashing, device-bound bearer tokens, and optional at-rest blob
  encryption.
- **Open-core** — the client and engine are open and auditable; optional
  hosted sync is the commercial layer.

This repository contains the **v0** implementation. See
[Milestones](#milestones) for the honest current status.

## Feature set (shipped)

### Vault and editor

- Markdown-first editing with split / edit / preview view toggle (Cmd/Ctrl+E).
- `[[wikilink]]` autocomplete as you type: shows matching note titles, creates
  a new note on navigate if the target does not exist.
- `#tag` autocomplete in the editor; inline `#tags` in the preview are
  clickable filters.
- Backlinks panel: shows every note that links to the currently open note.
- Full-text search over the local in-memory index.
- Note create, rename, delete; autosave with a 400 ms debounce.
- Tag cloud in the sidebar; tag-filtered note list.
- Deep-link from the graph to a note (`/vault?note=<path>`).

### Command palette

- Press Cmd/Ctrl+K anywhere in the app to open the command palette.
- Quick-open any note by title or body text (fuzzy-matched).
- Actions: create note, navigate to Vault / Graph / Sync / Settings, toggle
  preview pane.
- Fully keyboard-driven: arrow keys, Enter, Esc, Tab for focus trap.

### Graph view

- Force-directed graph of all notes and their `[[wikilink]]` connections.
- **Global graph** (whole vault) and **local graph** (neighbourhood around the
  selected note, configurable depth).
- Color by node type (note / unresolved target) or by tag.
- Hover: glow + neighbour highlight, dim the rest.
- Click to select and open the node panel (title, tags, backlinks, "open
  note"). Double-click to navigate directly to the note.
- Live physics controls: link distance, repel, gravity, label threshold.
- Zoom-to-fit, reset view; degree-scaled node sizes; reduced-motion aware.
- Filters: tags, folders, date ranges, link types; node count capped with a
  visible "capped" badge rather than freezing the browser.

### Data portability (export / import)

- **Export to Markdown `.zip`** — a STORE-method `.zip` of the raw `.md`
  files with the original folder structure. Unzip it and the notes are plain
  text, readable anywhere.
- **Export to JSON** — a versioned single-file backup (format
  `graphvault-vault`, version 1) with content and timestamps.
- **Import** from `.zip`, `.json`, `.md`, `.markdown`, or `.txt`.
- Import never overwrites: if a note already exists with different content,
  the incoming note is saved alongside it as a conflict copy.
- Import is hardened against untrusted archives: zip-slip path traversal is
  rejected, per-file size cap 4 MiB, aggregate cap 64 MiB, file-count cap
  10 000.

See [`docs/data-portability.md`](docs/data-portability.md) for the full spec.

### Sync (self-hosted server)

- Content-addressed, conflict-aware sync to a self-hosted server.
- Deterministic conflict detection: never silently overwrites; the losing side
  becomes a conflict copy visible in the Sync Status page.
- Sync Status page: server health, last sync time, pending change count,
  conflicts list.
- Sign-in and vault registration from the web client UI are planned; the sync
  server API is fully implemented.

### Settings

- Configure the self-hosted server URL (overrides the env default); test the
  connection with a live health check.
- Vault stats: note count, total content size, storage backend.
- Import and export controls.
- Privacy: no telemetry; the app only contacts the server URL you configure.

## Architecture

GraphVault keeps its **engine, sync, and indexing decoupled from the UI** so
the web app, a future desktop shell, and other tooling can share them.

```
apps/
  server/      Fastify + TypeScript sync & API server
               (auth, vaults, pull/push, blobs)
  web/         Next.js (App Router) web client
               editor, search, graph UI, export/import
               persists to browser localStorage today;
               real .md filesystem access arrives with the Tauri shell
  desktop/     Tauri shell around the web client — placeholder, not yet built
packages/
  shared/      Wire types, zod schemas, hashing — single source of truth
  engine/      Graph engine: Markdown parsing, link/tag index, graph queries
  sync-core/   UI-independent sync protocol logic (scan/pull/push/settle)
docs/
  quickstart.md         First-run guide
  data-portability.md   Export/import formats, guarantees, security guards
  security-model.md     Threat model summary (client + server)
  sync-protocol.md      Canonical sync protocol spec
  security-basics.md    Server security model and hardening checklist
  deployment.md         Self-hosting with Docker Compose
docker/
  server.Dockerfile     Multi-stage build for @graphvault/server
docker-compose.yml      server + PostgreSQL stack
vercel.json             Static-export build config for Vercel
```

The server stores **bytes and revisions** and stays ignorant of note semantics.
Intelligence — links, graph, search — lives client-side in
`@graphvault/engine`. The graph view is the hero surface of the client.

The web client persists notes to **browser localStorage**. The desktop Tauri
shell, which will read and write real `.md` files on disk, is tracked as a
planned milestone.

## Prerequisites

- **Node.js** ≥ 20 (the Docker image uses Node 22)
- **pnpm** ≥ 9 (`corepack enable` provides the repo-pinned version)
- **Docker** + Compose plugin (for self-hosted deployment only)

## Quickstart — local development

```bash
# Install all workspace dependencies
pnpm install

# Run the sync server (http://127.0.0.1:4000), in-memory storage by default
pnpm --filter @graphvault/server dev

# In another terminal, run the web client (http://localhost:3000)
pnpm --filter @graphvault/web dev
```

Verify the server is up:

```bash
curl http://127.0.0.1:4000/v1/health
# { "status": "ok", "apiVersion": "v1", "syncProtocolVersion": 1, ... }
```

Copy the env example files before editing:

```bash
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env.local
```

Type-check, lint, and format:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
```

Build the full web stack (shared packages first, then the Next.js app):

```bash
pnpm run build:web
```

See [`apps/server/README.md`](apps/server/README.md) for the full server env
reference and PostgreSQL backend setup.

## Quickstart — self-hosted (Docker)

```bash
cp docker/env.example .env      # set POSTGRES_PASSWORD, CORS origin, etc.
docker compose up -d --build
curl http://127.0.0.1:4000/v1/health
```

Create the first user:

```bash
curl -X POST http://127.0.0.1:4000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-strong-passphrase","deviceName":"laptop"}'
```

Put a TLS-terminating reverse proxy (Caddy or nginx) in front before exposing
the server publicly. Full instructions — env reference, TLS, backups, restore,
upgrades — are in [`docs/deployment.md`](docs/deployment.md).

## Deploy the web app to Vercel

The web client is a **fully static Next.js export** — no server runtime
required. It opens straight into a vault backed by browser localStorage. Point
it at a self-hosted server to add multi-device sync.

1. Import `Senior3514/GraphVault` as a new Vercel project (production branch
   `main`). Keep **Root Directory** at `./` and framework preset as **Other**.
   The committed [`vercel.json`](vercel.json) drives the build: it runs
   `pnpm run build:web` (building `shared`, `engine`, and `sync-core` before
   the Next.js app) and serves the static export from `apps/web/out`.
2. _(Optional)_ Set `NEXT_PUBLIC_GRAPHVAULT_SERVER_URL` to your self-hosted
   server URL to enable cloud sync. Leave it unset for a local-only,
   browser-persisted vault.
3. Deploy. The app is available at `/vault`, `/graph`, `/sync-status`, and
   `/settings`. No server runtime is required.

See [`docs/deployment.md`](docs/deployment.md) for details.

## Documentation

| Doc                                                    | What it covers                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| [`docs/quickstart.md`](docs/quickstart.md)             | First run: write, link, graph, export                                |
| [`docs/data-portability.md`](docs/data-portability.md) | Export/import formats, guarantees, security guards                   |
| [`docs/security-model.md`](docs/security-model.md)     | Threat model: local-first, XSS, import hardening, planned encryption |
| [`docs/sync-protocol.md`](docs/sync-protocol.md)       | Canonical sync protocol spec                                         |
| [`docs/security-basics.md`](docs/security-basics.md)   | Server security model and hardening checklist                        |
| [`docs/deployment.md`](docs/deployment.md)             | Self-hosting with Docker Compose                                     |
| [`DESIGN.md`](DESIGN.md)                               | Product and architecture direction                                   |
| [`CLAUDE.md`](CLAUDE.md)                               | Project scope and agent-company rules                                |

## Milestones

| #   | Milestone                                   | Status                                                                       |
| --- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| 0   | Repo bootstrap                              | done                                                                         |
| 1   | Sync protocol design                        | done (draft spec)                                                            |
| 2   | Server scaffold (auth + sync)               | done                                                                         |
| 3   | Web scaffold                                | done                                                                         |
| 4   | Local vault + Markdown editing              | done                                                                         |
| 5   | Sync end-to-end                             | done                                                                         |
| 6   | Graph engine (indexing + API)               | done                                                                         |
| 7   | Graph UI v1                                 | done                                                                         |
| 8   | Security and settings                       | done                                                                         |
| 9   | Docker and packaging                        | done                                                                         |
| 10  | Docs                                        | done                                                                         |
| 11  | Portability (export/import)                 | partial — zip/json/md done; drag-and-drop and File System Access API planned |
| 13  | Command palette and power editing           | done                                                                         |
| 14  | Upgraded graph (physics, highlight, legend) | done                                                                         |
| 12  | Workspace panes and window controls         | planned                                                                      |
| 15  | Browser-side vault encryption               | planned                                                                      |
| 16  | True local desktop (Tauri)                  | planned                                                                      |
| 17  | Polish, onboarding, and launch              | in progress                                                                  |

> The **desktop (Tauri) shell** is a placeholder: the web client stores notes
> in browser localStorage today. Real `.md` filesystem access arrives with the
> Tauri shell. **Sign-in and vault registration** in the web client UI are
> planned; the sync server API is fully implemented. **Browser-side at-rest
> encryption** is planned (Milestone 15).

## License

MIT
