# GraphVault

> Local-first notes. Self-hosted sync. A graph you can think in.

GraphVault is a local-first Markdown notes / PKM app with:

- **Plain Markdown files on disk** — your vault is just a folder of `.md` files.
  No lock-in; open it with any editor.
- **Self-hosted sync** — a small server you run on your own VPS or NAS. No
  subscription, no third-party cloud.
- **A graph view built for thinking** — filters, typed relations, local & global
  views, and good performance on thousands of notes.
- **Security by default** — TLS via a reverse proxy, Argon2id password hashing,
  device-bound bearer tokens, optional at-rest blob encryption, and no
  telemetry.

This repository contains the **v0** implementation. It is built incrementally;
see [Milestones](#milestones) for honest, current status.

## Features (v0)

- **Markdown-first editing** with `[[wikilinks]]`, backlinks, and full-text
  search over a local index (web client).
- **Content-addressed, conflict-aware sync** to a self-hosted server, with
  deterministic conflict detection and conflict copies that guarantee **no
  silent data loss** (see [`docs/sync-protocol.md`](docs/sync-protocol.md)).
- **A graph engine** (`@graphvault/engine`) that parses Markdown, indexes
  links/tags, and answers local & global graph queries — decoupled from the UI.
- **Pluggable server storage**: in-memory (dev/test) or PostgreSQL (production),
  with blob bytes stored content-addressed on disk.
- **Self-hosting via Docker Compose**, with optional AES-256-GCM at-rest blob
  encryption and a reverse-proxy TLS model.

## Architecture

GraphVault keeps its **engine, sync, and indexing decoupled from the UI** so the
web app, the future desktop shell, and other tooling can share them.

```
apps/
  server/    Fastify + TypeScript sync & API server (auth, vaults, pull/push, blobs)
  web/       Next.js (App Router) web client: editor, search, graph UI
  desktop/   Tauri/Electron wrapper around the web client (placeholder)
packages/
  shared/    Wire types, zod validation, hashing — the single source of truth
  engine/    Graph engine: markdown parsing, link/tag index, graph queries
  sync-core/ UI-independent sync protocol logic (scan / pull / push / settle)
docs/
  sync-protocol.md    Canonical sync protocol spec
  security-basics.md  Security model: TLS, auth, encryption, backups
  deployment.md       Self-hosting with Docker Compose
docker/
  server.Dockerfile   Multi-stage build for @graphvault/server
docker-compose.yml    server + PostgreSQL stack
CLAUDE.md    Project rules: what to build, what not to build
DESIGN.md    Design direction summary
```

The server stores **bytes and revisions** and stays ignorant of note semantics;
intelligence (links, graph, search) lives client-side in `@graphvault/engine`.
The graph view is the **hero surface** of the client.

## Prerequisites

- **Node.js** ≥ 20 (the Docker image uses Node 22)
- **pnpm** ≥ 9 (`corepack enable` will provide the repo-pinned version)
- **Docker** + the Compose plugin (for self-hosted deployment)

## Quickstart — local development

```bash
# Install all workspace dependencies
pnpm install

# Type-check, lint, format
pnpm typecheck
pnpm lint
pnpm format:check

# Run the sync server (http://127.0.0.1:4000), in-memory storage by default
pnpm --filter @graphvault/server dev

# In another terminal, run the web client (http://localhost:3000)
pnpm --filter @graphvault/web dev
```

Validate the server is up:

```bash
curl http://127.0.0.1:4000/v1/health
# { "status": "ok", "apiVersion": "v1", "syncProtocolVersion": 1, ... }
```

Configuration is via environment variables — copy the `.env.example` files:

```bash
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env.local
```

See [`apps/server/README.md`](apps/server/README.md) for the full server env
reference and the PostgreSQL backend.

## Quickstart — self-hosted (Docker)

Run the server backed by PostgreSQL with durable on-disk blob storage:

```bash
cp docker/env.example .env      # set a strong POSTGRES_PASSWORD, CORS origin, etc.
docker compose up -d --build
curl http://127.0.0.1:4000/v1/health
```

Create the first user:

```bash
curl -X POST http://127.0.0.1:4000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-strong-passphrase","deviceName":"laptop"}'
```

Put a TLS-terminating reverse proxy (Caddy/nginx) in front before exposing it
publicly. Full instructions — env reference, TLS, backups, restore, upgrades —
are in [`docs/deployment.md`](docs/deployment.md).

## Documentation

- [`docs/sync-protocol.md`](docs/sync-protocol.md) — canonical sync protocol.
- [`docs/security-basics.md`](docs/security-basics.md) — security model and
  hardening checklist.
- [`docs/deployment.md`](docs/deployment.md) — self-hosting with Docker Compose.
- [`DESIGN.md`](DESIGN.md) — product and design direction.
- [`CLAUDE.md`](CLAUDE.md) — project scope rules.

## Milestones

| #   | Milestone                      | Status         |
| --- | ------------------------------ | -------------- |
| 0   | Repo bootstrap                 | ✅ done        |
| 1   | Sync protocol design           | ✅ draft spec  |
| 2   | Server scaffold (auth + sync)  | ✅ done        |
| 3   | Web scaffold                   | ✅ done        |
| 4   | Local vault + markdown editing | ✅ done        |
| 5   | Sync end-to-end                | 🚧 in progress |
| 6   | Graph engine (indexing + API)  | ✅ done        |
| 7   | Graph UI v1                    | 🚧 in progress |
| 8   | Security & settings            | 🚧 in progress |
| 9   | Docker & packaging             | ✅ done        |
| 10  | Docs                           | ✅ done        |

> The **desktop (Tauri) shell** remains a placeholder. The web vault persists to
> the browser store today; real `.md` filesystem access arrives with the desktop
> shell. Milestones 5, 7, and 8 are landing in parallel; the deployment and
> security docs describe their intended, documented behavior (e.g. the
> `GRAPHVAULT_ENCRYPTION_KEY` at-rest encryption and rate limiting from M8).

## License

MIT
