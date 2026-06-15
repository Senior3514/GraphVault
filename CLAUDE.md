# CLAUDE.md — GraphVault project rules

This file orients any contributor (human or AI) working in this repo. Read it
before making changes.

## Mission

Build **v0** of GraphVault: a local-first Markdown note app with self-hosted
sync and a powerful, dynamic graph view.

Core promises:

- Plain Markdown files on disk — **no lock-in**.
- Simple, secure **self-hosted** sync on any VPS.
- A graph view that is **actually usable for thinking**, not just pretty.
- Fast, responsive, **security-conscious** UX.

## Working style

- **Inspect the repo before changing it.** Never restart from scratch if code
  exists; work incrementally in milestones.
- Keep the engine (sync, indexing, graph) **decoupled from the UI** so it can be
  reused later.
- Prefer plain, auditable solutions over cleverness. This is a security- and
  data-integrity-sensitive app: **never silently lose user data.**
- Match the style, naming, and structure of surrounding code.

At the end of each milestone, report:

1. summary of changes
2. files created/updated
3. how to run/test
4. suggested git commit message
5. next milestone

## Non-goals for v0 (do NOT build these)

- ❌ Mobile clients (desktop + web only).
- ❌ AI features.
- ❌ Plugin marketplace.
- ❌ Public multi-user collaboration (single user / small trusted team is enough).
- ❌ WYSIWYG-only editor — **Markdown is first-class**.

## Tech stack

- **Monorepo:** pnpm workspaces.
- **Backend:** Node.js + TypeScript + Fastify + PostgreSQL + disk file storage.
- **Web client:** Next.js (App Router) + React + TypeScript + Tailwind CSS.
- **Desktop:** Tauri (preferred) or Electron wrapping the web client.
- **Graph rendering:** React + a force/graph layout library.
- **Local indexing:** SQLite or in-memory index for search and graph.

## Repository structure

```
apps/server   apps/web   apps/desktop
packages/shared   packages/sync-core
docs/   scripts/   docker/
README.md   CLAUDE.md   DESIGN.md
```

## Conventions

- TypeScript everywhere; shared wire types live in `@graphvault/shared` and are
  the single source of truth (kept in sync with `docs/sync-protocol.md`).
- Validate all external input with zod schemas from `@graphvault/shared`.
- Configuration via environment variables only; no hardcoded secrets.
- No external telemetry by default.
- Conventional, descriptive commit messages.

## Milestones

0. Repo bootstrap ✅
1. Sync protocol design ✅ (draft)
2. Server scaffold (auth + health)
3. Web + desktop scaffold
4. Local vault + Markdown editing
5. Sync end-to-end
6. Graph engine (indexing + API)
7. Graph UI v1
8. Security & settings
9. Docker & packaging
10. Docs
