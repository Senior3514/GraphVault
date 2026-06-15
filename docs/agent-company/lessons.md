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

### A cross-package web dependency must be wired in centrally

- **Symptom:** the sync agent built `@graphvault/sync-core` and imported it from
  `apps/web`, but (correctly) could not edit `apps/web/package.json` (owned by
  another agent that round). It used a local `node_modules` symlink to build.
- **Fix / rule:** when an agent's package is consumed by an app it doesn't own,
  the **integrator** adds the `workspace:*` dependency to the consumer's
  `package.json` and the root `tsconfig.json` project reference, then runs the
  unified `pnpm install`. Capture this as an explicit integration step.

### `git show --stat` "Bin 0 -> N bytes" means a stray NUL byte

- **Symptom:** a `.ts` source file appeared as `Bin 0 -> 4924 bytes` in
  `--stat`; git treated it as binary.
- **Root cause:** a single stray `\0` (NUL) byte got introduced during agent
  editing (has happened more than once). Git's text/binary heuristic then flags
  the whole file.
- **Fix / rule:** during integration, scan new/edited source for NUL bytes and
  strip them (`tr -d '\000'`). A quick check: any source file shown as `Bin` in
  `git show --stat` is suspect. Verify with `file <path>` (should be "ASCII
  text", not "data").

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

## Orchestration & integration

### A delegating agent must not end its turn before integrating
- **Symptom:** the orchestrator spawned parallel slice agents in worktrees, then
  ended its own turn ("I'll wait for completion") — so its children were
  orphaned and their results never bubbled back to it. The top-level driver had
  to discover the finished worktree branches and integrate them by hand.
- **Rule:** the agent that owns integration must stay alive until the slices
  return, or the *parent* (not the orchestrator) must own integration. When a
  background sub-agent's results are needed, the entity that will integrate must
  be the one that receives the completion notification.

### Deduplicate redundant slice branches before integrating
- **Note:** the same slice was dispatched twice (two graph branches, two shell
  branches) in isolated worktrees. They are mutually-conflicting rewrites of the
  same files — pick exactly one per slice and discard the rest; never try to
  merge both.
- **Tie-breaker used:** prefer the implementation that keeps the engine
  UI-agnostic (synthesize attachment/unresolved graph nodes in `apps/web/lib/graph`,
  not by adding a required `kind` field to the engine's `GraphNode`). Lower
  cross-package blast radius integrates more cleanly.

### `grep $'\x00'` cannot detect NUL bytes
- **Symptom:** `grep -c $'\x00' file` reported "189" on a clean file, falsely
  implying corruption — bash can't pass a literal NUL as an argument, so the
  pattern degrades to empty and matches every line.
- **Rule:** detect NUL bytes with `tr -cd '\000' < file | wc -c` (byte count) or
  `git diff --numstat` showing `-`/`Bin`, not with `grep`.

### Decision: open-core
- GraphVault is **open-core**: client + engine open and auditable, optional paid
  hosted sync proprietary. For a local-first app, data access comes from local
  Markdown + export — closed source would not improve access, only reduce trust.
## Crypto / WebCrypto

### `Uint8Array<ArrayBufferLike>` vs `BufferSource` in TypeScript strict WebCrypto types

- **Symptom:** TypeScript strict mode rejects `Uint8Array` slices (from
  `.subarray()`) as PBKDF2 `salt` or AES-GCM `iv`/`additionalData` parameters
  because the DOM `BufferSource` type requires `Uint8Array<ArrayBuffer>` (not
  `ArrayBufferLike`), and `.subarray()` returns `Uint8Array<ArrayBufferLike>`.
- **Root cause:** `ArrayBufferLike = ArrayBuffer | SharedArrayBuffer`, and the
  WebCrypto DOM types conservatively require the non-shared `ArrayBuffer` variant.
- **Fix / rule:** allocate crypto buffers with `new Uint8Array(new ArrayBuffer(n))`
  (not `new Uint8Array(n)`) so the type is `Uint8Array<ArrayBuffer>`. For slices of
  incoming data, use `new Uint8Array(data.buffer, offset, length)` and cast if needed,
  or copy with `data.slice(start, end)` (returns owned `ArrayBuffer` typed result).

### AES-GCM `decryptVault` must pass an owned `ArrayBuffer` for ciphertext

- **Symptom:** `subtle().decrypt(..., ciphertextSlice)` where `ciphertextSlice`
  is a `subarray` view fails TypeScript strict checks and may fail at runtime in
  some environments when the backing buffer is shared.
- **Fix / rule:** pass `buffer.slice(byteOffset, byteOffset + byteLength)` to
  WebCrypto decrypt/encrypt when you have a view into a larger buffer, to ensure
  the operation sees an independent, fully-owned `ArrayBuffer`.

### Worktree build: build workspace packages before building the consuming app

- **Symptom:** `pnpm build` in an isolated worktree web app fails with
  "Can't resolve '@graphvault/shared'" because the workspace package symlinks
  exist but `dist/` has not been populated yet.
- **Fix / rule:** in a worktree, build dependency packages explicitly first
  (`pnpm build` in each of `packages/shared`, `packages/engine`, `packages/sync-core`)
  before running `pnpm build` in `apps/web`. The root `pnpm -r build` handles this
  ordering automatically via topological sort.
