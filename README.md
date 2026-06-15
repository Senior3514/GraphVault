# GraphVault

> Local-first notes. Self-hosted sync. A graph you can think in.

GraphVault is a local-first Markdown notes / PKM app with:

- **Plain Markdown files on disk** — your vault is just a folder of `.md` files.
  No lock-in; open it with any editor.
- **Self-hosted sync** — a small server you run on your own VPS or NAS. No
  subscription, no third-party cloud.
- **A graph view built for thinking** — filters, typed relations, local & global
  views, and good performance on thousands of notes.
- **Security by default** — encrypted transport, optional at-rest and end-to-end
  encryption, and no telemetry.

This repository contains the **v0** implementation. It is being built
incrementally; see [Milestones](#milestones) for status.

## Repository layout

```
apps/
  server/    Fastify + TypeScript sync & API server
  web/       Next.js (App Router) web client
  desktop/   Tauri/Electron wrapper around the web client (placeholder)
packages/
  shared/    Shared types, zod validation, and utilities (incl. sync wire types)
  engine/    Graph engine: markdown parsing, link/tag index, graph queries
  sync-core/ Sync protocol logic (added in a later milestone)
docs/
  sync-protocol.md   Canonical sync protocol spec
scripts/
docker/
CLAUDE.md    Project rules: what to build, what not to build
DESIGN.md    Design direction summary
```

## Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 9 (`corepack enable` will provide it)

## Quickstart

```bash
# Install all workspace dependencies
pnpm install

# Type-check, lint, format
pnpm typecheck
pnpm lint
pnpm format:check

# Run the sync server (http://127.0.0.1:4000)
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

## Milestones

| #   | Milestone                      | Status        |
| --- | ------------------------------ | ------------- |
| 0   | Repo bootstrap                 | ✅ done       |
| 1   | Sync protocol design           | ✅ draft spec |
| 2   | Server scaffold (auth + sync)  | ✅ done       |
| 3   | Web scaffold                   | ✅ web done   |
| 4   | Local vault + markdown editing | ✅ done       |
| 5   | Sync end-to-end                | ⏳ next       |
| 6   | Graph engine (indexing + API)  | ✅ done       |
| 7   | Graph UI v1                    | ⏳            |
| 8   | Security & settings            | ⏳            |
| 9   | Docker & packaging             | ⏳            |
| 10  | Docs                           | ⏳            |

> Desktop (Tauri) shell and the graph UI consuming `@graphvault/engine` remain
> for later milestones. The web vault persists to the browser store today; real
> `.md` filesystem access arrives with the desktop shell.

See [`docs/sync-protocol.md`](docs/sync-protocol.md) for the sync design and
[`CLAUDE.md`](CLAUDE.md) for project scope rules.

## License

MIT
