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
  return, or the _parent_ (not the orchestrator) must own integration. When a
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

### Worktree isolation can branch from a stale base — verify before integrating

- **Symptom:** five parallel slice agents (`isolation: worktree`) all branched
  from the old `29e3071` v0 squash-merge, NOT the driver's current branch HEAD.
  Slices that only added new files (docs, crypto, storage adapters, layout +
  workspace components) cherry-picked / `git checkout`-ed in cleanly; slices that
  rewrote files the driver had already changed (graph canvas, `vault/page.tsx`,
  `useVault.ts`) conflicted because they were built on v0, missing v1-graph + the
  command-palette shell.
- **Rule:** before integrating a worktree branch, run
  `git log --oneline <currentHEAD>..<branch>` — if it contains an OLD merge
  commit, the branch is stale-based. For additive new-file work, `git checkout
<branch> -- <paths>` is cleanest. For rewrites of shared files, do a manual
  3-way: take the agent's file, then re-thread the current API (e.g. the panes
  `EditorBody` needed the shell's `tags` prop wired into `MarkdownEditor`).
  Keep exactly one implementation per slice; defer divergent duplicates.
- **Data-safety:** never blindly overwrite the editor page (autosave/draft logic
  is where data-loss bugs hide) — adapt props, keep the tested flush logic.

## Wave 2 — named parallel team (Vera/Cipher/Axis/Quill)

### Fix for stale-base worktrees: reset to origin HEAD before coding

- **Rule that worked:** instruct every parallel agent to FIRST run
  `git fetch origin && git reset --hard origin/<branch>` and verify
  `git log --oneline -3`. All four wave-2 slices then branched from the true
  HEAD and cherry-picked in with ZERO conflicts (vs wave-1, where stale v0 bases
  forced manual 3-way merges).

### Cherry-pick the feature commit, not the agent's lessons commit

