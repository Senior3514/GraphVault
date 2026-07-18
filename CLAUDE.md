# CLAUDE.md - GraphVault project rules

This file orients any contributor (human or AI) working in this repo. Read it
before making changes.

## Mission

Build **v0** of GraphVault: a local-first Markdown note app with self-hosted
sync and a powerful, dynamic graph view.

Core promises:

- Plain Markdown files on disk - **no lock-in**.
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

- ❌ Mobile clients (desktop + web only; the web app is fully responsive).
- ❌ Plugin marketplace.
- ❌ Public multi-user collaboration (single user / small trusted team is enough).
- ❌ WYSIWYG-only editor - **Markdown is first-class**.

> **Direction update (owner, post-v0):** AI features and external connectors
> (email, cloud storage, etc.) are now **in scope** - but only **privacy-first**:
> opt-in, **off by default**, with a privacy spectrum (local/on-device model →
> bring-your-own-key → never hosted-by-us by default). Note content must never
> leave the device unless the user explicitly enables a provider. This preserves
> the local-first, zero-telemetry promise. See `docs/ROADMAP.md` M21-M22.

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

## Backend DNA (owner directive - apply silently on every backend change)

Before shipping or modifying any backend component (`apps/server/`, any proxy
route, any service that calls a third party or does heavy work), confirm all
three - not as a one-time pass, but as a standing habit for every future change:

1. **Rate limiting** - is this endpoint protected against high-frequency abuse?
   Token-bucket/leaky-bucket limiting on public and expensive routes (the
   codebase already does this for auth/inbox/snapshots via `app.ts`'s
   `@fastify/rate-limit` setup - extend the same pattern to new routes, stricter
   on auth-adjacent and unauthenticated endpoints).
2. **Caching** - can this expensive operation be cached? Cache LLM calls,
   embeddings, slow third-party API responses, and heavy DB aggregations. Avoid
   redundant calls for the same user/input; keep queries and payloads lean.
   (Not yet applied to the AI proxy's provider calls - a real gap, not a solved
   problem; look here first when touching `apps/server/src/routes/ai.ts` or
   similar.)
3. **Fault tolerance** - if a downstream dependency (third-party API, internal
   service) fails, does the system degrade gracefully? Retries with exponential
   backoff plus a fallback path - never a hard crash or a broken user-facing
   flow. (Distinct from the sync protocol's "never blind-retry on a data
   conflict" rule, which is a data-safety invariant, not this - both apply,
   they answer different questions.)

Bias toward simplicity: solve the actual problem with a clear, deterministic,
fast pipeline - no speculative abstraction layers. Performance is a feature; a
slow correct answer is only half-solved.

`gv-server-engineer` and `gv-security-engineer` own enforcing this; `gv-qa-reviewer`
checks for it before anything ships.

## Agent company

This project is operated by a dedicated, in-repo "company" of specialist agents
(architect, server, web, graph, sync, security, devops, docs, QA, orchestrator).
The roster lives in `.claude/agents/gv-*.md`; how it works - ownership matrix,
parallel-worktree workflow, the Definition-of-Done gauntlet, and the continuous
learning loop - is documented in `docs/agent-company/`. Before doing substantial
work, read `docs/agent-company/playbook.md` and `docs/agent-company/lessons.md`.
The company always learns and evolves: append lessons after each task.

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
