# GraphVault Agent Company — Lessons Learned

The company's living memory. Append a concise entry whenever you hit a non-obvious
problem: **symptom → root cause → fix/rule**. Read this before starting work so we
stop repeating mistakes. Newest at the top within each section.

> Everyone always learns and evolves.

---

## Tooling & build

### `tsc -b --noEmit` breaks across composite project references (TS6310)

- **Symptom:** `pnpm typecheck` intermittently failed with
  `error TS6310: Referenced project '…/packages/shared' may not disable emit`,
  but only after sources had changed (e.g. after running Prettier).
- **Root cause:** in build mode, `tsc -b` must (re)build referenced **composite**
  projects, which requires emit. Passing `--noEmit` forbids it, so the build
  errors whenever a referenced project is stale. When everything was already
  up to date, `tsc -b` did nothing and the flag appeared harmless.
- **Fix / rule:** composite packages with project references use
  `"typecheck": "tsc -b"` (emit to gitignored `dist/`). Do not use
  `tsc -b --noEmit`. Single-project apps (e.g. web) may use plain `tsc --noEmit`.

### `packageManager` pin must match the available pnpm

- **Symptom:** `pnpm install` failed with
  `ERR_PNPM_NO_MATCHING_VERSION No matching version found for pnpm@10.9.7`.
- **Root cause:** the root `package.json` `packageManager` field pinned a pnpm
  version that does not exist on the registry; corepack tried to fetch it.
- **Fix / rule:** pin `packageManager` to a version that actually resolves
  (the environment had pnpm 10.33.0). Verify with `pnpm --version` first.

### `next build` rewrites `next-env.d.ts` and trips root ESLint

- **Symptom:** root `eslint .` failed on `apps/web/next-env.d.ts` with
  `@typescript-eslint/triple-slash-reference` after a production build.
- **Root cause:** Next.js regenerates `next-env.d.ts` (adding a `///` reference
  to `.next/types/routes.d.ts`). It is generated and "should not be edited".
- **Fix / rule:** ignore `**/next-env.d.ts` in the root ESLint flat config.

## Repository & git hygiene

### `.gitignore` can silently swallow source directories

- **Symptom:** a server source folder named `storage/` would have been excluded
  from commits.
- **Root cause:** the root `.gitignore` ignores `storage/` (server runtime blob
  data). A source directory sharing that name is caught too.
- **Fix / rule:** don't name source dirs after ignored runtime paths. The server
  uses `src/store/` for code and `storage/` only for runtime data. Sanity-check
  `git status` after adding files; if expected files are missing, suspect ignore
  rules.

### Tracking committed agent defs while ignoring local `.claude` state

- **Symptom:** the whole `.claude/` directory was gitignored, which would have
  dropped the committed agent company definitions.
- **Fix / rule:** ignore `.claude/*` but re-include `!.claude/agents/` so the
  roster is versioned while worktrees/caches/local settings stay ignored.

## Parallel agents & integration

### Disjoint directory ownership = conflict-free parallelism

- **Lesson:** running specialists in parallel git worktrees works cleanly when
  each owns a **disjoint** set of paths. Cherry-picking their single commits onto
  the feature branch then never conflicts.
- **Rule:** the only routinely contended files are `pnpm-lock.yaml` (regenerate
  centrally — agents must NOT stage it), shared `package.json` files, and
  `apps/web/components/Sidebar.tsx`. Assign each contended file to exactly one
  agent per round, or reconcile centrally during integration.

### Always regenerate the lockfile centrally

- **Rule:** worktree agents develop with their own `pnpm install` but must NOT
  commit `pnpm-lock.yaml`. The orchestrator runs one `pnpm install` after
  integrating all branches so the lockfile reflects the union of dependencies.

## Server & security

### Device-bound tokens reject mismatched `deviceId` (this is correct)

- **Symptom:** a `/push` smoke test returned
  `deviceId does not match the authenticated device`.
- **Root cause:** the test sent an arbitrary `deviceId` instead of the one bound
  to the auth token at registration. The server correctly enforces device
  binding.
- **Fix / rule:** clients must use the `deviceId` returned in the `AuthToken`.
  When writing smoke tests, capture and reuse it. Not a bug — a security control.

### Content hash must be of plaintext, even with at-rest encryption

- **Rule:** if blobs are encrypted at rest, the `sha256:<hex>` content hash is
  still computed over the **plaintext** bytes so dedupe and the sync protocol are
  unchanged; ciphertext + nonce + tag are an on-disk storage detail only.

### Native addons (`argon2`) and pnpm build scripts

- **Note:** pnpm's default policy marks `argon2`/`prisma` postinstall scripts as
  "ignored", but `argon2`'s prebuilt binary still loads at runtime. For Docker,
  prefer a glibc base (`node:22-slim`) so the prebuilt native binary works.

## Web / Next.js

### Browser-only widgets need `ssr: false`

- **Rule:** canvas/WebGL components (e.g. force-graph renderers) must be loaded
  via `next/dynamic` with `ssr: false` and marked `'use client'`, or production
  `next build` fails during static generation.