- Agents that committed `docs/agent-company/lessons.md` separately create a
  guaranteed conflict (the integrator's lessons.md has diverged). Cherry-pick
  only the feature SHA; fold the agents' reported lessons in centrally (here).

### Encryption wiring data-safety (Cipher)

- `EncryptedVaultStore` writes ciphertext only AFTER a successful `encryptVault`;
  a wrong passphrase on load rejects without touching storage (verified by a
  byte-for-byte "original unmodified" test). Storage migration is copy → verify
  (path+content+mtime+ctime) → activate; the source is never auto-cleared.
- `isEncrypted()` checks raw magic bytes, not the Base64 form — detect stored
  encrypted values via a try/catch envelope decode, not `isEncrypted(b64)`.

### Graph v2 without regressing v1 (Axis)

- Read per-frame state (hover/search/selection/pins) from refs inside a stable
  `nodeCanvasObject` so hover/search never rebuilds the layout; v1's kind-colour
  - shadow glow stayed intact. `delete node.fx` (not `= null`) to unpin under TS strict.

### Docs scrub (Quill)

- Grep public docs for the owner's account/repo slug before release; use generic
  "your fork" wording in setup docs, keep the real GitHub link only in app code.

## Wave 3 — cross-cutting hardening (Pixel/Forge/Warden/Drift)

### Responsive: dual-render structurally-different layouts (Pixel)

- When mobile vs desktop differ in STRUCTURE (not just size), render two DOM
  trees guarded by `hidden md:flex` / `flex md:hidden` instead of one
  conditional-class tree — SSR-safe, no `matchMedia` JS, each layout stays
  readable. Use `style={{ height: '100dvh' }}` (+ `h-screen` fallback) for
  correct mobile viewport height; Tailwind 3's arbitrary `supports-*` variant is
  unreliable for `100svh`.

### Tauri desktop in a pnpm monorepo (Forge)

- New `@tauri-apps/*` JS deps require regenerating the root lockfile
  (`pnpm install --lockfile-only`) before Vercel's `--frozen-lockfile` install,
  or the deploy breaks. `beforeBuildCommand` must run the topological
  `pnpm run build:web`, not a bare web `--filter`. The `StorageAdapter` seam lets
  the shell register a native `TauriStorageAdapter` with zero web-app diff.

### Static-export CSP (Warden)

- Next.js `output: 'export'` injects per-build inline RSC scripts, so
  `script-src 'self' 'unsafe-inline'` is the correct (not lazy) policy; never
  `'unsafe-eval'`. Deliver CSP via BOTH a `<meta http-equiv>` (any static host)
  and `vercel.json` headers (authoritative; enforces `frame-ancestors`, which
  browsers ignore in `<meta>`). `next.config.mjs` `headers()` is a no-op for
  static export.

### Untrusted file APIs in tests (Drift)

- Shim browser APIs via `globalThis` (not `window`, which is undefined in Node;
  `window === globalThis` in browsers). Augment DOM types with
  `declare global { interface Window { … } }` — never re-declare a DOM interface
  partially (creates a conflicting parallel type).

## Wave 4 — time-slider (Nova)

### Additive overlay vs hard-filter for timeline scrubbing

- **Symptom concern:** removing nodes from the force layout while scrubbing
  causes constant layout thrash — nodes re-enter at random positions every time
  the window moves, making the animation disorienting.
- **Root cause / rule:** the time-slider must operate as a _dimming overlay_ (like
  `searchIds`) rather than a hard filter that changes `payload.nodes`. The graph
  layout stays completely stable; only canvas alpha changes. This means
  `timelineIds: Set<string> | null` travels the same path as `searchIds` —
  computed from index nodes, passed through a ref inside `nodeCanvasObject`, and
  combined with hover/search dimming. Never rebuild `payload` or `model` on
  timeline scrub.

### Dual-range slider with two overlapping `<input type=range>` inputs

- **Approach:** render two `<input type=range>` stacked via `position: absolute`
  and `opacity: 0` so the browser owns hit-testing on each thumb. Position custom
  visual thumbs absolutely at the computed `left: X%`. Swap z-index dynamically
  when the start handle is past the midpoint so the "end" handle stays on top
  and the two never get stuck. This is CSS-only, zero extra deps.

### Animation loop with a ref to avoid stale closures

- **Rule:** `setInterval` closures capture the state at the time the interval is
  created. For an animation that reads ever-changing state, keep a `stateRef`
  that is updated on every render; the interval reads `stateRef.current`. This
  avoids needing to re-register the interval on every state change (which would
  reset the cadence and create micro-gaps in the animation).

## Wave 5 — visual / cluster polish (Lumen)

### `react-force-graph-2d` does not expose `pixelRatio` as a React prop

- **Symptom:** adding `pixelRatio={window.devicePixelRatio}` to `<ForceGraph2D>`
  caused a TS2322 type error: "Property 'pixelRatio' does not exist on type …".
- **Root cause:** the upstream `force-graph` library handles DPR internally;
  `react-force-graph-2d` never exposed it as a configurable prop, and its `.d.ts`
  doesn't include it.
- **Fix / rule:** don't pass `pixelRatio` to the component. Retina-crispness
  improvements instead come from: (a) scaling all drawn sizes by `1 / globalScale`,
  and (b) using radial gradient fills and halo-shadow labels which look good even
  without explicit DPR scaling.

### Context view as an alpha overlay (not a layout change)

- **Rule:** the "context view" (isolate selected neighbourhood) must be implemented
  as a per-node `ctx.globalAlpha` adjustment inside `nodeCanvasObject`, reading the
  focus set through a stable ref — exactly like timeline and search dimming. This
  keeps the layout completely stable, composes correctly with all other dimming
  modes (search, timeline, hover), and avoids re-creating the callback on every
  selection change. Never add a separate force-graph data rebuild for visual-only
  effects.

### Cluster colouring: compute outside `buildRenderModel`, pass in as a map

- **Rule:** `buildRenderModel` is a pure, engine-agnostic transformer. Cluster
  detection (connected-components BFS) depends on the graph topology and produces
  a `Map<nodeId, color>`. The cleanest wiring is: (a) compute clusters in the page
  with `buildClusterColors(payload.nodes, payload.edges)` as a separate `useMemo`,
  (b) pass the resulting `clusterNodeColor` map into `buildRenderModel` as an
  option. This keeps the model builder framework-free and makes it trivial to swap
  in a richer community-detection algorithm later without touching `model.ts`.

## Wave 6 — Groups overlay (Prism)

### Groups as a colour overlay, not a new colour mode

- **Rule:** user-defined colour groups must be an _overlay_ on top of the base
  colour mode (type/tag/cluster), not a fourth mode. This keeps the base modes
  fully intact and lets users combine groups with any mode. Implementation:
  (a) compute a `Map<nodeId, groupColor>` in a separate `useMemo` keyed only on
  `[groups, payload.nodes]`, (b) pass it as `groupNodeColor` to
  `buildRenderModel`, which applies it as a final override after the base colour
  is set. Zero changes to `ForceGraphCanvas` — group colours land in
  `node.color`, so the canvas draws them without any extra logic.

### Proxy-node trick for group matching before render model is built

- **Rule:** `computeGroupColors` needs rendered node shape (needs `tagKey`,
  `path`) but `buildRenderModel` hasn't run yet. Solution: map `payload.nodes`
  (engine `GraphNode[]`) to lightweight proxy objects with just `{id, title,
tagKey, path, ...}` then call `computeGroupColors(proxyNodes, groups)`. The
  proxy map is then passed into `buildRenderModel`. One pass of the node list
  for matching + one pass inside the model builder = O(2N) total, not O(N²).

### Group matching: avoid localStorage access during SSR

- **Rule:** `loadGroups()` guards with `typeof localStorage === 'undefined'`
  before accessing it, so it is safe to call as a `useState` initialiser in a
  `'use client'` component. No `useEffect` needed for the initial read.
  `saveGroups()` carries the same guard for defensive depth. This pattern is
  correct for any browser-only storage helper used in Next.js App Router.

### Colour inputs as invisible overlays on styled discs

- **Rule:** `<input type="color">` is styled via `opacity: 0; position: absolute`
  layered over a styled `<span>` disc. The user sees the colour, the browser
  handles the native picker. No third-party colour-picker dependency, no canvas
  rendering. The `onChange` just updates the group's `color` string, which then
  propagates through the normal memo chain.

## QA / Gauntlet

### `vercel.json` response-header CSP overrides `<meta>` CSP — keep them in sync

- **Symptom:** `vercel.json` sets `connect-src 'self'` as a response header;
  `apps/web/app/layout.tsx` sets `connect-src 'self' https: http:` in a `<meta>`
  tag. On Vercel the response header is authoritative (browsers prefer headers over
  meta CSP), so all outbound fetch calls to the self-hosted sync server and to
  AI BYOK providers (Anthropic/OpenAI) are silently blocked by the browser on every
  Vercel deployment.
- **Root cause:** the two CSP sources diverged — the meta tag was correctly
  updated to allow `https:` for sync + AI BYOK, but the vercel.json header was
  not updated to match.
- **Fix / rule:** whenever `connect-src` in `layout.tsx` changes, update
  `vercel.json` (and vice versa). The two must be treated as a single logical
  policy. On Vercel, ONLY the response header is enforced. The `<meta>` tag is
  the fallback for self-hosted static deployments.

### `pnpm -r build` fails for desktop — `beforeBuildCommand` targets missing script

- **Symptom:** `apps/desktop/src-tauri/tauri.conf.json` has
  `"beforeBuildCommand": "pnpm run build:web"`, but `apps/desktop/package.json`
  has no `build:web` script. Running `pnpm -r build` causes Tauri to invoke
  `pnpm run build:web` in the desktop package context, fails with exit code 1, and
  aborts the recursive build.
- **Fix / rule:** change `beforeBuildCommand` to `pnpm -w run build:web`
  (`-w` / `--workspace-root`) so Tauri invokes the root-level script that runs
  the topologically-ordered full web stack build. Alternatively add a
  `"build:web": "pnpm -w run build:web"` pass-through to `apps/desktop/package.json`.

## S3-compatible storage (M18 / Vault3)

### AWS SigV4 from `node:crypto` — zero new dependencies, but the `host` header must not be sent manually

- **Rule:** when implementing SigV4 in pure Node, the `host` header MUST be
  included in the signed canonical headers and the `SignedHeaders` list, but
  MUST NOT be present in the headers object passed to `fetch`. `fetch` sets
  `host` automatically from the URL; duplicating it causes "invalid header name"
  errors in some runtimes. Solution: build the signing headers map including `host`,
  compute the signature, then `delete allHeaders['host']` before returning the
  final headers object.

### Restrict S3 proxy to a single well-known object key — don't build a generic object proxy

- **Rule:** the S3 proxy exposes only `GET/PUT/DELETE` for
  `graphvault-vault.json`. Attempting to proxy arbitrary object keys would
  widen the attack surface (an attacker with a valid token could read/write any
  object in the bucket). The wildcard catch-all routes return 400 for any other
  key. This is the same "minimal, auditable" principle as the WebDAV adapter
  (one PUT per save, one GET per load).

### Derive different HKDF info strings per credential type

- **Rule:** the per-user key derivation uses an `info` string that encodes
  both the application and the credential type:
  `graphvault-webdav-cred-v1` for WebDAV, `graphvault-s3-cred-v1` for S3.
  This means even if two users accidentally share the same `userId`, the
  derived keys for WebDAV and S3 are independent. Versioning (`-v1`) in the
  info string allows future key rotation without breaking existing ciphertexts.

## Web-clipper / SSRF (M22 / Reach)

### SSRF guard: check the IP at every redirect hop, not just the initial URL

- **Rule:** a redirect-chain attack starts with a public URL that redirects to a
  private address. The SSRF guard must re-run `dns/promises.lookup` on every URL
  in the redirect chain — use `redirect: 'manual'` in the fetch call and follow
  redirects manually, re-validating the `Location` header URL before each hop.
  The guard also blocks bare `localhost`, `*.localhost`, and `.internal` TLD
  hostnames before DNS lookup (fast path).

### Hand-rolled HTML→Markdown without a DOM: track state with a token stream

- **Rule:** zero-dep HTML→Markdown works by tokenising HTML into text/tag tokens
  (a simple state machine handling quotes in attributes) then converting them in
  a single pass with a small state set (`inPre`, list stack, `inBlockquote`,
  pending-newline counter). This avoids jsdom/cheerio but means the converter is
  not spec-compliant for pathological inputs — acceptable when the output passes
  through DOMPurify before browser display. Test by asserting on specific patterns
  in the output string, not exact equality.

### Unused variables after refactoring: let ESLint guide the cleanup

- **Symptom:** introduced an `inCode` boolean for tracking inline-code state but
  never needed it to affect other logic — the close tag just emits the backtick
  symmetrically with the open tag. ESLint `@typescript-eslint/no-unused-vars`
  caught it.
- **Rule:** for a converter like this, symmetric open/close tag output is enough
  for most inline markup. Avoid accumulating state that is only set but never read.

### Spreading `Partial<T>` with `undefined` values overwrites defaults

- **Symptom:** `loadAISettings` merged old sessionStorage data with
  `DEFAULT_AI_SETTINGS` via `{ ...defaults, ...cleaned }`. When the stored JSON
  lacked a field (e.g. `serverModel`), `cleaned.serverModel` was `undefined`.
  Spreading it over defaults silently overwrote the default empty-string value
  with `undefined`, breaking downstream consumers.
- **Root cause:** JavaScript spread copies all own enumerable keys, including
  those with value `undefined`. A key existing as `undefined` _does_ shadow
  the same key in the source object.
- **Fix / rule:** build the `Partial<T>` with conditional assignment
  (`if (x !== undefined) obj.x = x`) so undefined keys are simply absent from
  the spread. Never spread a constructed object that may contain `undefined`
  values if defaults must be preserved.

### BFF proxy security pattern: HKDF info strings must be unique per credential type

- **Symptom/concern:** server encrypts WebDAV, S3, and AI credentials all under
  the same `GRAPHVAULT_ENCRYPTION_KEY`. If the HKDF info string were shared,
  two credential types for the same `userId` would derive the same sub-key —
  enabling cross-type confusion attacks.
- **Rule:** every credential type must use a unique HKDF info string:
  `graphvault-webdav-cred-v1`, `graphvault-s3-cred-v1`,
  `graphvault-ai-cred-v1`. When adding new encrypted credential stores,
  always pick a new, versioned info string.

### TypeScript array-index access is not narrowed by length-check type guards

- **Symptom:** `isOpenAICompatResponse` checked `choices.length > 0` and
  returned `true`, but TypeScript still flagged `json.choices[0].message` as
  "possibly undefined" because the type was `{ message: ... }[]` (an array, not
  a tuple). Even with the guard in scope, `choices[0]` returned
  `T | undefined` under `noUncheckedIndexedAccess`.
- **Fix / rule:** after a confirmed-non-empty array check, assign the first
  element to a local variable and add an explicit null guard before use, or
  define the type with a minimum-length tuple. Do not rely on a length-check
  type guard to narrow array element access in TypeScript strict mode.

## Wave 14 — MCP server + VPS hardening + Prism2 theming (sequential specialist slices)

### MCP SDK forces zod ≥3.25 (the `zod/v3` subpath)

- **Symptom:** importing `@modelcontextprotocol/sdk/server/mcp.js` under the repo's
  `zod@3.24.1` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- **Root cause:** the SDK (via `zod-to-json-schema@3.25.x`) `require`s the `zod/v3`
  subpath, which only exists in zod **3.25+**.
- **Fix / rule:** when adding the MCP SDK, bump zod to `^3.25.0` (still satisfies
  every existing `^3.24.1` specifier, so one hoisted zod serves the whole
  workspace) and pin the SDK to a 1.x that keeps zod on the v3 line (`^1.22.0`)
  unless you intentionally migrate the repo to zod v4.

### stdio MCP servers must keep stdout pristine

- **Rule:** stdout carries the JSON-RPC frames; any stray `console.log` there
  corrupts the protocol stream. All diagnostics AND the config fail-fast message
  go to **stderr**, and the process exits non-zero on bad config so the MCP host
  detects the failure (verified: exit 1, token value never printed — only the
  env-var _name_ appears in the "Required" message).

### Lowering Fastify's global `bodyLimit` has blast radius beyond blob PUT

- **Symptom/risk:** splitting the body cap into a small JSON limit + large blob
  limit also throttles the WebDAV/S3 vault-upload _proxy_ PUTs (they carry a whole
  vault JSON, previously covered by the 64 MiB global) → large-vault sync breaks.
- **Fix / rule:** any route that legitimately carries large bodies needs an
  explicit per-route `bodyLimit: maxBlobBytes` — audit all `.put`/proxy routes
  when tightening the global limit, not just the obvious blob route.

### Compose `read_only: true` must pair with `tmpfs`; keep keep-alive above the proxy

- **Rule:** a read-only root filesystem needs `tmpfs` for `/tmp` (Node scratch,
  prisma `db push`); postgres additionally needs `/run`, `/var/run/postgresql`
  tmpfs and a few caps re-added after `cap_drop: ALL`. Set the server's
  `keepAliveTimeout` (default 72s) **above** the fronting nginx upstream
  keep-alive (60s) to avoid spurious 502s from socket reuse races.

### Theme the whole app by driving Tailwind's stock `neutral` ramp from CSS vars

- **Rule:** redefining `colors.neutral.{50..950}` as
  `rgb(var(--n-XXX) / <alpha-value>)`, with a dark `:root` ramp and an **inverted**
  `[data-theme='light']` ramp (`light --n-950 := dark --n-50`, …), flips thousands
  of existing `bg-neutral-950 text-neutral-100` utilities automatically — near-zero
  blast radius, no per-component rewrite. Inverting preserves contrast semantics.
- **Gotcha:** `theme('colors.neutral.700')` outside an `@apply` context emits
  `rgb(var(--n-700) / <alpha-value>)` with the alpha placeholder unresolved →
  invalid CSS. For raw CSS props (e.g. `scrollbar-color`) reference the variable
  directly: `rgb(var(--n-700))`.
- **No-flash:** an inline `<head>` script setting
  `document.documentElement.dataset.theme` before paint is CSP-safe under the
  existing `script-src 'self' 'unsafe-inline'` (no `'unsafe-eval'`, no vercel.json
  change). Add `suppressHydrationWarning` to `<html>` since the attribute is set
  pre-hydration.

### Toolchain: corepack does not put a bare `pnpm` on PATH

- **Symptom:** the root `build:web` script (and any nested bare `pnpm --filter …`)
  fails with `sh: 1: pnpm: not found` when pnpm is only available via
  `corepack pnpm`.
- **Fix / rule:** put a one-line `pnpm`→`corepack pnpm` shim dir on PATH before
  running root scripts that shell out to bare `pnpm`, or invoke per-package builds
  directly via `corepack pnpm --filter`.

### Integration: worktree isolation needs a git repo at the agent's cwd

- **Symptom:** `Agent` with `isolation: "worktree"` failed with "not in a git
  repository" even though the project dir was a fresh clone — the harness recorded
  the session root as non-git at startup.
- **Fix / rule:** when worktree isolation is unavailable, run specialists
  **sequentially** in the shared tree with strict disjoint directory ownership and
  commit between each; this preserves conflict-free delegation without the
  concurrent-install/git-index races that parallel-in-one-tree would cause.

## Wave 15 — programmable vault (MCP write tools + CLI HTTP API)

### Conflict-safe writes need the raw per-path FileState (incl. tombstones), not the read view

- **Symptom/risk:** the MCP read path (`latestMarkdownStates`) drops tombstones and
  non-markdown — wrong for writes, where a prior tombstone's `revision` must become
  the new note's `baseRevision`, or the push is rejected `STALE_BASE`.
- **Fix / rule:** writes use a dedicated `client.getFileState(path)` that keeps the
  highest-revision entry for the path **including** deleted tombstones. `baseRevision`
  = that revision (or `0` if absent). Push is fast-forward-only server-side; surface
  any `conflicts` entry as an error ("NOT applied — no data overwritten"), **never**
  blind-retry with a bumped base. Invalidate the index cache only on confirmed apply.
  `append_to_note` must read at the same revision it pushes as base so a concurrent
  edit between read and write is caught as a conflict, not silently lost.

### TS strict: narrow the nullable field in the type guard, and avoid `BodyInit`/loose-JSON types

- A guard `state is FileState` does NOT make `state.hash` non-null under
  `noUncheckedIndexedAccess`/strict — use `state is FileState & { hash: string }`.
- `BodyInit` and a recursive `Json` interface both bite here: type a write helper's
  body as `Uint8Array | string` (not `BodyInit`, which isn't in the Node lib types),
  and for fetch-based tests prefer a single `json(r): Promise<any>` helper (one
  `eslint-disable no-explicit-any`) over a `[key:string]: Json` index signature
  (which collides with named array members like `length`/`some`).

### A long-running CLI subcommand must branch before the shared one-shot vault read

- **Rule:** `graphvault serve` runs indefinitely; every other command shares an
  upfront synchronous `readVault`. Branch out to `serveCommand` (which owns its own
  `readVault` + `server.close()` on SIGINT/SIGTERM → exit 0) BEFORE that shared read,
  or the persistent command is shoehorned through the one-shot path.

### Vault-API path-traversal hardening is purely string-level (engine never touches disk)

- **Rule:** engine ids are vault-relative POSIX strings, so a read-only vault HTTP API
  guards traversal by rejecting `..` segments, backslashes, and NUL and collapsing
  `.`/empty segments — no `fs.realpath` needed. Test the URL-encoded form (`%2e%2e%2f`)
  too, since the router decodes before matching. Bind `127.0.0.1` by default; warn
  loudly when `--host` is non-loopback (exposes the vault).

## Wave 16 — Azure Blob + GCS server-proxied storage adapters

### Azure Shared Key: Content-Length line is empty for empty bodies

- **Rule:** in the Azure Shared Key StringToSign, the Content-Length line must be the
  empty string when the body is empty (GET/DELETE) and the byte count only for
  non-empty bodies (PUT). Sending `"0"` for an empty body breaks the signature.
  Derive it as `payload.length === 0 ? '' : String(len)`. `x-ms-*` headers are
  lowercased, sorted, and joined into CanonicalizedHeaders; the CanonicalizedResource
  is `/<account>/<container>/<blob>` plus sorted query params. Implement with
  `node:crypto` HMAC-SHA256 over the base64-decoded account key — zero new deps.

### GCS interop = free SigV4 reuse

- **Rule:** GCS's S3-compatible XML API accepts AWS SigV4 verbatim, so a GCS
  server-proxy adapter needs ZERO new signing code — feed `host=storage.googleapis.com`,
  `region=auto`, `service=s3` into the existing `signS3Request`. The only
  provider-specific surface is the URL builder + credential schema (HMAC interop
  access id/secret). When adding S3-alike providers (R2, Backblaze, GCS, MinIO),
  reuse the signer rather than replicate it.

### Per-credential HKDF info strings extend cleanly to new providers

- **Rule (reaffirmed):** each new credential-bearing provider gets its own versioned
  HKDF info string — `graphvault-azure-cred-v1`, `graphvault-gcs-cred-v1` — distinct
  from webdav/s3/ai, so a shared `userId` can never derive the same sub-key across
  providers. Secrets AES-256-GCM at rest; config GET never returns the plaintext
  secret (assert this in tests). Keep the single-well-known-object restriction
  (`graphvault-vault.json`, other keys → 400) for every storage proxy.

## Wave 17 — web Azure/GCS storage adapters + Settings picker

### Trust the deployed server source over any brief for wire contracts

- **Symptom:** a client config form built to a spec/brief (GCS fields
  `accessKeyId`/`secretAccessKey`/`endpoint`) silently 400s because the actual
  route expects different field names (`accessId`/`secret`/`prefix`, no endpoint).
- **Rule:** before writing client config forms or adapters, READ
  `apps/server/src/routes/<provider>.ts` + the `services/*ConfigInfo` response
  interface and match field names byte-for-byte. The server is the source of truth;
  a brief can be stale.

### When a provider's zod schemas live route-locally (not in @graphvault/shared)

- **Rule:** if `packages/**` is out of scope and the new provider's schemas were
  defined route-locally on the server, do NOT extend the schema-validated
  `GraphVaultClient`. Use plain bearer-token `fetch` helpers for config CRUD
  (`postStorageConfig`/`getStorageConfig`/`deleteStorageConfig`) and keep validation
  server-side. Secrets live only in the in-flight request body, never persisted in
  the browser. (Follow-up: promote the wire types into `@graphvault/shared`.)

### Factor shared proxy-adapter plumbing once, mirror per provider

- **Rule:** Azure/GCS/S3 web adapters differ only in `id`/`label`/proxy path —
  token+serverUrl session reads, `isNote` guards, JSON (de)serialise, and the
  load/save/clear/isAvailable proxy flow are identical. Extract a single
  apps/web-local `proxyAdapterHelpers.ts` (no new dep) and keep each adapter a thin
  shell, rather than copy-pasting the whole s3Adapter three times.

## Wave 18 — public opt-in graph-snapshot store + web short share links

### Unauthenticated public-write endpoints: default OFF + layered caps

- **Rule:** a no-account public-write feature (snapshot share store) ships **disabled
  by default** (`GRAPHVAULT_SNAPSHOTS_ENABLED=false` → routes not even registered, so
  the feature is invisible/404). When enabled, layer every cap: per-payload size
  (413), total count with oldest-first eviction (bounded disk), TTL sweep on read,
  and a STRICTER per-window rate limit on POST (like `/v1/auth/*`). Treat the payload
  as opaque text — never parse/execute it server-side. Validate the id against a
  strict `^[A-Za-z0-9_-]{16,32}$` pattern before building any path (traversal guard,
  defense-in-depth in both service and store).

### No owner? Gate destructive ops behind a one-time token, hashed + constant-time

- **Rule:** with no account, DELETE can't be owner-checked — return a `deleteToken`
  from POST, store only its SHA-256 hash, and require it on DELETE with a
  `timingSafeEqual` compare. A party who only knows the public share id cannot grief
  the snapshot.

### `URL.origin` is the clean SSRF/junk guard for an attacker-controllable origin param

- **Rule:** when a share link carries a `srv=<serverOrigin>` the embed page will fetch
  from, validate it via `new URL(srv).origin` and require `http:`/`https:` — this
  rejects non-http(s) schemes and strips any path/query/hash a crafted link added,
  leaving only `scheme://host:port`. No manual string parsing.

### Client-side cap can pre-empt the server 413 — keep both

- **Note:** the web `encodeSnapshot` cap (200 KB) is below the server default
  `snapshotMaxBytes` (400 KB), so oversized graphs are rejected client-side first.
  Still wire + test the 413 path: the server cap is operator-configurable and is the
  authoritative backstop.

## Wave 19 — "connect anything" inbound webhook + per-connector audit log

### Server-side note creation: blob.put plaintext BEFORE sync.push

- **Rule:** when the server itself creates a note (inbound webhook), it must
  `blob.put(hash, plaintextBytes)` BEFORE `sync.push([...])` — the sync decision
  rejects `MISSING_BLOB` for any non-delete op whose hash isn't already uploaded.
  Hash is `sha256` of the **plaintext** UTF-8. `SyncService.push` does NOT enforce
  the device check (only the route does), so an internal caller acting on the
  user's behalf via a validated inbox token may push directly.

### No-clobber by path SELECTION, not conflict reaction

- **Rule:** prevent overwrite by choosing a guaranteed-fresh vault-relative path
  (`Inbox/<sanitized-source>-<randomShortId>.md`, then `storage.getFile` absence
  check, regenerate on the astronomically-rare hit) and pushing with
  `baseRevision: 0`. A fresh path fast-forward-accepts; a conflict becomes
  structurally impossible, so the 409 branch is purely defensive (record a
  `rejected` audit entry, never blind-retry onto existing content).

### Unauthenticated public-write: token IS the credential, hashed; 404 on unknown

- **Rule:** the inbound `POST /v1/inbox/:token` is unauthenticated by design — the
  token is the credential. Store only `hashToken(token)`; look up by hash; return
  404 (not 403) for unknown/revoked tokens so the endpoint never reveals which
  tokens exist. Owner mints tokens via authenticated, vault-ownership-checked
  endpoints; tokens are never returned in list views. Stricter per-window rate
  limit + service-level size cap on the _rendered_ note (frontmatter adds bytes)
  with the Fastify global bodyLimit as the coarse outer guard.

## Wave 20 — MCP resources + prompts

### SDK 1.29 registration signatures + capability auto-advertise

- **Note:** `@modelcontextprotocol/sdk@1.29.0` current (non-deprecated) signatures:
  `registerResource(name, ResourceTemplate, config, readCb)` and
  `registerPrompt(name, { title, description, argsSchema }, cb)`. `ResourceTemplate`
  requires the `list` key to be present (even if `undefined`). Registering
  resources/prompts auto-advertises the capabilities — no manual capability wiring.
  Always read the SDK's installed `dist` types (pnpm virtual store, not a top-level
  `node_modules/@modelcontextprotocol`) since these APIs shift across 1.x.

### URI-template `{+path}` matches multi-segment, but YOU must guard traversal

- **Rule:** the reserved-expansion `graphvault://note/{+path}` form lets one template
  match multi-segment note paths, but the template does NOT sanitize — decode and
  validate each segment yourself (reject `..`/empty/absolute, including encoded
  `%2e%2e`, and require the path to be a known note) before reading. Percent-encode
  per segment when generating URIs so spaces/`#` round-trip.

### Prompt-text assertions are case-sensitive

- **Rule:** an emphasized all-caps word ("MISSING") in generated prompt copy won't
  match a `[Mm]issing` regex — use `/.../i` for word-presence checks on copy you may
  later restyle.

## Wave 21 — focus mode (distraction-free editing)

### Two independent useLayout() instances don't share React state — broadcast

- **Rule:** when more than one component calls `useLayout()` (the shell hides the
  rail/sidebar; the workspace hides panes/centers the editor), a plain state toggle
  in one hook never reaches the other. Mirror the flag with a `window`
  CustomEvent broadcast (like the existing `TOGGLE_PREVIEW_EVENT`): the originating
  setter persists, listeners update state ONLY (no persistence feedback loop).

### Make view-modes presentational, not destructive

- **Rule:** hide panes via render conditions (`!focusMode && …`), never by flipping
  `panels`/clearing `widths`/`tabs`. Exiting then restores the user's exact column
  sizes and collapsed state. Cover it with a round-trip test.

### Esc-to-exit handlers must yield to modal overlays

- **Rule:** a global Esc handler (exit focus mode) must check for an open
  `[role="dialog"][aria-modal="true"]` and bail if present, so Esc closes the
  palette/drawer/modal first instead of an unexpected mode change.

## Audit fixes — web critical

### Centralize storage-key constants — drift across copies is a silent P0

- **Bug:** 4 proxy adapters + the graph share path each hardcoded `gv:auth:token`/
  `gv:serverUrl`, but the real keys are `graphvault:auth-token:v1` (sessionStorage)
  and `graphvault:server-url` (**localStorage**). Every cloud backend's
  `isAvailable()` was false → all dead on arrival, masked by adapter tests that used
  the wrong keys too. **Fix:** one `lib/api/storageKeys.ts`; hooks + adapters import
  it. Note the two values live in DIFFERENT tiers (token=session, url=local) — a
  copy-pasted `getServerUrl` reading sessionStorage was part of the bug.

### View-mode flags must neutralize conflicting persisted layout state

- **Bug:** focus mode hid panes by render condition but never cleared a persisted
  `maximized` → all columns hidden = blank workspace that survives reload. **Fix:**
  clear `maximized` on entering focus mode AND compute an `effectiveMaximized`
  (focus ⇒ null) at the render site (defense-in-depth for already-persisted blanks).

### "Never lose data" needs beforeunload + visibilitychange flush

- A debounced autosave that only flushes on React unmount/tab-switch loses the
  pending window on hard close / mobile background. Wire `beforeunload` AND
  `visibilitychange==='hidden'` to the existing flush. Pull it into a DOM-only
  helper so it's unit-testable without a renderer.

### Don't combine encryption with a non-localStorage adapter (split-vault risk)

- The encrypted store hard-wires localStorage while the unencrypted path uses the
  active adapter. Gate "enable encryption" on the active adapter being localStorage
  rather than reworking encryption-through-any-adapter — prevents ciphertext-to-local
  while the cloud copy stays stale.

### Canvas/WebGL colors must read the theme tokens, not hardcode dark

- The force-graph canvas hardcoded `#0a0a0a` bg/labels → a black block in light
  theme. Read `--n-*` via `getComputedStyle` and re-read on a `data-theme`
  MutationObserver. Snapshot share also leaked full note paths (`i: n.id` where id IS
  the path) — emit opaque ids and remap edges.
## End-to-end ship-readiness audit (5-agent) — data-safety fixes

### Conflict resolution: "preserve content over honoring a delete" must hold for BOTH directions

- **Bug:** `settle` implemented only the symmetric (client-delete/server-edit) direction and unconditionally adopted server state as canonical. So when the SERVER held a tombstone and the CLIENT held an edit, a delete beat a concurrent edit and devices diverged (edit demoted to a conflict copy under a different path). **Fix:** special-case `DELETE_EDIT_CONFLICT` — if local is a non-deleted edit and `conflict.server` is a tombstone, keep the edit canonical (re-base so it re-pushes and wins). Spec §6.3. Test the failing direction explicitly — the original test only covered the opposite one, masking the bug.

### Conflict-copy paths must be uniquified, not just date-stamped

- **Bug:** `conflictCopyPath(path, device, YYYY-MM-DD)` is deterministic, so two same-day conflicts on one file/device produced an identical path → the second silently overwrote the first preserved copy. **Fix:** pass the live index and append ` (2)`, ` (3)`… until unique. Sanitize device names against C0 control chars + `..`, not just slashes.

### STALE_BASE with `server: null` must re-base to 0, not livelock

- **Bug:** an op with `baseRevision > 0` but no server file never advanced (guard required `conflict.server`), re-pushed forever, hit maxRounds, threw — one bad file aborted the whole sync. **Fix:** when STALE_BASE carries a null server, re-base to revision 0 (treat as brand-new → fast-forwards).

### Normalize-at-the-boundary is necessary but not sufficient

- **Bug:** spec mandates NFC path normalization but nothing applied it. Adding `.transform(p => p.normalize('NFC'))` to `filePathSchema` only protects the validated boundary (the server); the engine and sync-core cast `FilePath` strings directly and bypass it. **Fix:** also NFC-normalize keys/lookups in the engine resolution maps and the sync index. NFD/NFC test fixtures are fragile — author them with explicit `\u` escapes (editors silently NFC-normalize source).

### Duplicate paths: dedup BEFORE the edge pass

- **Bug:** `buildIndex` did last-write-wins on nodes but built edges from ALL parsed entries, so a discarded duplicate's links survived as phantom edges. **Fix:** dedup parsed entries by path (last-wins) before building edges so nodes and edges stay consistent.
