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

## MCP server / stdio transport

### Content-Length framing: buffer raw bytes, never readline

- **Symptom concern:** using `node:readline` to parse MCP messages line-by-line
  fails because JSON-RPC bodies can contain embedded newlines (multi-line tool
  results, note content with newlines). `readline` splits on `\n`, breaking the
  body.
- **Root cause:** the MCP/LSP Content-Length framing is a binary protocol:
  read `Content-Length: N\r\n\r\n` as ASCII headers, then consume exactly `N`
  raw bytes. `readline` is wrong at both levels.
- **Fix / rule:** buffer `input.on('data')` into a `Buffer`, find `\r\n\r\n`,
  parse `Content-Length`, then slice exactly that many bytes. Only then decode
  as UTF-8 and `JSON.parse`. Never use `readline` for Content-Length-framed
  protocols.

### MCP `tools/call` error surface: use `isError: true` in the content, not a JSON-RPC error

- **Rule:** per the MCP spec, tool execution errors (e.g. "note not found")
  should be returned as a normal `tools/call` result with
  `{ content: [{type: "text", text: "..."}], isError: true }`, not as a
  JSON-RPC `error` object. Reserve JSON-RPC errors for protocol-level failures
  (unknown method, invalid params). This lets the AI client see the error
  message as tool output and reason about it, rather than treating it as a
  transport failure.

### Root `tsconfig.json` references must include new composite packages

- **Rule:** when adding a new composite package under `packages/`, add it to
  the root `tsconfig.json` `references` array. Without this the root-level
  `tsc -b` (used by some CI steps) will not build or typecheck the new package.
  The `pnpm-workspace.yaml` glob (`packages/*`) handles package discovery for
  pnpm; the tsconfig references are separate and must be updated manually.
