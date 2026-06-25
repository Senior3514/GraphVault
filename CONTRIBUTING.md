# Contributing to GraphVault

Thanks for your interest in GraphVault — a local-first, zero-telemetry Markdown
PKM with a thinking graph, self-hosted sync, and bring-your-own-AI. Contributions
of all kinds are welcome.

## Core principles (please respect these)

1. **Never lose user data.** Anything that writes or migrates notes must be
   non-destructive — prefer conflict copies over overwrites, and verify before
   replacing.
2. **Privacy first.** No telemetry by default. Note content must never leave the
   device unless the user explicitly enables a provider. AI/connector keys live
   on the user's self-hosted server, never in the browser.
3. **Validate all external input** with the shared zod schemas.
4. **Keep the engine decoupled from the UI** so it can be reused (CLI, MCP, desktop).

## Dev setup

```bash
corepack enable          # provides the repo-pinned pnpm
pnpm install
pnpm run build:web       # builds shared packages + the Next.js static export
```

Run the apps:

```bash
pnpm --filter @graphvault/server dev   # http://127.0.0.1:4000
pnpm --filter @graphvault/web dev       # http://localhost:3000
```

## Repository layout

```
apps/server   Fastify sync + proxy API
apps/web      Next.js (App Router) PWA client
apps/desktop  Tauri shell
apps/extension Browser web-clipper (MV3)
packages/shared    zod wire types (single source of truth)
packages/engine    graph engine (parse, link/tag index, queries)
packages/sync-core sync protocol logic
packages/cli       graphvault CLI
packages/mcp       MCP server (vault → AI clients)
```

## The gauntlet (must be green before a PR)

```bash
pnpm run typecheck
pnpm run lint
pnpm run format:check    # use `pnpm exec prettier --write .` to fix
pnpm -r test
pnpm run build:web
```

## Pull requests

- Branch from `main`; keep PRs focused.
- Match the style, naming, and structure of surrounding code.
- Add tests for new logic (we use `node:test`). Pure logic should be testable
  without a browser.
- Fill in the PR template, including the data-safety note.
- Conventional, descriptive commit messages.

## Good first issues

Look for the `good first issue` label. Small, self-contained wins: docs fixes,
additional importer formats, additional connector parsers, accessibility tweaks,
and test coverage are all great starting points.

## Questions

Open a discussion or issue. Be kind — see the [Code of Conduct](CODE_OF_CONDUCT.md).
