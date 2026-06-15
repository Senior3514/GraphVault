# GraphVault

> Local-first notes. Self-hosted sync. A graph you can think in.

Write in plain Markdown, own your data forever, and navigate ideas through a
force-directed graph that actually earns its place in daily thinking — not a
decorative hairball. No account required to start; self-hosted sync is optional.

[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

---

## Why GraphVault?

Most note apps either lock your data behind a proprietary format or make you
choose a folder and grant file-system permissions before you can write a single
word. GraphVault does neither:

- Open the app — your vault is already there.
- Write in plain `.md` files — open them in any editor, export them any time.
- Self-host the sync server on a VPS you control — no subscription, no
  third-party cloud.
- Navigate your ideas through a live graph of notes and links.

---

## Feature highlights

### Markdown vault

- Split / edit / preview toggle (`Cmd/Ctrl+E`) with a `<textarea>` editor —
  Markdown is always first-class.
- `[[wikilink]]` autocomplete as you type; navigating a link to a missing note
  creates it automatically.
- `#tag` autocomplete in the editor; inline `#tags` in the preview are
  clickable filters.
- Backlinks panel shows every note that links to the currently open note.
- Full-text search over the in-memory index; note create, rename, delete;
  autosave with a 400 ms debounce.

### Command palette

Press `Cmd/Ctrl+K` from anywhere in the app:

- Fuzzy-search notes by title or body text.
- Built-in commands: Create note, Navigate to Vault / Graph / Sync / Settings,
  Toggle preview.
- Fully keyboard-driven (arrow keys, Enter, Esc, Tab focus trap).

### Graph view

- Force-directed graph of all notes and their `[[wikilink]]` connections.
- **Global graph** (whole vault) and **local graph** (neighbourhood around the
  selected note, configurable depth).
- Color by node type (note / unresolved target) or by tag; accurate legend.
- Hover: glow + neighbour highlight, dim the rest.
- Click to open the node panel (title, tags, backlinks, "Open note"). Double-
  click to navigate directly to the note.
- Live physics controls: link distance, repel, gravity, label threshold.
- Filters: tags, folders, date ranges, link types; node count capped with a
  visible "capped" badge so the browser never freezes.

### Multi-pane workspace

- Resizable sidebar / editor / details panes with drag dividers.
- Collapse, expand, or maximize any pane; layout is persisted across sessions.
- Editor tabs: open/close/reorder, dirty indicator, "+"; split view
  (editor + preview or two notes side-by-side).
- Per-tab autosave flushes before switch/close/unmount — no lost edits.

### Data portability — no lock-in

- **Export to Markdown `.zip`** — a STORE-method archive of raw `.md` files
  with the original folder structure. Unzip it anywhere; the result is plain
  text readable in any editor.
- **Export to JSON** — a versioned single-file backup
  (`format: "graphvault-vault"`, `version: 1`).
- **Import** from `.zip`, `.json`, `.md`, `.markdown`, or `.txt`.
- Import never overwrites: if a note already exists with different content, the
  incoming note is saved alongside it as a conflict copy.
- Import is hardened against untrusted archives: zip-slip path traversal is
  rejected; per-file size cap 4 MiB; aggregate cap 64 MiB; file-count cap
  10 000.

See [`docs/data-portability.md`](docs/data-portability.md) for the full spec.

### Self-hosted sync

- Content-addressed, conflict-aware sync to a server you run.
- Conflicts are never silently overwritten; the losing side becomes a conflict
  copy visible in the Sync Status page.
- Sync Status page: server health, last sync time, pending change count,
  conflict list.
- Settings → Sync server: enter your server URL and test the connection.

> Sign-in and vault registration from the web client UI are planned; the sync
> server API is fully implemented. See [`docs/sync-protocol.md`](docs/sync-protocol.md).

### Security by default

- No telemetry — the app contacts only the server URL you configure.
- TLS via a reverse proxy (Caddy/nginx); Argon2id password hashing; opaque
  device-bound bearer tokens.
- Optional AES-256-GCM at-rest blob encryption on the server.
- **Browser-side vault encryption** (WebCrypto, passphrase-derived key) is
  implemented as a library; Settings UI to enable it is in progress (Milestone
  15).
- DOMPurify sanitisation of rendered Markdown (XSS protection).

See [`docs/security-model.md`](docs/security-model.md) and
[`docs/security-basics.md`](docs/security-basics.md).

---

## Screenshots / demo

_Screenshots and a demo GIF will be added before the v0.1.0 release. The
landing page at `/` shows a live CSS/SVG preview of the graph._

---

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

The web client persists notes to **browser localStorage**. The Tauri desktop
shell, which will read and write real `.md` files on disk, is tracked as a
planned milestone.

---

## Prerequisites

- **Node.js** ≥ 20 (the Docker image uses Node 22)
- **pnpm** ≥ 9 (`corepack enable` provides the repo-pinned version)
- **Docker** + Compose plugin (for self-hosted deployment only)

---

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

---

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

---

## Deploy the web app to Vercel

The web client is a **fully static Next.js export** — no server runtime
required. It opens straight into a vault backed by browser localStorage. Point
it at a self-hosted server to add multi-device sync.

1. Import the repository as a new Vercel project (production branch `main`).
   Keep **Root Directory** at `./` and the framework preset as **Other**. The
   committed [`vercel.json`](vercel.json) drives the build: it runs
   `pnpm run build:web` (building `shared`, `engine`, and `sync-core` before
   the Next.js app) and serves the static export from `apps/web/out`.
2. _(Optional)_ Set `NEXT_PUBLIC_GRAPHVAULT_SERVER_URL` to your self-hosted
   server URL to enable cloud sync. Leave it unset for a local-only,
   browser-persisted vault.
3. Deploy. The app is available at `/vault`, `/graph`, `/sync-status`, and
   `/settings`. No server runtime is required.

See [`docs/deployment.md`](docs/deployment.md) for details.

---

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

---

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
| 12  | Workspace panes and window controls         | done                                                                         |
| 13  | Command palette and power editing           | done                                                                         |
| 14  | Upgraded graph (physics, highlight, legend) | done                                                                         |
| 15  | Browser-side vault encryption               | partial — crypto library done; Settings UI wiring in progress                |
| 16  | True local desktop (Tauri)                  | planned                                                                      |
| 17  | Polish, onboarding, and launch              | in progress                                                                  |

> The **desktop (Tauri) shell** is a placeholder: the web client stores notes
> in browser localStorage today. Real `.md` filesystem access arrives with the
> Tauri shell. **Sign-in and vault registration** in the web client UI are
> planned; the sync server API is fully implemented. **Browser-side at-rest
> encryption** — the crypto library is shipped; the Settings UI to enable it is
> in progress (Milestone 15).

---

## Contributing

GraphVault is **open-core**: the client and engine are MIT-licensed and
auditable; an optional hosted sync service is the commercial layer. Contributions
to the core (bug fixes, documentation, tests) are welcome. Please open an issue
before starting large changes so we can align on scope.

The project is operated by a specialist agent company documented in
`docs/agent-company/`. Human contributors follow the same ownership matrix and
Definition-of-Done gauntlet described in `docs/agent-company/playbook.md`.

---

## Star us

If GraphVault is useful or interesting to you, a star on GitHub helps others
find it and signals demand for continued development. Thank you.

---

## License

MIT — see [LICENSE](LICENSE).
