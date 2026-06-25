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
- Settings → Sync server: enter your server URL, **sign in / register**, and
  **register a vault** — all wired in the web client UI.

See [`docs/sync-protocol.md`](docs/sync-protocol.md) for the canonical protocol.

### Server-proxied cloud storage

Keep your vault in a cloud bucket **without the browser ever holding the
provider credentials** — the server stores them encrypted at rest and proxies a
single object. Configure any of these in **Settings** after signing in:
**S3-compatible**, **WebDAV**, **Azure Blob Storage**, or **Google Cloud
Storage**. (Drive/OneDrive OAuth are not shipped.) See
[`apps/server/README.md`](apps/server/README.md#server-proxied-cloud-storage-bff).

### Sharing — public graph snapshots

Share a **read-only** snapshot of your graph via a short link (`/embed?id=…`)
instead of a giant URL. This is an **opt-in server feature**, off by default;
an operator enables it with `GRAPHVAULT_SNAPSHOTS_ENABLED=true`. Snapshots are
unauthenticated public shares, so it stays invisible until explicitly turned on.

### AI assistant (bring-your-own-key)

An optional in-app assistant that talks to your AI provider **through the
server**, so the browser never holds the API key. You configure the key in
Settings; the server stores it encrypted at rest and adds it server-side, with a
per-user/day request cap (`GRAPHVAULT_AI_DAILY_CAP`). The assistant shows you
exactly what context it will send before each request.

### MCP server — vault access for agents

[`@graphvault/mcp`](packages/mcp/README.md) is a standalone stdio
[Model Context Protocol](https://modelcontextprotocol.io) server that exposes a
vault to agents (e.g. Claude Desktop): notes as **resources**, read tools
(list/read/search/backlinks/neighbors), one-click **prompts**, and **opt-in,
conflict-safe write tools** (enabled only when a device id is configured — a
concurrent edit is reported as a conflict, never silently overwritten).

### Web clipper + URL clipping

- **Browser extension** ([`apps/extension`](apps/extension/README.md)): a
  Manifest V3 clipper that turns any page or selection into clean Markdown and
  sends it to your vault (zero telemetry, minimal permissions).
- **Server-side URL clip** (`POST /v1/clip`): fetch a URL and convert it to
  Markdown server-side, behind an SSRF guard.

### Inbound webhook — "connect anything"

Mint a per-connector token and let an external service (Zapier, an email
forwarder, a `curl` in cron, …) POST Markdown that lands as a **new note**, with
a per-connector audit log. Inbound posts never overwrite an existing note. On by
default but inert until you mint a token; disable with
`GRAPHVAULT_INBOX_ENABLED=false`. See
[`apps/server/README.md`](apps/server/README.md#connect-anything-inbound-webhook-wave-19).

### Command-line interface

[`@graphvault/cli`](packages/cli/README.md) gives power-user / automation access
to a local vault of `.md` files: `list`, `search`, `stats`, `graph` (`--json`),
and a loopback-only read-only HTTP API (`serve`).

### Light / dark theming

System-aware **light / dark** theming built on CSS-variable design tokens. Pick
`light`, `dark`, or `system` (follows your OS); the choice persists across
sessions.

### Focus mode

A distraction-free editing mode that hides the surrounding app chrome so only
the editor remains — toggleable from the command palette.

### Security by default

- No telemetry — the app contacts only the server URL you configure.
- TLS via a reverse proxy (Caddy/nginx); Argon2id password hashing; opaque
  device-bound bearer tokens.
- Optional AES-256-GCM at-rest blob encryption on the server (key is
  base64-encoded, decoding to exactly 32 bytes).
- **Browser-side vault encryption** — enable it in **Settings → Vault
  encryption**: the local vault store is encrypted at rest with AES-256-GCM, the
  key derived from your passphrase via PBKDF2-SHA-256 (310 000 iterations).
- Cloud-storage and AI credentials are stored **encrypted on the server** and
  never returned to the browser.
- DOMPurify sanitisation of rendered Markdown (XSS protection).
- Production startup **preflight** refuses to boot on an insecure config (open
  CORS, HTTPS disabled, or Postgres without a `DATABASE_URL`).

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
  server/      Fastify + TypeScript sync & API server (auth, vaults, pull/push,
               blobs, cloud-storage proxies, AI proxy, URL clip, snapshots, inbox)
  web/         Next.js (App Router) web client — editor, search, graph UI,
               export/import, AI assistant, sharing; persists to browser
               localStorage today (native .md on disk arrives with the Tauri shell)
  desktop/     Tauri 2 shell wrapping the web client (M16 scaffold; native
               .md-on-disk storage adapter is built but not yet wired end-to-end)
  extension/   Manifest V3 web-clipper (page/selection → Markdown → vault)
packages/
  shared/      Wire types, zod schemas, hashing — single source of truth
  engine/      Graph engine: Markdown parsing, link/tag index, graph queries
  sync-core/   UI-independent sync protocol logic (scan/pull/push/settle)
  cli/         Command-line vault tooling (list/search/stats/graph/serve)
  mcp/         Stdio MCP server exposing a vault to agents (read + opt-in writes)
docs/
  quickstart.md         First-run guide
  data-portability.md   Export/import formats, guarantees, security guards
  security-model.md     Threat model summary (client + server)
  sync-protocol.md      Canonical sync protocol spec
  security-basics.md    Server security model and hardening checklist
  deployment.md         Self-hosting with Docker Compose
  hardening.md          VPS hardening checklist
docker/
  server.Dockerfile     Multi-stage build for @graphvault/server
docker-compose.yml      server + PostgreSQL stack
vercel.json             Static-export build config for Vercel
```

The server stores **bytes and revisions** and stays ignorant of note semantics.
Intelligence — links, graph, search — lives client-side in
`@graphvault/engine`. The graph view is the hero surface of the client.

The web client persists notes to **browser localStorage** (or an encrypted store
when vault encryption is on). A **Tauri 2 desktop shell** wraps the same web
client; its native `.md`-on-disk storage adapter is built against the existing
`StorageAdapter` seam but not yet wired end-to-end — see
[`apps/desktop/README.md`](apps/desktop/README.md).

---

## Prerequisites

- **Node.js** ≥ 20 (the Docker image uses Node 22)
- **pnpm** ≥ 9 (`corepack enable` provides the repo-pinned version)
- **Docker** + Compose plugin (for self-hosted deployment only)

---

## Install — one command per surface

GraphVault runs everywhere, with a single command for each surface:

| Surface                           | Command                                   | Notes                                                                                                                                                       |
| --------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Use the web app**               | _(none — just open the URL)_              | Static export; runs in any modern browser on any OS.                                                                                                        |
| **Self-host the sync server**     | `docker compose up -d --build`            | Brings up the server + PostgreSQL. Linux/macOS/Windows with Docker.                                                                                         |
| **Desktop app** (Win/macOS/Linux) | `pnpm --filter @graphvault/desktop build` | Builds the Tauri shell into native installers (requires the Rust toolchain). The shell runs today; native `.md`-on-disk storage is still being wired (M16). |

The web client is **local-first** — it works fully offline with no account; the
sync server is optional and only needed for multi-device sync.

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

Build the full web stack (shared packages first, then the Next.js app). The
`-w` runs the script at the workspace root regardless of your current directory:

```bash
pnpm -w run build:web
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
   `pnpm -w run build:web` (building `shared`, `engine`, and `sync-core` before
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
| [`docs/security-model.md`](docs/security-model.md)     | Threat model: local-first, XSS, import hardening, at-rest encryption |
| [`docs/sync-protocol.md`](docs/sync-protocol.md)       | Canonical sync protocol spec                                         |
| [`docs/security-basics.md`](docs/security-basics.md)   | Server security model and hardening checklist                        |
| [`docs/deployment.md`](docs/deployment.md)             | Self-hosting with Docker Compose                                     |
| [`docs/hardening.md`](docs/hardening.md)               | VPS hardening checklist (TLS, firewall, systemd, backups)            |
| [`apps/server/README.md`](apps/server/README.md)       | Server env reference + all API routes (storage, AI, clip, inbox)     |
| [`packages/mcp/README.md`](packages/mcp/README.md)     | MCP server: tools, resources, prompts, Claude Desktop setup          |
| [`packages/cli/README.md`](packages/cli/README.md)     | CLI: list / search / stats / graph / serve                           |
| [`apps/extension/README.md`](apps/extension/README.md) | Web-clipper browser extension                                        |
| [`DESIGN.md`](DESIGN.md)                               | Product and architecture direction                                   |
| [`CLAUDE.md`](CLAUDE.md)                               | Project scope and agent-company rules                                |

---

## Milestones

| #   | Milestone                                          | Status                                                                       |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| 0   | Repo bootstrap                                     | done                                                                         |
| 1   | Sync protocol design                               | done (draft spec)                                                            |
| 2   | Server scaffold (auth + sync)                      | done                                                                         |
| 3   | Web scaffold                                       | done                                                                         |
| 4   | Local vault + Markdown editing                     | done                                                                         |
| 5   | Sync end-to-end                                    | done                                                                         |
| 6   | Graph engine (indexing + API)                      | done                                                                         |
| 7   | Graph UI v1                                        | done                                                                         |
| 8   | Security and settings                              | done                                                                         |
| 9   | Docker and packaging                               | done                                                                         |
| 10  | Docs                                               | done                                                                         |
| 11  | Portability (export/import)                        | partial — zip/json/md done; drag-and-drop and File System Access API planned |
| 12  | Workspace panes and window controls                | done                                                                         |
| 13  | Command palette and power editing                  | done                                                                         |
| 14  | Upgraded graph (physics, highlight, legend)        | done                                                                         |
| 15  | Browser-side vault encryption                      | done — Settings → Vault encryption (PBKDF2 + AES-256-GCM)                    |
| 16  | True local desktop (Tauri)                         | partial — Tauri shell runs; native `.md`-on-disk adapter not yet wired       |
| 18  | Server-proxied cloud storage (S3/WebDAV/Azure/GCS) | done                                                                         |
| 22  | AI proxy + URL/web clipper + MCP server            | done                                                                         |
| —   | Public graph snapshots / embed                     | done (opt-in, off by default)                                                |
| —   | Inbound webhook / inbox + audit log                | done (on by default; inert until a token is minted)                          |
| —   | Light/dark theming, focus mode                     | done                                                                         |
| 17  | Polish, onboarding, and launch                     | in progress                                                                  |

> **What's genuinely still in progress:** the **Tauri desktop shell** runs and
> wraps the web client, but its native `.md`-on-disk storage adapter is built
> against the storage seam and **not yet wired end-to-end** — the web client
> still persists to browser localStorage. **Drive/OneDrive OAuth** cloud
> backends are **not** shipped (S3, WebDAV, Azure Blob, and GCS are).

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
