# GraphVault Agent Company - Lessons Learned

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
  centrally - agents must NOT stage it), shared `package.json` files, and
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
  When writing smoke tests, capture and reuse it. Not a bug - a security control.

### Content hash must be of plaintext, even with at-rest encryption

- **Rule:** if blobs are encrypted at rest, the `sha256:<hex>` content hash is
  still computed over the **plaintext** bytes so dedupe and the sync protocol are
  unchanged; ciphertext + nonce + tag are an on-disk storage detail only.

### Native addons (`argon2`) and pnpm build scripts

- **Note:** pnpm's default policy marks `argon2`/`prisma` postinstall scripts as
  "ignored", but `argon2`'s prebuilt binary still loads at runtime. For Docker,
  prefer a glibc base (`node:22-slim`) so the prebuilt native binary works.

## Web / Next.js

### De-clutter a heavy settings page with `<details>` groups, not a structural rewrite

- **Symptom:** a 4000+ line Settings page felt "clunky" and implied an account was
  required, because self-hosted-sync/account/cloud-backend/AI/encryption sections
  sat inline at the same visual weight as everyday controls.
- **Fix / rule:** wrap (don't rewrite) - add two presentational helpers,
  `GroupHeading` ("Essentials" vs "Advanced (optional)") and a native
  `<details>`-based `CollapsibleSection`, and only REORDER the existing section
  component calls into those groups. Native `<details>/<summary>` is keyboard-
  accessible, works without JS, and keeps every control mounted + fully wired in
  the DOM (so no behaviour/logic change, no autosave/auth risk). Animate the
  chevron with `group-open:rotate-180` and gate it behind `motion-reduce`.
- **Copy rule for "no account required" products:** relabel "Account" →
  "Sync account (self-hosted)" and add an inline "Optional - you do not need this"
  banner; clarify that "Create account" sets up a login on the user's OWN server,
  not a hosted product account. Mirror the reassurance on the landing hero
  ("No sign-up, no account") and in the first-run OnboardingHint so the message
  lands before the user ever opens Settings.

### `env(safe-area-inset-*)` is inert without `viewport-fit=cover`

- **Symptom:** the mobile shell padded its top bar / bottom nav with
  `env(safe-area-inset-*)`, but on notched devices the padding was always 0 - the
  chrome still clipped under the notch / home indicator.
- **Root cause:** there was no `viewport` export anywhere, so Next.js emitted no
  `viewport-fit=cover`. The `env(safe-area-inset-*)` variables only resolve to
  non-zero values when the viewport opts into the full display via
  `viewport-fit=cover`; otherwise they are always `0`. (There was also no
  `width=device-width`, so the page rendered at 980px on phones.)
- **Fix / rule:** add an `export const viewport: Viewport` to the root
  `app/layout.tsx` with `width: 'device-width'`, `initialScale: 1`, and
  `viewportFit: 'cover'`. Put `themeColor` there too (Next.js merges it into a
  `<meta name="theme-color">`) and DELETE any hand-written `theme-color` meta to
  avoid duplicates. Don't pin `maximumScale`/`userScalable` - leave pinch-zoom on
  for accessibility. Verify in the built `out/index.html`, not just source.

### Keep PWA install decision logic pure (no DOM) and inject the live values

- **Rule:** the "what install affordance to show" decision (Chromium prompt vs
  iOS-Safari Add-to-Home-Screen hint vs already-installed → hide) is fiddly and
  platform-specific. Put it in a pure `lib/pwa/install.ts` that takes
  `{ userAgent, standalone, hasPromptEvent }` and returns a discriminated
  affordance; unit-test it with real UA strings (iPhone Safari vs CriOS/FxiOS,
  Android Chrome, desktop Chrome/Edge, mac Safari). The `'use client'` component
  only wires `navigator.userAgent`, the `display-mode` media queries +
  `navigator.standalone`, and the captured `beforeinstallprompt` event into it.
  iPadOS 13+ reports a desktop-Safari UA, so detect it via `maxTouchPoints > 1`
  in the component (touch isn't in the UA string) and normalise before calling
  the pure helper. iOS Safari NEVER fires `beforeinstallprompt` - Add to Home
  Screen is the only path, so target that hint at Safari specifically (CriOS /
  FxiOS on iOS get the generic browser-menu hint, since they also can't install).

### Consume SSE with a pure parser layer split from the network layer

- **Symptom:** SSE consumption code that reads `fetch().body` directly is
  impossible to unit-test without mocking the whole stream/decoder stack, and
  frames that split across TCP chunks (e.g. `data: {"ty` + `pe":...}`) get
  silently dropped.
- **Fix / rule:** split it in two - a **pure** `parseSseRecords(buffer)` that
  returns `{records, rest}` (carry `rest` into the next chunk to reassemble
  split frames) + a thin `readAiStream(body, handlers, signal)` that wires a
  `ReadableStream` reader + `TextDecoder` to the parser. The pure half gets full
  `node:test` coverage (multi-line `data:`, `:heartbeat` comments, CRLF, partial
  trailing record, `[DONE]` sentinel) with zero network. Validate every frame
  against the shared zod schema (`aiStreamEventSchema`) - never trust the wire.

### Abort the stream on panel close / unmount (stop burning budget)

- **Rule:** for a streaming AI proxy, pass an `AbortController.signal` into both
  `fetch` and the reader, and abort it in a close/unmount effect. A closed tab
  must tear down the upstream generation or it keeps spending the user's budget.
  Also stop reading on the terminal `done`/`error` frame and `reader.cancel()`.

### Write-only secrets: never pre-fill the key input on "Update"

- **Rule:** when an "Update key" form pre-fills non-secret fields (gateway,
  model, caps) from the GET config-info response, the API key field must stay
  blank - the key is write-only over the wire and the GET never returns it
  (only `{keySet}`). Pre-filling it would imply the browser holds the secret.

### Hide opt-in AI surfaces entirely when mode is `off`

- **Rule:** when the privacy dial is `off`, return `null` from BOTH the toggle
  button and the panel itself (not just disable them) - zero network, and no
  hint of a feature the user has not opted into. Default stays `off`.

### Browser-only widgets need `ssr: false`

- **Rule:** canvas/WebGL components (e.g. force-graph renderers) must be loaded
  via `next/dynamic` with `ssr: false` and marked `'use client'`, or production
  `next build` fails during static generation.

### Runtime release-asset resolution: pure matcher + tolerant suffix match

- **Symptom/risk:** a download page that hardcodes installer filenames breaks on
  every version bump - the desktop pipeline emits VERSION-specific names
  (`GraphVault_0.2.0_x64-setup.exe`, `..._universal.dmg`, `..._amd64.AppImage`).
- **Fix / rule:** fetch the latest GitHub release at runtime and resolve assets
  with a PURE `pickAssets(assets, os)` that matches by lowercased extension
  suffix (`.exe`/`.msi`→win, `.dmg`→mac, `.appimage`/`.deb`→linux) so it
  survives arbitrary version/arch tokens in the middle of the name. Match `.exe`
  ahead of `.msi` and `.AppImage` ahead of `.deb` via a priority field; the
  top-priority match is `primary`, the rest are `alternates` ("other formats").
  Reject companions (`.sig`, `.tar.gz`, `checksums.sha256`, `latest.json`) by
  simply not matching their suffix. Keep it defensive (null/undefined/malformed
  assets → empty) so a flaky API never throws in the render path, and unit-test
  it with a realistic asset list incl. the noise files.

### Standalone marketing routes: exclude from the AppShell, mind `trailingSlash`

- **Rule:** a public full-bleed page (landing, `/download`) that brings its own
  nav must be excluded from `AppFrame`'s sidebar shell exactly like `/`. With
  `output: 'export'` + `trailingSlash: true`, `usePathname()` can return the
  slashed form, so match BOTH `'/download'` and `'/download/'`. Verify the route
  lands in the static export (`out/download/index.html`), not just `next build`'s
  route table.

### Self-host fonts with `next/font/local` for the zero-telemetry / offline promise

- **Symptom/risk:** the codebase already set Inter-specific OpenType features
  (`font-feature-settings: 'cv11','ss01','cv05'`) but loaded NO actual font - so
  the features were inert no-ops and the UI rendered in plain system-ui. Reaching
  for `next/font/google` to fix it would have added a build-time fetch to
  fonts.googleapis.com, breaking the local-first / zero-telemetry / fully-offline
  promise and the `font-src 'self'` CSP.
- **Fix / rule:** bundle the `.woff2` files locally under `apps/web/app/fonts/`
  and load them with `next/font/local` (NOT `next/font/google`). The build emits
  them to same-origin `/_next/static/media/*.woff2` with self-scoped `@font-face`,
  so the existing `font-src 'self'` CSP needs no change and there is zero external
  request. Wire each face's `variable` (`--font-sans` etc.) through Tailwind
  `fontFamily` tokens (`'var(--font-sans)', ...fallbacks`) and set the variable
  classes + a default `font-sans` on `<html>` so it applies app-wide in both
  themes. Variable fonts (Geist) take a weight RANGE (`weight: '300 700'`); static
  faces (Inter 400/600, JetBrains Mono 400) take a single weight per `src` entry.
- **Where to find woff2 offline:** Next.js ships Geist + Geist Mono woff2 in its
  own devtools assets, and the `prisma` package ships full Inter + JetBrains Mono
  woff2 sets - usable as bundled sources without any download. Pairing used:
  Geist (display/headings) + Inter (body, matches the cv11/ss01 features) +
  JetBrains Mono (editor).
- **Verify in the EMITTED output, not source:** confirm `ls out/_next/static/
media/*.woff2` count matches your `src` entries, that `@font-face` `src:url(...)`
  in the built CSS references ONLY `/_next/static/media/`, and that a grep for
  `fonts.googleapis|fonts.gstatic|typekit|cdn...font` across `out/` returns
  nothing. `preload: true` faces also appear as `<link rel="preload" as="font">`
  in each page's HTML; set `preload: false` for the mono (rarely above the fold).

### Marketing vs private-vault separation is copy + chrome, not new routes

- **Symptom:** user feedback "it's unclear what separates our landing (public)
  page from a user's own private notebook." The landing and the app shell shared
  the same wordmark/styling, so the boundary read as ambiguous.
- **Fix / rule:** make the boundary explicit on BOTH sides without restructuring
  routing. On the public page: a "Product" pill in the nav, a hero line "This
  page is public; your vault is private", and a primary CTA labelled "Open your
  private vault". On the private side: a one-time, focus-trapped first-entry
  modal ("This space is yours alone - lives only on this device") gated by a
  localStorage `seen` flag (re-openable via a custom event, never auto-reshown),
  plus a persistent "Private vault" + lock identity in the sidebar header. This
  is presentational only - no data/sync/storage logic touched.

### Decorative hero animation: pure CSS/SVG, server component, motion-safe

- **Rule:** a premium animated landing backdrop does NOT need a canvas/WebGL dep.
  An inline-SVG constellation (nodes + edges in brand cyan) animated purely with
  Tailwind keyframes (`stroke-dashoffset` draw-in via `pathLength={1}`, node
  `twinkle`, gradient `aurora-drift`) renders as a SERVER component - zero client
  JS, keeping the landing route tiny (stayed ~1.9 kB). Gate every animation
  behind `motion-safe:` (the global `prefers-reduced-motion` rule then freezes
  them) and mark the layer `aria-hidden`. Inline `style={{animationDelay}}` for
  per-node stagger is fine under the static-export `style-src 'unsafe-inline'`.

### Download-page GitHub fetch is privacy-safe - read-only, `credentials: 'omit'`

- **Rule:** the only allowed network call on the download page is
  `fetch('https://api.github.com/.../releases/latest')`. It reads PUBLIC release
  metadata and must send NO user data: pass `credentials: 'omit'` (belt-and-
  braces against cookies on a cross-origin GET) and no auth header. GitHub
  returns **404** when a repo has no published release → render a friendly
  "installers on the way" state (distinct from a network error, which links to
  the releases page). The existing CSP `connect-src 'self' https:` already
  permits it; no CSP/vercel.json change needed. Abort the fetch on unmount and
  swallow `AbortError`.

## Orchestration & integration

### A delegating agent must not end its turn before integrating

- **Symptom:** the orchestrator spawned parallel slice agents in worktrees, then
  ended its own turn ("I'll wait for completion") - so its children were
  orphaned and their results never bubbled back to it. The top-level driver had
  to discover the finished worktree branches and integrate them by hand.
- **Rule:** the agent that owns integration must stay alive until the slices
  return, or the _parent_ (not the orchestrator) must own integration. When a
  background sub-agent's results are needed, the entity that will integrate must
  be the one that receives the completion notification.

### Deduplicate redundant slice branches before integrating

- **Note:** the same slice was dispatched twice (two graph branches, two shell
  branches) in isolated worktrees. They are mutually-conflicting rewrites of the
  same files - pick exactly one per slice and discard the rest; never try to
  merge both.
- **Tie-breaker used:** prefer the implementation that keeps the engine
  UI-agnostic (synthesize attachment/unresolved graph nodes in `apps/web/lib/graph`,
  not by adding a required `kind` field to the engine's `GraphNode`). Lower
  cross-package blast radius integrates more cleanly.

### `grep $'\x00'` cannot detect NUL bytes

- **Symptom:** `grep -c $'\x00' file` reported "189" on a clean file, falsely
  implying corruption - bash can't pass a literal NUL as an argument, so the
  pattern degrades to empty and matches every line.
- **Rule:** detect NUL bytes with `tr -cd '\000' < file | wc -c` (byte count) or
  `git diff --numstat` showing `-`/`Bin`, not with `grep`.

### Decision: open-core

- GraphVault is **open-core**: client + engine open and auditable, optional paid
  hosted sync proprietary. For a local-first app, data access comes from local
  Markdown + export - closed source would not improve access, only reduce trust.

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

### Worktree isolation can branch from a stale base - verify before integrating

- **Symptom:** five parallel slice agents (`isolation: worktree`) all branched
  from the old `29e3071` v0 squash-merge, NOT the driver's current branch HEAD.
  Slices that only added new files (docs, crypto, storage adapters, layout +
  workspace components) cherry-picked / `git checkout`-ed in cleanly; slices that
  rewrote files the driver had already changed (graph canvas, `vault/page.tsx`,
  `useVault.ts`) conflicted because they were built on v0, missing v1-graph + the
  command-palette shell.
- **Rule:** before integrating a worktree branch, run
  `git log --oneline <currentHEAD>..<branch>` - if it contains an OLD merge
  commit, the branch is stale-based. For additive new-file work, `git checkout
<branch> -- <paths>` is cleanest. For rewrites of shared files, do a manual
  3-way: take the agent's file, then re-thread the current API (e.g. the panes
  `EditorBody` needed the shell's `tags` prop wired into `MarkdownEditor`).
  Keep exactly one implementation per slice; defer divergent duplicates.
- **Data-safety:** never blindly overwrite the editor page (autosave/draft logic
  is where data-loss bugs hide) - adapt props, keep the tested flush logic.

## Wave 2 - named parallel team (Vera/Cipher/Axis/Quill)

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
- `isEncrypted()` checks raw magic bytes, not the Base64 form - detect stored
  encrypted values via a try/catch envelope decode, not `isEncrypted(b64)`.

### Graph v2 without regressing v1 (Axis)

- Read per-frame state (hover/search/selection/pins) from refs inside a stable
  `nodeCanvasObject` so hover/search never rebuilds the layout; v1's kind-colour
  - shadow glow stayed intact. `delete node.fx` (not `= null`) to unpin under TS strict.

### Docs scrub (Quill)

- Grep public docs for the owner's account/repo slug before release; use generic
  "your fork" wording in setup docs, keep the real GitHub link only in app code.

## Wave 3 - cross-cutting hardening (Pixel/Forge/Warden/Drift)

### Responsive: dual-render structurally-different layouts (Pixel)

- When mobile vs desktop differ in STRUCTURE (not just size), render two DOM
  trees guarded by `hidden md:flex` / `flex md:hidden` instead of one
  conditional-class tree - SSR-safe, no `matchMedia` JS, each layout stays
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
  `declare global { interface Window { … } }` - never re-declare a DOM interface
  partially (creates a conflicting parallel type).

## Wave 4 - time-slider (Nova)

### Additive overlay vs hard-filter for timeline scrubbing

- **Symptom concern:** removing nodes from the force layout while scrubbing
  causes constant layout thrash - nodes re-enter at random positions every time
  the window moves, making the animation disorienting.
- **Root cause / rule:** the time-slider must operate as a _dimming overlay_ (like
  `searchIds`) rather than a hard filter that changes `payload.nodes`. The graph
  layout stays completely stable; only canvas alpha changes. This means
  `timelineIds: Set<string> | null` travels the same path as `searchIds` -
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

## Wave 5 - visual / cluster polish (Lumen)

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
  focus set through a stable ref - exactly like timeline and search dimming. This
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

## Wave 6 - Groups overlay (Prism)

### Groups as a colour overlay, not a new colour mode

- **Rule:** user-defined colour groups must be an _overlay_ on top of the base
  colour mode (type/tag/cluster), not a fourth mode. This keeps the base modes
  fully intact and lets users combine groups with any mode. Implementation:
  (a) compute a `Map<nodeId, groupColor>` in a separate `useMemo` keyed only on
  `[groups, payload.nodes]`, (b) pass it as `groupNodeColor` to
  `buildRenderModel`, which applies it as a final override after the base colour
  is set. Zero changes to `ForceGraphCanvas` - group colours land in
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

### `vercel.json` response-header CSP overrides `<meta>` CSP - keep them in sync

- **Symptom:** `vercel.json` sets `connect-src 'self'` as a response header;
  `apps/web/app/layout.tsx` sets `connect-src 'self' https: http:` in a `<meta>`
  tag. On Vercel the response header is authoritative (browsers prefer headers over
  meta CSP), so all outbound fetch calls to the self-hosted sync server and to
  AI BYOK providers (Anthropic/OpenAI) are silently blocked by the browser on every
  Vercel deployment.
- **Root cause:** the two CSP sources diverged - the meta tag was correctly
  updated to allow `https:` for sync + AI BYOK, but the vercel.json header was
  not updated to match.
- **Fix / rule:** whenever `connect-src` in `layout.tsx` changes, update
  `vercel.json` (and vice versa). The two must be treated as a single logical
  policy. On Vercel, ONLY the response header is enforced. The `<meta>` tag is
  the fallback for self-hosted static deployments.

### `pnpm -r build` fails for desktop - `beforeBuildCommand` targets missing script

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

### AWS SigV4 from `node:crypto` - zero new dependencies, but the `host` header must not be sent manually

- **Rule:** when implementing SigV4 in pure Node, the `host` header MUST be
  included in the signed canonical headers and the `SignedHeaders` list, but
  MUST NOT be present in the headers object passed to `fetch`. `fetch` sets
  `host` automatically from the URL; duplicating it causes "invalid header name"
  errors in some runtimes. Solution: build the signing headers map including `host`,
  compute the signature, then `delete allHeaders['host']` before returning the
  final headers object.

### Restrict S3 proxy to a single well-known object key - don't build a generic object proxy

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
  in the redirect chain - use `redirect: 'manual'` in the fetch call and follow
  redirects manually, re-validating the `Location` header URL before each hop.
  The guard also blocks bare `localhost`, `*.localhost`, and `.internal` TLD
  hostnames before DNS lookup (fast path).

### Hand-rolled HTML→Markdown without a DOM: track state with a token stream

- **Rule:** zero-dep HTML→Markdown works by tokenising HTML into text/tag tokens
  (a simple state machine handling quotes in attributes) then converting them in
  a single pass with a small state set (`inPre`, list stack, `inBlockquote`,
  pending-newline counter). This avoids jsdom/cheerio but means the converter is
  not spec-compliant for pathological inputs - acceptable when the output passes
  through DOMPurify before browser display. Test by asserting on specific patterns
  in the output string, not exact equality.

### Unused variables after refactoring: let ESLint guide the cleanup

- **Symptom:** introduced an `inCode` boolean for tracking inline-code state but
  never needed it to affect other logic - the close tag just emits the backtick
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
  two credential types for the same `userId` would derive the same sub-key -
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

## Wave 14 - MCP server + VPS hardening + Prism2 theming (sequential specialist slices)

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
  detects the failure (verified: exit 1, token value never printed - only the
  env-var _name_ appears in the "Required" message).

### Lowering Fastify's global `bodyLimit` has blast radius beyond blob PUT

- **Symptom/risk:** splitting the body cap into a small JSON limit + large blob
  limit also throttles the WebDAV/S3 vault-upload _proxy_ PUTs (they carry a whole
  vault JSON, previously covered by the 64 MiB global) → large-vault sync breaks.
- **Fix / rule:** any route that legitimately carries large bodies needs an
  explicit per-route `bodyLimit: maxBlobBytes` - audit all `.put`/proxy routes
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
  of existing `bg-neutral-950 text-neutral-100` utilities automatically - near-zero
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

### Tokenize the brand accent as a CSS-var Tailwind colour (one-place rebrand)

- **Rule:** make the brand accent a swappable token the same way the `neutral`
  ramp is: define `colors.accent.{50..950,fg}` in `tailwind.config.ts` as
  `rgb(var(--accent-XXX) / <alpha-value>)`, back it with `--accent-*` triples in
  BOTH `:root` (dark) and `:root[data-theme='light']` in globals.css, then
  migrate component classes from the hardcoded palette (`sky-*`) to `accent-*`.
  A bulk `sed 's/sky-/accent-/g'` over the matched files is safe when EVERY use
  of that palette is brand/accent (verify first with grep). After: rebranding is
  editing ~24 triples, zero component diffs.
- **Gotcha (missed by `sed`):** arbitrary-value utilities reference the palette
  by DOT path, not dash - `bg-[radial-gradient(...,theme(colors.sky.500/18),...)]`.
  Grep `colors\.sky\.` separately and migrate those too. Unlike raw-CSS-prop
  `theme()` use, `theme(colors.accent.500/18)` (with an explicit `/opacity`)
  DOES resolve the `<alpha-value>` placeholder correctly to
  `rgb(var(--accent-500)/.18)` - the unresolved-placeholder bug only bites
  `theme(...)` with NO opacity in a non-utility context (e.g. `scrollbar-color`).
- **AA, the load-bearing part:** the accent-500 FILL must clear AA against the
  white text it carries (primary CTAs). Pure cyan-400/500 is far too bright
  (cyan ~`#22d3ee` vs white ≈ 1.5:1). For a premium deep cyan, accent-500 had to
  go to `rgb(1 127 153)` (`#017f99`) → 4.67:1 vs white (AA normal text); 600 =
  `#016c83` → 6.04:1 (hover). For accent-AS-TEXT, the light theme needs DEEPER
  values than dark (light page is near-white): light accent-400 = `#02697e`
  (6.10:1 on paper) while dark accent-400 = `#1fafc6` (7.41:1 on near-black).
  Keep 500/600 (the fills) IDENTICAL across themes so CTAs are one consistent
  cyan; only the text/tint steps diverge per theme. Add an `--accent-fg` token
  (white) for "what sits on the fill" so future rebrands don't re-derive it.
- **Verify in the EMITTED CSS, not source:** confirm both `--accent-500:1 127 153`
  (dark) and the light value appear, that `.bg-accent-500{...rgb(var(--accent-500)...)}`
  is generated, that primary CTAs in `out/index.html` carry `bg-accent-500`, and
  that `grep -c sky <built.css>` is 0.

### Toolchain: corepack does not put a bare `pnpm` on PATH

- **Symptom:** the root `build:web` script (and any nested bare `pnpm --filter …`)
  fails with `sh: 1: pnpm: not found` when pnpm is only available via
  `corepack pnpm`.
- **Fix / rule:** put a one-line `pnpm`→`corepack pnpm` shim dir on PATH before
  running root scripts that shell out to bare `pnpm`, or invoke per-package builds
  directly via `corepack pnpm --filter`.

### Integration: worktree isolation needs a git repo at the agent's cwd

- **Symptom:** `Agent` with `isolation: "worktree"` failed with "not in a git
  repository" even though the project dir was a fresh clone - the harness recorded
  the session root as non-git at startup.
- **Fix / rule:** when worktree isolation is unavailable, run specialists
  **sequentially** in the shared tree with strict disjoint directory ownership and
  commit between each; this preserves conflict-free delegation without the
  concurrent-install/git-index races that parallel-in-one-tree would cause.

## Wave 15 - programmable vault (MCP write tools + CLI HTTP API)

### Conflict-safe writes need the raw per-path FileState (incl. tombstones), not the read view

- **Symptom/risk:** the MCP read path (`latestMarkdownStates`) drops tombstones and
  non-markdown - wrong for writes, where a prior tombstone's `revision` must become
  the new note's `baseRevision`, or the push is rejected `STALE_BASE`.
- **Fix / rule:** writes use a dedicated `client.getFileState(path)` that keeps the
  highest-revision entry for the path **including** deleted tombstones. `baseRevision`
  = that revision (or `0` if absent). Push is fast-forward-only server-side; surface
  any `conflicts` entry as an error ("NOT applied - no data overwritten"), **never**
  blind-retry with a bumped base. Invalidate the index cache only on confirmed apply.
  `append_to_note` must read at the same revision it pushes as base so a concurrent
  edit between read and write is caught as a conflict, not silently lost.

### TS strict: narrow the nullable field in the type guard, and avoid `BodyInit`/loose-JSON types

- A guard `state is FileState` does NOT make `state.hash` non-null under
  `noUncheckedIndexedAccess`/strict - use `state is FileState & { hash: string }`.
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
  `.`/empty segments - no `fs.realpath` needed. Test the URL-encoded form (`%2e%2e%2f`)
  too, since the router decodes before matching. Bind `127.0.0.1` by default; warn
  loudly when `--host` is non-loopback (exposes the vault).

## Wave 16 - Azure Blob + GCS server-proxied storage adapters

### Azure Shared Key: Content-Length line is empty for empty bodies

- **Rule:** in the Azure Shared Key StringToSign, the Content-Length line must be the
  empty string when the body is empty (GET/DELETE) and the byte count only for
  non-empty bodies (PUT). Sending `"0"` for an empty body breaks the signature.
  Derive it as `payload.length === 0 ? '' : String(len)`. `x-ms-*` headers are
  lowercased, sorted, and joined into CanonicalizedHeaders; the CanonicalizedResource
  is `/<account>/<container>/<blob>` plus sorted query params. Implement with
  `node:crypto` HMAC-SHA256 over the base64-decoded account key - zero new deps.

### GCS interop = free SigV4 reuse

- **Rule:** GCS's S3-compatible XML API accepts AWS SigV4 verbatim, so a GCS
  server-proxy adapter needs ZERO new signing code - feed `host=storage.googleapis.com`,
  `region=auto`, `service=s3` into the existing `signS3Request`. The only
  provider-specific surface is the URL builder + credential schema (HMAC interop
  access id/secret). When adding S3-alike providers (R2, Backblaze, GCS, MinIO),
  reuse the signer rather than replicate it.

### Per-credential HKDF info strings extend cleanly to new providers

- **Rule (reaffirmed):** each new credential-bearing provider gets its own versioned
  HKDF info string - `graphvault-azure-cred-v1`, `graphvault-gcs-cred-v1` - distinct
  from webdav/s3/ai, so a shared `userId` can never derive the same sub-key across
  providers. Secrets AES-256-GCM at rest; config GET never returns the plaintext
  secret (assert this in tests). Keep the single-well-known-object restriction
  (`graphvault-vault.json`, other keys → 400) for every storage proxy.

## Wave 17 - web Azure/GCS storage adapters + Settings picker

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

- **Rule:** Azure/GCS/S3 web adapters differ only in `id`/`label`/proxy path -
  token+serverUrl session reads, `isNote` guards, JSON (de)serialise, and the
  load/save/clear/isAvailable proxy flow are identical. Extract a single
  apps/web-local `proxyAdapterHelpers.ts` (no new dep) and keep each adapter a thin
  shell, rather than copy-pasting the whole s3Adapter three times.

## Graph fix 2 - actually screenshotting a "spectacular" pass caught what code review missed

### Never trust a prior pass's self-report on visual quality - screenshot it

- **Symptom:** a prior "make the graph spectacular" milestone reported success,
  but the user's honest feedback was "nodes still look like garbage, labels
  overlap and hide each other, everything is gross." Reading the code alone
  (radial-gradient "lit sphere" nodes, halo labels, DPR notes in comments) reads
  as sophisticated and plausible - the bugs were only visible in an actual
  rendered screenshot of a busy vault.
- **Fix / rule:** for any graph/canvas visual-quality task, build the app, serve
  the static export, and use `playwright-core` (`chromium.launch({ executablePath:
'/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })`, no need to install a
  browser) to screenshot the REAL rendered output before touching code - dark
  AND light theme, a HiDPI context (`deviceScaleFactor: 2/3`), and a busy vault
  (30-45+ notes with a few high-degree hub nodes, not the sparse 3-note seed -
  label crowding only shows up once several nodes cluster tightly). Crop tight
  with PIL (`im.crop(...).resize(..., Image.NEAREST)`) and `Read` the PNG to
  inspect at the pixel level - the label "ghosting" bug in this task was
  invisible at a normal screenshot zoom level and only obvious once cropped in.
- **Concrete bugs found this way that code review would not have caught:**
  (1) `shouldShowLabel` only checked a zoom threshold with zero collision
  awareness, so any moderately dense neighbourhood (a hub with 5+ close
  neighbours) rendered as a totally illegible stack of overlapping label text -
  the single biggest driver of the "gross" complaint. (2) The "halo label"
  technique drew 4 solid copies of the shadow colour at a FIXED (not
  `/globalScale`) 0.8px offset before the real text - at most zoom levels this
  read as a smeared, doubled "ghost" copy of every label, not a clean halo.
  (3) DPR/canvas-backing-resolution and the lit-sphere node body were RE-checked
  under this same screenshot process and found already correct (verified via
  `page.evaluate` reading `canvas.width/height` vs `cssW/cssH × devicePixelRatio`
  at dsf 1/2/3 - exact match every time) - resist the urge to "fix" working code
  just because the user's complaint sounds DPR-shaped; verify first.

### Real label-declutter needs a per-frame pre-pass, not a per-node decision

- **Rule:** `react-force-graph-2d`/`force-graph` calls `nodeCanvasObject` once
  per node in data order with no shared per-frame state, so a purely local
  "should I draw my label" decision can never know what other labels already
  claimed that screen space. The fix is `onRenderFramePre(ctx, globalScale)`
  (exposed by both the underlying `force-graph` lib and the React wrapper,
  called with the SAME zoom/pan-transformed `ctx` that `nodeCanvasObject` later
  draws into) - build the full candidate list once, run a greedy
  collision-avoidance pass, and stash the resulting `Set<nodeId>` in a ref that
  `nodeCanvasObject` just reads. Put the actual greedy algorithm in a pure,
  DOM-free module (`lib/graph/labelLayout.ts`: `selectVisibleLabels`) with text
  measurement injected as `(text, fontSize) => number` so it unit-tests without
  a canvas - forced candidates (selected/hovered/focused-neighbourhood/search
  match) always place first and reserve their box regardless of mutual overlap
  (the user explicitly focused that neighbourhood); everything else is sorted
  by priority (node degree) and skipped if its bounding box would overlap an
  already-placed one. O(n²) axis-aligned rect scan against a small "placed"
  list is plenty cheap at the label-eligible counts a zoom threshold ever lets
  through (a few hundred at most) - no spatial index needed.

### Canvas text halo: stroke a single outline, never stack offset fill copies

- **Symptom:** drawing a label 5 times (4 offset "shadow" copies + 1 real pass)
  to fake a halo produces a legible-at-a-glance but genuinely smeared/doubled
  look under any real inspection, because the offset is either imperceptible or
  reads as a second copy of the glyphs - there is no in-between that looks like
  a clean halo.
- **Fix / rule:** `ctx.lineJoin='round'; ctx.lineWidth = fontSize * 0.3; ctx.strokeStyle
= haloColor; ctx.strokeText(text, x, y);` THEN `ctx.fillText(...)` - one stroke
  pass + one fill pass. Scale `lineWidth` off the (already zoom-normalised)
  `fontSize`, not a fixed pixel constant, so the halo stays proportionally
  correct at every zoom level instead of vanishing when zoomed out or turning
  into a blob when zoomed in. Cheaper (2 draw calls vs 5) and strictly better-
  looking.

## Wave 18 - public opt-in graph-snapshot store + web short share links

### Unauthenticated public-write endpoints: default OFF + layered caps

- **Rule:** a no-account public-write feature (snapshot share store) ships **disabled
  by default** (`GRAPHVAULT_SNAPSHOTS_ENABLED=false` → routes not even registered, so
  the feature is invisible/404). When enabled, layer every cap: per-payload size
  (413), total count with oldest-first eviction (bounded disk), TTL sweep on read,
  and a STRICTER per-window rate limit on POST (like `/v1/auth/*`). Treat the payload
  as opaque text - never parse/execute it server-side. Validate the id against a
  strict `^[A-Za-z0-9_-]{16,32}$` pattern before building any path (traversal guard,
  defense-in-depth in both service and store).

### No owner? Gate destructive ops behind a one-time token, hashed + constant-time

- **Rule:** with no account, DELETE can't be owner-checked - return a `deleteToken`
  from POST, store only its SHA-256 hash, and require it on DELETE with a
  `timingSafeEqual` compare. A party who only knows the public share id cannot grief
  the snapshot.

### `URL.origin` is the clean SSRF/junk guard for an attacker-controllable origin param

- **Rule:** when a share link carries a `srv=<serverOrigin>` the embed page will fetch
  from, validate it via `new URL(srv).origin` and require `http:`/`https:` - this
  rejects non-http(s) schemes and strips any path/query/hash a crafted link added,
  leaving only `scheme://host:port`. No manual string parsing.

### Client-side cap can pre-empt the server 413 - keep both

- **Note:** the web `encodeSnapshot` cap (200 KB) is below the server default
  `snapshotMaxBytes` (400 KB), so oversized graphs are rejected client-side first.
  Still wire + test the 413 path: the server cap is operator-configurable and is the
  authoritative backstop.

## Wave 19 - "connect anything" inbound webhook + per-connector audit log

### Server-side note creation: blob.put plaintext BEFORE sync.push

- **Rule:** when the server itself creates a note (inbound webhook), it must
  `blob.put(hash, plaintextBytes)` BEFORE `sync.push([...])` - the sync decision
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

- **Rule:** the inbound `POST /v1/inbox/:token` is unauthenticated by design - the
  token is the credential. Store only `hashToken(token)`; look up by hash; return
  404 (not 403) for unknown/revoked tokens so the endpoint never reveals which
  tokens exist. Owner mints tokens via authenticated, vault-ownership-checked
  endpoints; tokens are never returned in list views. Stricter per-window rate
  limit + service-level size cap on the _rendered_ note (frontmatter adds bytes)
  with the Fastify global bodyLimit as the coarse outer guard.

## Wave 20 - MCP resources + prompts

### SDK 1.29 registration signatures + capability auto-advertise

- **Note:** `@modelcontextprotocol/sdk@1.29.0` current (non-deprecated) signatures:
  `registerResource(name, ResourceTemplate, config, readCb)` and
  `registerPrompt(name, { title, description, argsSchema }, cb)`. `ResourceTemplate`
  requires the `list` key to be present (even if `undefined`). Registering
  resources/prompts auto-advertises the capabilities - no manual capability wiring.
  Always read the SDK's installed `dist` types (pnpm virtual store, not a top-level
  `node_modules/@modelcontextprotocol`) since these APIs shift across 1.x.

### URI-template `{+path}` matches multi-segment, but YOU must guard traversal

- **Rule:** the reserved-expansion `graphvault://note/{+path}` form lets one template
  match multi-segment note paths, but the template does NOT sanitize - decode and
  validate each segment yourself (reject `..`/empty/absolute, including encoded
  `%2e%2e`, and require the path to be a known note) before reading. Percent-encode
  per segment when generating URIs so spaces/`#` round-trip.

### Prompt-text assertions are case-sensitive

- **Rule:** an emphasized all-caps word ("MISSING") in generated prompt copy won't
  match a `[Mm]issing` regex - use `/.../i` for word-presence checks on copy you may
  later restyle.

## Wave 21 - focus mode (distraction-free editing)

### Two independent useLayout() instances don't share React state - broadcast

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

## Audit fixes - server SSRF + hardening

### Every outbound proxy needs the SSRF guard, not just the clipper

- **Bug:** only `clip.ts` validated user-supplied URLs; the WebDAV/S3/Azure/GCS/AI
  custom-endpoint proxies fetched arbitrary hosts → an authed user could reach
  `169.254.169.254` (cloud metadata) or internal services. **Fix:** factor the guard
  into `services/ssrf.ts` (`assertSafeUrl`/`guardedFetch`/`isPrivateOrLoopbackIp`) and
  route every outbound proxy fetch through it. Default-safe; loopback targets for
  self-hosted backends gated behind `GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS` (clip
  never relaxed).

### DNS-pin to defeat rebinding; don't rewrite the URL host to a bare IP

- **Bug:** resolve-then-fetch re-resolves the name independently (TOCTOU) - a name
  that flips to a private IP between the two lookups bypasses the check. **Fix:**
  resolve once, validate, then connect via `node:http(s)` with a custom `lookup` that
  returns only a pre-validated IP. Keep the original hostname for SNI/`Host` so TLS
  cert validation stays correct. Native `fetch`/undici exposes no public dispatcher
  without a dep, so socket-level `node:http(s)` is the cleanest pin.

### "Production-only" safety must key on EXPOSURE, not just NODE_ENV

- **Bug:** the CORS-`*`/require-HTTPS preflight only fired when `NODE_ENV=production`;
  self-hosters run on a VPS without setting it → open CORS, no warning. **Fix:** treat
  a non-loopback bind host as production-equivalent for those checks. Localhost dev
  unaffected.

### AI cap is rate-limiting → 429, not 400

- The daily AI cap threw `badRequest` (400); clients can't tell "malformed" from
  "retry tomorrow." Throw `AppError(429, 'RATE_LIMITED', …)` to match the rest of the app.

## Audit fixes - server durability (postgres persistence)

### Don't advertise "encrypted at rest" while storing config in process memory

- **Bug:** in postgres mode, provider/AI configs lived in `PrismaStorage` in-process
  `Map`s (documented TODO) and inbox tokens/audit lived in `InboxService` Maps - all
  silently wiped on restart while `/v1/server-info` claimed `credentialsEncryptedAtRest`.
  **Fix:** add Prisma models (WebDav/S3/Azure/Gcs/Ai config + InboxToken/InboxAuditEntry)
  and route everything through the `Storage` layer; move inbox state out of the service
  into Storage so it survives restarts. In-memory impl unchanged. Added a
  `credentialsPersisted` server-info flag so the claim is honest per backend.

### prisma validate/generate + gitignored client gotchas

- `prisma validate` needs `DATABASE_URL` set just to parse the datasource - pass a dummy
  DSN when there's no DB. The generated client is gitignored and NOT in root eslint
  ignores, so a stray `prisma generate` floods eslint with artifact errors - remove the
  generated dir after verifying. The store loads the client via runtime dynamic
  `import()` + a structural `PrismaLike` type, so build/typecheck/test pass without a
  generated client or a live DB (only the in-memory path is runtime-tested).

### Moving sync service state into async Storage ripples to call sites

- Relocating inbox tokens/audit into the async `Storage` layer made several
  `InboxService` methods `async`; audit every caller (routes needed an explicit `await`
  on `revokeToken`).

## Audit fixes - web critical

### Centralize storage-key constants - drift across copies is a silent P0

- **Bug:** 4 proxy adapters + the graph share path each hardcoded `gv:auth:token`/
  `gv:serverUrl`, but the real keys are `graphvault:auth-token:v1` (sessionStorage)
  and `graphvault:server-url` (**localStorage**). Every cloud backend's
  `isAvailable()` was false → all dead on arrival, masked by adapter tests that used
  the wrong keys too. **Fix:** one `lib/api/storageKeys.ts`; hooks + adapters import
  it. Note the two values live in DIFFERENT tiers (token=session, url=local) - a
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
  rather than reworking encryption-through-any-adapter - prevents ciphertext-to-local
  while the cloud copy stays stale.

### Canvas/WebGL colors must read the theme tokens, not hardcode dark

- The force-graph canvas hardcoded `#0a0a0a` bg/labels → a black block in light
  theme. Read `--n-*` via `getComputedStyle` and re-read on a `data-theme`
  MutationObserver. Snapshot share also leaked full note paths (`i: n.id` where id IS
  the path) - emit opaque ids and remap edges.

## End-to-end ship-readiness audit (5-agent) - data-safety fixes

### Conflict resolution: "preserve content over honoring a delete" must hold for BOTH directions

- **Bug:** `settle` implemented only the symmetric (client-delete/server-edit) direction and unconditionally adopted server state as canonical. So when the SERVER held a tombstone and the CLIENT held an edit, a delete beat a concurrent edit and devices diverged (edit demoted to a conflict copy under a different path). **Fix:** special-case `DELETE_EDIT_CONFLICT` - if local is a non-deleted edit and `conflict.server` is a tombstone, keep the edit canonical (re-base so it re-pushes and wins). Spec §6.3. Test the failing direction explicitly - the original test only covered the opposite one, masking the bug.

### Conflict-copy paths must be uniquified, not just date-stamped

- **Bug:** `conflictCopyPath(path, device, YYYY-MM-DD)` is deterministic, so two same-day conflicts on one file/device produced an identical path → the second silently overwrote the first preserved copy. **Fix:** pass the live index and append ` (2)`, ` (3)`… until unique. Sanitize device names against C0 control chars + `..`, not just slashes.

### STALE_BASE with `server: null` must re-base to 0, not livelock

- **Bug:** an op with `baseRevision > 0` but no server file never advanced (guard required `conflict.server`), re-pushed forever, hit maxRounds, threw - one bad file aborted the whole sync. **Fix:** when STALE_BASE carries a null server, re-base to revision 0 (treat as brand-new → fast-forwards).

### Normalize-at-the-boundary is necessary but not sufficient

- **Bug:** spec mandates NFC path normalization but nothing applied it. Adding `.transform(p => p.normalize('NFC'))` to `filePathSchema` only protects the validated boundary (the server); the engine and sync-core cast `FilePath` strings directly and bypass it. **Fix:** also NFC-normalize keys/lookups in the engine resolution maps and the sync index. NFD/NFC test fixtures are fragile - author them with explicit `\u` escapes (editors silently NFC-normalize source).

### Duplicate paths: dedup BEFORE the edge pass

- **Bug:** `buildIndex` did last-write-wins on nodes but built edges from ALL parsed entries, so a discarded duplicate's links survived as phantom edges. **Fix:** dedup parsed entries by path (last-wins) before building edges so nodes and edges stay consistent.

## AI BFF Slice B (server) - SSE streaming + durable spend caps

### SSE translating relay: capture `usage`/`done`, never re-emit them inline

- **Symptom/risk:** when relaying an OpenAI-compatible upstream stream, yielding every parsed event inline (including `usage` and `[DONE]`) double-emits the terminal frames once you also append your own canonical `usage`+`done` at the end. **Fix:** in the relay generator, `continue` on parsed `usage` (capture into `finalUsage`) and `done` (capture model); only relay `delta`/`error` inline. Emit exactly one canonical `usage` then one `done` after the read loop. The browser depends on a stable, provider-agnostic frame set - assert in a test that the body never contains `"choices"` or `"delta":{` (the raw upstream shape), and that every frame validates against `aiStreamEventSchema`.

### SSE pre-check must run BEFORE `reply.hijack()` / `writeHead(200)`

- **Rule:** a real HTTP `429`/`404` is only possible before any SSE byte is written (the status is committed to `200` the moment headers flush). Run the spend/cap pre-check + key-decrypt in a `prepareStream()` that throws an `AppError` first; only then `reply.hijack()` and `writeHead`. A cap tripped _after_ headers can only be an `event: error` frame. Keep the route thin: route owns the SSE wire format + heartbeat (`:keepalive\n\n` every ~15s) + disconnect wiring; the service owns decrypt/egress/parse/redact/commit.

### Client disconnect → abort upstream via a forwarded `AbortSignal`

- **Rule:** wire `reply.raw.on('close', () => abort.abort())` and thread `abort.signal` into `guardedFetch({ stream:true, signal })`. In the SSRF transport, `signal.addEventListener('abort', () => req.destroy(...))` tears the pinned socket down so a closed tab stops burning budget. Test it with a real listening app + a raw `http.request` you `req.destroy()` after the first chunk (light-my-request `inject` can't model a mid-stream TCP close); assert the mock transport observed the abort. Commit the request (cost 0 if no usage seen) in a `finally` so a disconnect still counts.

### `guardedFetch` streaming: change ONLY the body tail; keep the DNS pin byte-for-byte

- **Rule:** add `stream?: boolean` that resolves the `Response` with a `ReadableStream` backed by the `IncomingMessage` for a final 2xx only - leave the validate→pin→revalidate path and the buffered redirect (3xx) path untouched. Redirect hops must still carry `stream`+`signal` forward so the final 2xx is streamed and a disconnect aborts mid-chase. `ReadableStreamReadResult` is not a TS lib global - type the reader result as `Awaited<ReturnType<typeof reader.read>>`.

### Durable spend cap: persist the window in Storage; never estimate cost

- **Rule:** the old in-process `Map<userId,{date,count}>` is wiped on restart - replace it with an `AiSpendWindowRecord` (in-memory + Prisma) and a `commitAiSpend(userId, addUsd, addRequests, today)` read-modify-write that lazily resets when `windowDate !== today`. Enforce BOTH caps (monetary `spendCapUsd` + request `dailyRequestCap`/env) against the _previously accrued_ window (soft cap: one call may cross, next is refused → `429 RATE_LIMITED`, never `400`). Commit the **provider-reported** `costUsd`; when the gateway reports none, record `costUsd: 0` and rely on the request cap - guessing risks over/under-charging the user's own budget. Surface `spendCapState` on the config GET (non-secret) for the budget meter; the key stays redacted everywhere. Test the cap by re-building the app over the SAME storage instance to prove the window survives a simulated restart.

### Slice-A doc may ship unformatted - don't "fix" files outside your ownership

- **Symptom:** `pnpm format:check` (repo-wide) flagged `docs/ai-bff.md`, which the server slice doesn't own and didn't touch. It was already non-prettier-compliant on the base `ai-bff` branch (Slice A). **Rule:** verify a format/lint failure pre-exists on the base branch and is outside your path set before touching it; format only your own files. Prisma's `schema.prisma` has no prettier parser (expected `No parser could be inferred`) - exclude it from per-file format checks.

## SecAudit - session https://claude.ai/code/session_01Qw5rxHnoo4J3PuVwfEo79v

### VULN-1 (REAL, FIXED): WebDAV proxy path-traversal via URL-encoded dots

- **File / line:** `packages/shared/src/webdav.ts` `webdavProxyPathSchema` refine;
  `apps/server/src/services/webdav.ts` `joinWebDavUrl`.
- **Root cause:** the proxy path schema only checked `p.includes('..')`. Fastify
  decodes wildcard path params exactly once, so a double-encoded input
  `%252e%252e` arrives in the handler as `%2e%2e` - no literal `..`, so the check
  passed. The resulting path was appended to the WebDAV base URL and sent upstream;
  the remote WebDAV server decoded `%2e%2e` to `..` and resolved files outside the
  configured directory.
- **Exploit path:** `GET /v1/storage/webdav/proxy/%252e%252e%2fetc%2fpasswd` →
  old schema allows it → `joinWebDavUrl` appends `%2e%2e/etc/passwd` →
  upstream WebDAV server sees `../etc/passwd` and reads outside the base.
- **Fix:** added `containsPathTraversal(p)` in both files (shared schema + service
  layer). The function: (1) fast-path literal `..` check, (2) reject any `%2e` or
  `%252e` in the raw string, (3) iteratively `decodeURIComponent` until stable
  and re-check for `..`. Malformed percent sequences also rejected.
- **Rule:** `String.includes('..')` is NEVER sufficient for path traversal guards on
  values that may be URL-encoded. Always fully decode (iteratively) before checking,
  AND also reject percent-encoded dot forms (`%2e`, `%252e`) in the raw string as a
  fast path. Apply both checks at the schema boundary AND at the service layer
  (belt-and-suspenders), since schema validation can be bypassed by direct service
  calls or future refactors.
- **Tests:** `apps/server/test/sec-audit.test.ts` - VULN-1 tests were written
  FAILING first (proved exploitable), then the fix was applied and all pass.

### CONFIRMED SOLID - areas audited and found secure (no new bugs)

- **SSRF (all proxies):** WebDAV/S3/Azure/GCS/AI custom endpoint/clip all route
  through `guardedFetch` in `services/ssrf.ts`. DNS-pinned transport prevents
  TOCTOU rebinding. Per-redirect-hop re-validation. IPv4-mapped IPv6 unwrapping.
  Private-target opt-in behind `GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS` (clip
  never relaxed). SSRF error messages do not leak the blocked IP or hostname.
- **Credential handling:** AI apiKey, WebDAV/S3/Azure/GCS passwords all AES-256-GCM
  encrypted at rest (per-user HKDF-derived key). GET config endpoints return only
  non-secret info fields; `encryptedPassword`/`apiKey` never appear in responses.
- **Authorization:** every vault/blob/config route enforces `requireOwned` via
  `requireAuth` hook + `assertVaultOwner`; cross-user access returns 403 FORBIDDEN.
  Device-binding checked on sync push.
- **Snapshot store:** off by default (`GRAPHVAULT_SNAPSHOTS_ENABLED`); payload
  treated as opaque string (never parsed/executed server-side); `deleteToken`
  returned only on POST and never on GET; server stores only the SHA-256 hash with
  `timingSafeEqual` comparison; size cap (413) + count cap with oldest-first
  eviction + TTL sweep; strict `^[A-Za-z0-9_-]{16,32}$` id validation guards
  any filesystem path.
- **Input validation:** hash path params validated against `sha256:[0-9a-f]{64}`
  before filesystem access; all external inputs validated via zod schemas from
  `@graphvault/shared`.
- **Bug:** `buildIndex` did last-write-wins on nodes but built edges from ALL parsed entries, so a discarded duplicate's links survived as phantom edges. **Fix:** dedup parsed entries by path (last-wins) before building edges so nodes and edges stays consistent.

## DataSafe audit - beforeunload / React async-effect gap

### `flushAll` via `setRawNotes` loses the last keystrokes on hard close

- **Bug (`apps/web/app/vault/page.tsx` `flushAll`):** The `beforeunload` and `visibilitychange=hidden` flush called `vault.updateContent(path, draft)`, which dispatches a React state update (`setRawNotes`). Persistence happens in a `useEffect` that runs AFTER the browser paints - React's effect pipeline is asynchronous. Under `beforeunload`, the browser can unload the page before React runs the effect and `localStorage.setItem` is called, silently dropping the last unsaved keystrokes. This is the classic React-state-in-beforeunload trap.
- **Fix / rule:** Add `vault.directFlush(updates)` to `useVault` - it applies the pending draft patches to `latestNotesRef.current` and calls the adapter's `save()` DIRECTLY (bypassing `setRawNotes → useEffect`), then ALSO dispatches `setRawNotes` for the case where the tab is not actually closing (mobile background/resume). Wire `registerFlushOnExit` to `flushAllDirect` (which calls `directFlush`) instead of `flushAll` (which calls `updateContent`). The in-session flush on tab switch / unmount still uses `updateContent` since React's async pipeline is running there. Rule: **never rely on `setRawNotes → useEffect` for `beforeunload` writes; write directly to the adapter**.

## Graph perf - lazy-load placeholder

### "Lazy-load graph" was already done - verify the bundle before claiming a win

- **Symptom:** the ROADMAP listed "Lazy-load graph" as not started, but the heavy
  `react-force-graph-2d` (~186 kB) was ALREADY code-split: `ForceGraphCanvas` is
  imported via `next/dynamic` + `ssr: false` on both `/graph` and `/embed`, so the
  lib chunk never enters the 102 kB shared First-Load baseline nor the page's
  First-Load entry list.
- **How to verify (not just trust the route table):** the `next build` route table
  shows per-route First Load JS, but to PROVE the lib is split, inspect
  `apps/web/.next/app-build-manifest.json`: find the chunk whose minified bytes
  contain `forceEngine`/`ForceGraph`, then assert that chunk filename is NOT in
  `pages['/graph/page']`. It loads on mount via the dynamic import instead.
- **Rule:** before implementing a "make it lazy" task, build and inspect the
  manifest first - the heavy module may already be split, in which case the real
  remaining value is the loading UX, not the split. Report honestly rather than
  fabricating a First-Load delta.

### The dynamic `loading:` placeholder must live in the page chunk (it pays ~1 kB)

- **Rule:** a `next/dynamic` `loading` component renders BEFORE the lazy chunk
  arrives, so it ships in the page's initial chunk and must import nothing heavy
  (no force-graph, no engine) - a pure SVG/CSS skeleton. It adds a small constant
  (~1 kB here, 172→173 kB) to First Load by design; that's the cost of "click and
  use" instead of a dead screen. Fill the exact `h-full w-full` box the canvas
  will occupy (no layout shift), gate animation behind `motion-safe:` (respect
  `prefers-reduced-motion`), drive colours from the CSS-var `neutral` ramp
  (auto light/dark), and wrap it in an `aria-live="polite"` `role="status"` region.

## Wave 21 - design elevation (token-and-polish pass)

### Theme-flipping `text-neutral-950` on a FIXED accent fill breaks light mode

- **Symptom:** primary buttons used `bg-sky-500 text-neutral-950`. In dark mode
  `neutral-950` is near-black (good contrast on the sky fill); but because the
  ramp is CSS-var-driven, `neutral-950` flips to near-WHITE in light mode -> the
  label became near-invisible on the unchanged sky-500 button.
- **Root cause:** the button background is a fixed accent (`sky-500`, identical in
  both themes), but the text colour was a theme-aware neutral token. They must
  either both be fixed or both flip together.
- **Fix / rule:** when a control has a FIXED accent background that does not flip
  per theme (sky/emerald/amber buttons, the skip-link, the download CTA), set its
  foreground to a FIXED colour too (`text-white`, `text-white/75` for sub-labels),
  never a theme-flipping `text-neutral-9xx`. Grep `bg-(sky|emerald|amber|red|
violet)-[456]00.*text-neutral-9[0-5]0` after any ramp change. (A
  `bg-neutral-100 text-neutral-950` pairing IS safe - both flip together.)

### Refine the ramp by editing only the CSS-var triples; zero blast radius

- **Rule (reaffirmed):** elevating the whole app's colour was a pure edit to the
  `--n-50..950` triples in `globals.css` (cool-neutral dark + hand-tuned light,
  not a math inversion) - thousands of `bg-neutral-*`/`text-neutral-*` utilities
  updated with no per-component changes. Keep the light ramp HAND-TUNED (a real
  off-white paper feel with AA text) rather than the dark ramp inverted; a literal
  inversion gives a flat, glaring light mode. Update the `viewport.themeColor`
  hexes to match the new `--n-950` values in both schemes.

### Theme-aware elevation belongs in tokens, not hardcoded `shadow-black/NN`

- **Rule:** define `--shadow-{sm,md,lg,xl}` per theme (dark = soft low-alpha black;
  light = cool-neutral-tinted, NOT pure black, so it reads as ambient occlusion)
  and expose them as Tailwind `boxShadow` tokens (`shadow-elevation-*`) + plain
  `.elevation-*` utility classes. Raised glass surfaces (palette/popovers) also
  get a `ring-1 ring-white/[0.06]` hairline top edge. This keeps dark subtle and
  light gentle from one place instead of per-component `shadow-black/30`.

### Type scale + optical tracking as Tailwind `fontSize` tuples

- **Note:** overriding `theme.extend.fontSize` with `[size, { lineHeight,
letterSpacing }]` tuples gives a cohesive scale with progressively tighter
  negative tracking on display sizes (-0.02 -> -0.032em) - confident headings,
  comfortable body - without touching any component class. Only override the steps
  you tune; the rest fall back to Tailwind defaults.

## Wave 7 - spectacular graph (signature surface)

### Make node colour token-driven, not a hardcoded hex, so the graph is on-brand in both themes

- **Symptom:** the graph "felt generic" - every note was the same flat periwinkle
  blue (`#7aa2f7`), edges were near-invisible thin grey lines, no depth/hierarchy.
- **Root cause:** `CATEGORY_STYLE.note` was an arbitrary blue unrelated to the
  brand, and the canvas drew flat discs with a faint gradient + a single low-alpha
  grey edge colour that washed out (especially on the light page).
- **Fix / rule:** the default "note" colour is now the brand CYAN (matches
  `--accent-400`). The canvas re-resolves it at runtime from the live
  `--accent-400`/`--accent-300` tokens via `useGraphThemeColors`, so notes stay
  on-brand when the theme flips (the `model.ts` hex is only the dark fallback +
  legend swatch). Edges derive from a theme-aware `edge` `{r,g,b}` triple chosen
  by page-background luminance (light slate on dark, mid slate on light) and are
  drawn at per-type alpha. NEVER hardcode a canvas colour that has to work in both
  themes - read the token through the theme hook and the light theme comes for free.

### Lit-sphere nodes + degree-scaled resting glow give instant visual hierarchy

- **Rule:** draw nodes as lit spheres - a radial gradient with a bright off-centre
  core (`mix(base, white, 0.45)`) → base → slightly darker rim, plus a hairline
  rim stroke - instead of a flat disc. Add a soft ambient halo whose strength is
  normalised by `sqrt(degree)/sqrt(maxDegree)` so hubs glow more and visual weight
  tracks structural importance even at rest. Gate the halo OFF under
  `prefers-reduced-motion` AND in dense graphs (`> LABEL_NODE_CAP`) to stay calm +
  cheap. The hover/selection focus simply raises the same `glow` value to ~1 for
  the centre and ~0.7 for neighbours, so the highlight reuses one code path.

### Focused-subgraph edges in brand accent + directional particles read as "alive"

- **Rule:** when a node is focused (hover or select), light its incident edges in
  the bright accent (`--accent-300`) at high alpha, widen them, and run ONE
  `linkDirectionalParticle` along each (gated by reduced-motion / only when a focus
  exists). Everything else recedes to ~18% alpha. This makes relationships obvious
  without changing the layout - it is purely an accessor-driven repaint, so it
  composes with the existing search/timeline/context dimming. A faint constant
  curvature (0.08) on all single edges + 0.28 on multi-edges reads as organic arcs
  rather than a rigid web.

### Smoother settling = higher velocity decay, not fewer ticks

- **Rule:** jitter at rest comes from low damping, not from too many cooldown
  ticks. Raising `d3VelocityDecay` (0.32 → 0.42) and a touch more `warmupTicks`
  (24 → 40) settles the layout calmly and reduces the "twitchy" feel, while keeping
  `cooldownTicks` high enough that the graph reaches a stable shape before
  `onEngineStop` fires the gentle zoom-to-fit. All motion stays gated behind the
  reduced-motion branch (0 warmup/cooldown).

### Worktree gotchas for an isolated agent

- **Note:** an agent worktree starts WITHOUT `node_modules` and the branch may lag
  `origin/main`. Before building: `git checkout -B <branch> origin/main`, then
  `pnpm install --frozen-lockfile`, then build the workspace deps
  (`@graphvault/shared`, `engine`, `sync-core`) so the web `tsc --noEmit` can
  resolve their `dist` types. The smoke harness skips when Playwright's pinned
  Chromium build is absent; point `GV_SMOKE_CHROMIUM` at any installed
  `/opt/pw-browsers/chromium-*/chrome-linux/chrome` to actually exercise `/graph`.

## SecAudit - periodic sweep (post AI-BFF streaming + billing/plan-tier types)

### No new vuln found - streaming and redirect re-validation are structurally coupled, not just test-covered

- **What was re-verified:** `guardedFetch`'s hop loop calls `assertSafeUrl`
  (validate + DNS-resolve + private-range check) **unconditionally on every
  iteration**, before branching into the buffered-vs-`stream:true` transport
  path. The `stream` flag only changes how the FINAL 2xx response body is
  wired (live `ReadableStream` vs buffered `Buffer`) - it never skips or
  reorders the per-hop SSRF check. This means the guarantee "every redirect hop
  is re-validated" holds **by construction** for the streaming AI-BFF path too,
  not merely because a test happens to cover it - worth confirming by reading
  the control flow directly (would a refactor that special-cased `stream` early
  and `continue`d past validation be a regression? yes - so that shape is the
  thing to re-check first on any future `guardedFetch` diff).
- **Also re-verified clean:** every service under `apps/server/src/services/`
  that makes an outbound call (`ai.ts` buffered + streaming, `webdav.ts`,
  `s3.ts`, `azure.ts`, `gcs.ts`, `clip.ts`) imports and calls `guardedFetch` -
  zero raw `fetch(`/`http.request(` in `apps/server/src` outside `ssrf.ts`
  itself (grep confirms). The AI `custom` gateway (arbitrary user `baseUrl`)
  goes through the same guard as WebDAV/S3/Azure/GCS custom endpoints.
- **Rule:** when auditing a guard like this after a feature adds a new mode
  (streaming, a new provider, etc.), the fastest way to prove "the invariant
  still holds" is to find the one call site that enforces it and check that the
  new mode's code path is a **strict subset** (only changes the tail/body
  handling) rather than a parallel branch that could bypass the check earlier.

### `packages/shared/src/billing.ts` (plan/tier) is inert - confirm before auditing it as a "vector"

- **Finding:** the new open-core plan/tier schema (`planTierSchema`,
  `planInfoSchema`, `cloudFeatureSchema`, `planIncludes`) holds zero secrets
  (no payment token, no customer id, no webhook signing key - just an enum tier
  - subscription status + renewal date) and is **not wired into any server
    route or web import yet** (`grep -rl billing apps/server apps/web` returns
    nothing outside `packages/shared` itself). It cannot leak a credential or
    bypass authz because nothing calls it. Re-check this when a future PR
    actually wires a `/v1/billing` or `/v1/plan` route - at that point re-audit
    for the standard non-secret-GET / authz-owns-tier-mutation pattern used by
    `ai.ts`/`webdav.ts` configs.

### Content-addressed blob store is intentionally deployment-wide, not per-vault-owner - do not "fix" this without a design change

- **Re-confirmed (not new):** `GET/PUT/HEAD /v1/blobs/:hash` requires only a
  valid bearer token for _some_ user of the deployment, not `requireOwned` on a
  specific vault - any authenticated user can fetch any blob if they already
  know its exact `sha256:<hex>` hash. This is unchanged since v0 and is the
  correct trade-off for a preimage-resistant content-addressed store in
  `docs/security-basics.md`'s stated threat model ("single user or a small,
  trusted team... not a hardened multi-tenant SaaS") - knowing the hash
  requires already having the plaintext bytes, so this is not a practical
  disclosure primitive, only a theoretical same-deployment confirmation
  oracle. Do not scope blobs to `requireOwned` reactively during an audit
  sweep; if multi-tenant isolation is ever a real goal, that is a deliberate
  design change (vault-scoped blob namespacing), not a quick authz patch.

### Re-verified still intact: WebDAV double-encoded-dot traversal fix

- The `containsPathTraversal`/`containsTraversal` belt-and-suspenders guard
  (shared zod schema in `packages/shared/src/webdav.ts` + service-layer
  `joinWebDavUrl` in `apps/server/src/services/webdav.ts`) from the earlier
  `f1b15c9` fix is untouched by the later AI-BFF/billing/storage-proxy commits.
  The S3/Azure/GCS proxies never had this class of bug because their object
  path is a **literal Fastify route segment** (`/v1/storage/s3/object/
graphvault-vault.json`), not a wildcard/param that gets appended to a base URL
  - any other key falls through to a catch-all `*` route that just 400s, so
    there is no string-building step for an attacker to smuggle traversal into.

## CSP Trusted Types attempt - investigated end-to-end, shipped the safe half, blocked on a third-party sink

### Summary

Tried to close Milestone 15's last `⬜` (CSP Trusted Types). Built and tested
the full policy/wrapper infrastructure - a single, narrowly-scoped policy
(`apps/web/lib/security/trustedTypes.ts`, `graphvault-sanitized-html`, never a
blanket `'default'`) wired into all 3 `dangerouslySetInnerHTML` sites
(`MarkdownPreview.tsx`, `AssistantPanel.tsx`, `app/layout.tsx`'s theme-boot
script) via `toTrustedHTML()`. Did **not** add `require-trusted-types-for
'script'; trusted-types graphvault-sanitized-html;` to the CSP - real,
enforced testing found a genuine third-party blocker. Roadmap item stays `⬜`
with the blocker documented in `apps/web/lib/security/csp.ts` and here.

### The core lesson: "the build is green" is not evidence for a CSP change - you must load the built site in a real browser with the real header

A plain `pnpm run build:web` + `pnpm typecheck` + unit tests all passed with
the Trusted Types CSP directives added. It was only `node scripts/smoke-web.mjs`
(loads every exported route in real headless Chromium) that caught two
**separate** real breakages, neither of which any static check could see:

1. **First pass** (added `trusted-types graphvault-sanitized-html` only):
   `/graph` and `/embed` threw `TypeError: Failed to set the 'src' property on
'HTMLScriptElement': This document requires 'TrustedScriptURL' assignment.`
   Root cause: Next.js's webpack client build unconditionally sets
   `output.trustedTypes = 'nextjs#bundler'` (confirmed by grepping the built
   `_next/static/chunks/webpack-*.js` for `trustedTypes.createPolicy`), so its
   OWN chunk-loading runtime (`__webpack_require__.l`, used by every
   `next/dynamic` code-split chunk - exactly the lazy-loaded
   `react-force-graph-2d` chunk from the earlier "lazy-load graph" slice) tries
   to register a policy named `nextjs#bundler` for the `<script src>` URLs it
   creates. Our CSP only allow-listed our own policy name, so
   `trustedTypes.createPolicy('nextjs#bundler', …)` was refused by the browser
   (CSP violation), and the runtime fell back to a bare-string `script.src =`
   assignment, which the sink itself then rejected. **Fix that would have
   worked:** also allow-list `nextjs` and `nextjs#bundler` (Next.js's App
   Router route-loader/prefetch module registers the plain `nextjs` name for
   the same reason) in the `trusted-types` directive.

2. **Second pass** (added `nextjs` + `nextjs#bundler` too): the
   `TrustedScriptURL` errors disappeared, but `/graph` and `/embed` now threw
   `TypeError: Failed to set the 'innerHTML' property on 'Element': This
document requires 'TrustedHTML' assignment.`, tracked via a full stack
   trace to `force-graph/src/force-graph.js`'s Kapsule `init: function(domNode,
state) { domNode.innerHTML = ''; ... }` - the library's own container-wipe
   on mount, called via `react-kapsule`'s `useLayoutEffect` the instant the
   graph component mounts. This is **not fixable by allow-listing a policy
   name** the way the webpack case was, because `force-graph` never creates or
   uses a Trusted Types policy at all - it just assigns a bare string, and per
   the Trusted Types spec that's rejected unconditionally once ANY
   `trusted-types` directive is present, with no way to opt a specific
   third-party string in without either (a) a blanket `'default'` policy
   (explicitly rejected - would silently exempt every other future unaudited
   `innerHTML =` in the app too) or (b) patching the dependency.

   Also checked, empirically, whether a THIRD framework/library policy
   (DOMPurify's own internal `dompurify` policy, used for its internal HTML
   parsing step) would be needed - it was not: `/vault` (which renders real
   markdown through `DOMPurify.sanitize()`) passed with **zero console errors**
   even with `dompurify` deliberately absent from the allow-list. Read
   DOMPurify's source (`_createTrustedTypesPolicy`) to confirm why: it parses
   into a document created via `document.implementation.createHTMLDocument()`,
   which carries no CSP of its own, so Trusted Types simply isn't enforced on
   that internal sink regardless. This is a good example of _not_ fixing a
   theoretical problem that real-browser testing shows isn't actually live -
   the instinct to "just allow-list every library's policy name defensively"
   would have been wrong here.

3. **Why the `force-graph` sink can't be intercepted from our own component
   code:** the natural instinct is "wrap the container ref before the library
   touches it" (e.g. a `useLayoutEffect` in our own `ForceGraphCanvas.tsx` that
   installs a per-node `innerHTML` property-descriptor override before the
   child mounts). This doesn't work: `react-kapsule`'s wrapper does the actual
   `chart(domEl.current)` call (which triggers `force-graph`'s `.innerHTML =
''`) inside **its own** `useLayoutEffect`, and React fires layout
   effects/ref callbacks bottom-up (children before parents) during commit -
   so by the time any hook in our parent component would run, the child's
   layout effect (and the throw) has already happened. There is no user-space
   hook that runs early enough. (A global `Element.prototype.innerHTML`
   monkey-patch that only special-cased the literal empty string was
   considered and rejected: even scoped to `''`, patching a core Web API
   prototype app-wide is exactly the kind of "clever, hard-to-audit" move
   `CLAUDE.md` warns against, and it would make the "no blanket default
   policy" invariant misleading to a future reviewer who doesn't also know
   about the prototype patch.)

### What shipped vs. what didn't

- **Shipped:** `apps/web/lib/security/trustedTypes.ts` (policy + `toTrustedHTML()`
  - ambient typing in `apps/web/types/trusted-types.d.ts`, since this
    TypeScript/lib.dom.d.ts version has no real Trusted Types typings and
    `@types/react`'s `TrustedHTML` is an empty placeholder interface), wired into
    all 3 sinks; `apps/web/lib/security/csp.ts` (CSP extracted to a single
    source of truth, matching the existing `lib/themeScript.ts` pattern) +
    `csp.test.ts` (byte-for-byte `<meta>` vs `vercel.json` header sync check -
    this test would have caught the CSP-drift class of bug even before Trusted
    Types was on the table). All harmless when inactive: with no `trusted-types`
    CSP directive present, `window.trustedTypes.createPolicy()` still succeeds
    in Chromium (the directive only restricts which sinks/behaviors are
    _enforced_, not whether `createPolicy` itself is callable), so `toTrustedHTML()`
    is future-ready groundwork, not dead code.
- **Not shipped:** the CSP `require-trusted-types-for 'script'; trusted-types
…;` directives themselves, in either `vercel.json` or the `<meta>` tag.
  Roadmap stays `⬜`.

### Rule for the next attempt

Re-verify with the exact same method (headless Chromium, `scripts/smoke-web.mjs`
or equivalent, served with the REAL response header - not just the `<meta>`
tag, since that's what's authoritative on Vercel) against `/graph` and `/embed`
specifically, since those are the routes that load `react-force-graph-2d`.
Do not re-enable the CSP directive on the strength of `pnpm build` + unit
tests alone - this class of bug is invisible to both.

## Native desktop storage - wiring TauriStorageAdapter, and a real ACL/scope bug

Now that the Tauri native build actually compiles (previous entry), the next
logical step was to wire up the `TauriStorageAdapter` scaffold so the desktop
app can save real `.md` files on disk instead of webview `localStorage`. This
surfaced a second, independent runtime bug beyond the four build-time ones:

1. **The app shipped with zero Tauri capabilities.** `src-tauri/capabilities/`
   didn't exist, and Tauri 2 does NOT fall back to a permissive default in
   that case - `cargo build`'s own generated
   `gen/schemas/capabilities.json` was a literal empty `{}`. Every plugin
   command (fs, dialog) would have been denied at the ACL layer regardless of
   the separate scope problem below. Fixed by adding
   `capabilities/default.json` granting `fs:read-all` / `fs:write-all` (the
   permission set that enables the _commands_ with **no pre-configured
   path** - verified by reading `tauri-plugin-fs`'s own
   `permissions/read-all.toml` in the local cargo registry cache rather than
   guessing at the identifier).
2. **The static fs scope is deliberately empty; nothing ever grants the
   picked folder into it at runtime.** `tauri.conf.json`'s
   `plugins.fs.scope` is `{allow: [], deny: []}` by design (least privilege -
   no path is accessible until the user picks one), but `pick_vault_folder`
   was never updated to grant the runtime `Scope` object once a folder is
   chosen, so every `@tauri-apps/plugin-fs` call would fail even with the ACL
   fixed. Fixed with `tauri_plugin_fs::FsExt::fs_scope()` +
   `.allow_directory(path, true)` inside the command, confirmed to exist by
   reading the trait/impl directly in the cached crate source
   (`~/.cargo/registry/src/.../tauri-plugin-fs-2.5.1/src/lib.rs`,
   `tauri-2.11.5/src/scope/fs.rs`) rather than trusting memory of the API.

Both were found and fixed the same way as the M16 build bugs: by reading the
actual crate source in the local registry cache instead of assuming the
"obvious" Tauri 2 API shape, then confirming with a real `cargo check`
(capabilities.json regenerates as part of the build - inspecting
`gen/schemas/capabilities.json` after the build is a fast way to confirm a
capability was actually picked up, before ever launching the app).

### Architecture decision: move the adapter into `apps/web`, not `apps/desktop`

The original scaffold (`apps/desktop/src/tauriStorageAdapter.ts`) planned a
cross-package dynamic import (`@graphvault/desktop/src/tauriStorageAdapter`)
from the web layer. This was never actually wired, and going that route would
have added a needless dependency edge (apps/web depending on apps/desktop,
backwards from the usual package → app direction) plus package.json
`exports`-map plumbing. Since the adapter's own `isAvailable()` already
gates on `window.__TAURI__`, it's just as safe (and far simpler) to move it
next to every other adapter in `apps/web/lib/vault/storage/` and add
`@tauri-apps/api` + `@tauri-apps/plugin-fs` as ordinary (if Tauri-only-in-
practice) dependencies of `apps/web`. This let `apps/desktop/package.json`
shrink to just the Tauri CLI wrapper - no JS deps, no `tsconfig.json`, no
`typecheck` script (confirmed `pnpm -r run typecheck` skips packages missing
the script rather than failing).

### Evaluated and rejected: `tauri-plugin-persisted-scope`

The scope grant above only lives for the current process - relaunching the
app forgets the picked folder. The official fix for exactly this is
`tauri-plugin-persisted-scope`. Ran `cargo add` for real (not just read docs):
the only version satisfying this project's `rust-version = "1.77"` floor is
`0.1.3`, an early Tauri-v2-beta-era release whose own dependency chain
(`tauri "^2.0.0"` → `wry "^0.44.0"`) conflicts with `kuchikiki` as already
resolved by the current `tauri-plugin-dialog`, and `cargo check` fails
outright. Reverted immediately (`git checkout -- Cargo.toml Cargo.lock`,
confirmed `cargo check` clean again) rather than forcing it in. Documented
as a known, honest gap in the roadmap/README instead of silently shipping a
broken "remembers your folder" claim - re-attempt once newer releases relax
their `rustc`/`tauri` floor, or once this project's own `rust-version` is
raised.

### Testing a dynamic-`import()`-of-a-real-native-package boundary

`@tauri-apps/api`/`@tauri-apps/plugin-fs` throw outside an actual Tauri
webview, so they can't be exercised from `node --test`. Rather than reach for
`node:test`'s experimental `mock.module` (needs an extra CLI flag applied
repo-wide to the whole `apps/web` test script), added a plain test-only
override seam (`_setFsForTesting` / `_setInvokeForTesting`) matching the
existing `_resetRegistry`-for-tests convention already used in
`storage/index.ts` - simpler, no new test-runner flags, same pattern a future
reader already recognizes.

### Verification

Full gauntlet green (typecheck/lint/format/tests/build:web/smoke:web - the
new Settings code path that dynamically imports the Tauri packages was
exercised for real via `pnpm run smoke:web`, confirming `/settings` still
loads with zero client-side errors in headless Chromium). Additionally ran a
full `cargo build --release` + `tauri build` a second time (same method as
the M16 build-fix PR) and re-verified genuine `.deb`/`.rpm` output with
`file` - the capability/scope additions don't regress the native build.

## A real hydration crash on /vault, hidden by the smoke test's own design

### What happened

User feedback: "graphics look bad, bad flashes, scroll feels slow, home page
is cluttered, make sure themes work." Rather than guess at any of these,
loaded the actual built app in real headless Chromium (per this project's
standing rule) and found one genuine, severe, previously-shipped bug plus a
few smaller real ones - and left the "home page is cluttered" and "graph
scroll" complaints as subjective/unverified rather than making speculative
redesign changes I couldn't justify with evidence.

**The big one: React error #418 (hydration mismatch) crashed on every fresh
load of `/vault`.** Reproduced deterministically with a _fresh_ browser
context going straight to `/vault` - and it reproduced 100% of the time. But
`pnpm run smoke:web` - the exact regression guard built for this class of bug
in an earlier session - reported all 9 routes clean, every time. The reason:
`smoke-web.mjs` reused ONE browser context across all 9 routes in a fixed
order ending at `/vault`. Visiting literally any other route first (even the
unrelated `/404` page) made the subsequent `/vault` load clean. A real user
landing on `/vault` directly - a bookmark, a deep link, the first page of a
brand new session/PWA launch - hit the crash on every single visit, with zero
warning from any check in the gauntlet.

Root cause, found by stripping the CSP `<meta>` tag via `page.route()` so
`next dev`'s non-minified hydration diagnostics would actually render (the
production build only gives the useless minified error #418 with a link to
a decoder page): `AppFrame.tsx` mounted the mobile FAB
(`{pathname === '/vault' && <AddButton variant="fab" .../>}`) with no
SSR/first-paint guard. `usePathname()` did not agree between the statically
exported HTML (built with `next build`'s static export) and the browser's
first hydration pass on that exact route - the _file itself already had_ a
`hydrated` flag, set `true` in a post-mount `useEffect`, used two lines below
for exactly the same class of problem (the sidebar's persisted collapse
state) - it just wasn't applied to the FAB. Gating the FAB on the same flag
fixed it outright; verified 5/5 clean on a fresh context after the fix.

### Fixed the test, not just the bug

A bug a purpose-built regression test can't catch will ship again. Changed
`scripts/smoke-web.mjs` to open a fresh `browser.newContext()` **per route**
instead of one shared context for the whole run. This is strictly a better
regression guard for a test whose entire purpose is "does this route load
clean" - it should never depend on which other routes happened to run first.

### Smaller, real, verified fixes in the same pass

- `/favicon.ico` 404'd on every load (no favicon ever existed) - added an
  explicit `<link rel="icon">` pointing at the existing PWA icon.
- The CSP `<meta>` tag included `frame-ancestors 'none'`, which Chromium
  logs a console error for on every single page (browsers ignore
  `frame-ancestors` in `<meta>` per spec) - split `csp.ts` into `CSP` (full,
  for the `vercel.json` header, where it IS enforced) and `CSP_META` (used by
  `layout.tsx`, with `frame-ancestors` removed). The comment in the old code
  already _claimed_ this was already done ("frame-ancestors is intentionally
  omitted here") - it wasn't; the comment was aspirational, not accurate.
  Lesson: a comment describing intended behavior is not evidence the code
  does it - the console output from a real page load is.
- `NoteTree`'s scroll handler called `setScrollTop` (triggering a React
  re-render + virtualization recompute) on every native `scroll` event,
  unthrottled - `scroll` can fire faster than the display refreshes during a
  fast fling. Coalesced to one `requestAnimationFrame` per frame, the
  standard fix for this exact pattern.

### What I did NOT change, and why

Tried to attribute "scroll feels slow" on the landing page to a specific CSS
cause (the sticky header's `backdrop-blur-xl`, the two continuously-animating
`blur-2xl`/`blur-3xl` decorative blobs) via A/B frame-timing measurements
under CPU throttling. The measurements were too noisy in this sandboxed
environment to attribute the effect to either one with confidence - swings
between runs of the _same_ configuration were as large as the effect being
measured. Did not ship a speculative fix I couldn't verify actually helped;
confirmed instead that the animated blobs already animate only `transform`/
`opacity` (the cheap, compositor-only properties - already the correct
pattern). "Home page is cluttered" (a 4.5-screen-tall landing page) is a
genuine design-taste question, not a bug, and wasn't unilaterally redesigned
without more specific direction. Recorded here rather than silently dropped.

### Rule for next time

When a user reports "flashes/flicker" on a React app, check for a hydration
mismatch FIRST (real headless Chromium, `page.on('pageerror')`, a FRESH
context per route/session) before looking at animations or CSS - a hydration
crash presents visually as exactly the kind of flash a non-technical user
would describe, and is far more likely than a paint/animation issue to be a
severe, universally-reproducible bug rather than a subjective perception.

## Verify hype before building on it: "graphify" wasn't real, but the idea was

### What happened

User shared a social-media (Facebook) screenshot of a "Senior AI Engineer"
personal-brand post announcing "graphify" - `pip install graphify`, claiming
it turns a codebase into a queryable graph so AI coding assistants stop
reading files one-by-one, "cutting token usage up to 70x". Asked to add this
capability.

Checked before building anything: `pip index versions graphify` found
nothing, and `https://pypi.org/pypi/graphify/json` returned `{"message": "Not
Found"}`. Looking closer at the screenshot itself confirmed why - the fake
"terminal" output ("Requirement already satisfied: graphify in xnonpackoap",
"logic-timeon 1.3.1") isn't a real pip output format, and the file tree
underneath it has garbled names (`reross.py`, `seconaty`, `moduls.py`) - the
unmistakable signature of an AI-generated portfolio hero graphic with
placeholder text that was never filled in correctly, not a screenshot of
real, running software. The package plainly does not exist.

### What shipped anyway - the real idea behind the hype, done for real

The underlying concept (index a codebase as a graph so an AI agent queries it
instead of reading every file) is sound and already half-true of GraphVault's
own architecture (the MCP server does exactly this for a user's _notes_).
Extended the same idea to _source code_, built for real and dogfooded, not
copied from a screenshot:

- `@graphvault/engine`: `buildCodeGraph` / `parseImports` / `findDependencies`
  / `findDependents` - pure, filesystem-free (matches this package's existing
  invariant), regex-based static import extraction + relative-import
  resolution.
- `@graphvault/cli`: `walkSourceFiles` (fs walker, mirrors `vault.ts`'s
  pattern) + a new `codegraph` command (`--json`, `--dependencies <path>`,
  `--dependents <path>`).

### Dogfooding caught a real bug immediately

Ran `graphvault codegraph --vault packages/engine/src` against this repo's
own source the moment it built - and got **"0 resolved intra-repo"** imports,
on a purely TypeScript codebase where every single import already resolves.
Root cause: every import in this repo (and every modern TS-ESM project) is
written `from './foo.js'` even though the file on disk is `foo.ts` - that's
the standard TypeScript-ESM convention (the compiler rewrites the specifier
verbatim into the emitted JS, so it must point at the eventual `.js` output,
not the `.ts` source). The first resolver version only tried the literal
specifier plus _appending_ extensions - it never tried _swapping_ an existing
`.js`/`.jsx`/`.mjs`/`.cjs` extension for a TS one. Fixed by stripping a
trailing JS-family extension and retrying resolution against all source
extensions; added a regression test with the exact repro (`./b.js` resolving
to `b.ts`). Without dogfooding against a real, large TypeScript codebase (not
just synthetic fixtures), this would have shipped a tool that silently
produced near-empty output on its own primary target.

A second, smaller thing the same dogfood run surfaced: this file's own doc
comment used literal quoted example import syntax (`import x from 'spec'`)
to document the regex forms covered - which the tool's own regex then matched
as fake "imports" when scanning its own source. Not a bug in the resolver (a
regex-based, no-real-parser tool inherently can't distinguish code from a
comment or string that merely looks like code - already documented as a
known limitation), but cheap to reduce: rewrote the example text to use an
unquoted `SPEC` placeholder instead, so the module doesn't self-pollute its
own dogfood output.

### Rule for next time

Unverified social-media "just launched" AI-tool posts are not a citable
source for what to build - check the actual registry (PyPI/npm/crates.io)
before investing engineering time, and say so plainly if it doesn't exist
rather than silently building toward an unverified premise. Separately: for
any tool whose entire value proposition is "understand a real codebase,"
the first real test must be a real, large codebase (ideally this one) - a
handful of synthetic two-file fixtures will pass while missing the exact
convention (`.js` specifiers → `.ts` files) that a real TypeScript project
depends on for every single one of its internal imports.

## "Scrolling feels bad" was a real bug, not a subjective vibe: the sticky nav never stuck

### What happened

After an earlier pass on landing-page scroll performance came back inconclusive
(frame-timing A/B tests were too noisy in this sandbox to attribute a cause -
documented in the previous lessons entry, no speculative fix shipped), the
user repeated the complaint more strongly. Rather than re-run the same noisy
frame-timing methodology a second time, checked the header's actual behavior
directly: `page.locator('header').boundingBox()` after `window.scrollTo(0,
2000)` returned `{ y: -2000, ... }` - the "sticky" nav header was not sticky
at all. It scrolled away with the page exactly like a normal static element,
on every single page load, for every user, the whole time this landing page
has existed.

### Root cause

`<main>` had `overflow-x-hidden` (added to clip oversized decorative aurora
glow blobs that are wider than the viewport). Per the CSS Overflow spec, if
`overflow-x` is set to anything other than `visible` and `overflow-y` is left
at its default (`visible`), the browser instead computes `overflow-y` as
`auto` - the two axes can't have a "hidden + visible" split; one drags the
other off `visible`. That makes `<main>` a scroll-context-establishing
ancestor, and CSS `position: sticky` only sticks relative to its _nearest
scrolling ancestor's_ scrollport - not necessarily the true page viewport.
Confirmed empirically: removing `overflow-x-hidden` from `<main>` alone (no
other change) made the header's bounding box report `y: 0` at any scroll
depth.

### The fix, and why body-level overflow-x is the standard answer

Moved the horizontal-overflow guard from `<main>` to `body` (`globals.css`).
`overflow-x` on `body` specifically is a documented special case (the
"overflow propagation to the viewport" rule): when `<html>` has no explicit
overflow of its own, the `<body>`'s overflow value gets promoted to control
the _viewport's_ own scrolling instead of creating a nested scroll container
on `<body>` itself - so it does not have the sticky-breaking side effect that
`overflow-x` on any _other_ element does. This is why "put `overflow-x:
hidden` on `body`, never on an inner wrapper" is the standard, idiomatic fix
for "clip an oversized decorative element without breaking sticky
positioning elsewhere on the page" - not a GraphVault-specific workaround.

### Verified past a false alarm

After the fix, a naive check (`window.scrollTo(500, 0)` then read
`window.scrollX`) reported `500` - looking like the horizontal-overflow guard
had regressed. It hadn't: `window.scrollTo()`/`scrollLeft` assignment is a
JS API that some engines still honor even against an `overflow: hidden`
ancestor, which is NOT how a real user scrolls. Re-tested with
`page.mouse.wheel(800, 0)` (a real gesture) and got `scrollX: 0` - no drift.
Checked `getComputedStyle` too: `body` computed to `overflow-x: hidden;
overflow-y: auto` as expected, `html` stayed `visible`/`visible`. Lesson:
when verifying overflow/scroll-clipping behavior, drive it with a real input
gesture (`mouse.wheel`, a touch drag), not a programmatic `scrollTo()` call -
the two do not always respect the same CSS constraints.

### Rule for next time

"Feels bad" complaints about scrolling are not always about paint/frame-rate
performance (which is genuinely hard to measure reliably in a sandboxed
headless environment - see the earlier entry). Check the _functional_
behavior first and cheaply: does a `position: sticky` element that's supposed
to stay in view actually report a stable bounding box across a big scroll
delta? A broken sticky nav is a much more common, much more diagnosable root
cause than paint jank, and takes one `boundingBox()` call to rule in or out.

## Combining Obsidian + CherryTree: a third, independent graph model

### What happened

User asked for GraphVault to be "a combination of products like Obsidian and
CherryTree." CherryTree's core idea (distinct from Obsidian's) is explicit,
deep note-under-note nesting via a tree sidebar - independent of any file
hierarchy or cross-note links. GraphVault already has Obsidian's half
(wikilinks + graph); this adds CherryTree's half without touching either the
existing folder tree or the wikilink graph.

### Design: orthogonal, not a replacement

Added a `parent:` frontmatter field and a THIRD independent graph model
(`@graphvault/engine`'s `buildNoteHierarchy`), alongside the existing note
link graph (`graph.ts`) and the code import graph (`codeGraph.ts`, this same
session). A note can have a folder, tags, wikilinks, AND a hierarchy parent,
all at once, none of them conflicting - the hierarchy is metadata, not a
file move, so it costs nothing to add and nothing to ignore.

### Reused the exact safety patterns already established this session

- **Cycle-safety**: a note whose `parent` chain loops back to itself is
  placed at the root (flagged, not silently dropped) instead of infinite-
  looping - same "never lose a note, never crash" discipline as the code
  graph's unresolved-import handling earlier today.
- **Type boundary, not a shared type**: the web client has its OWN
  lightweight `ParsedNote` (a separate, deliberately simpler client-side
  parser - not `@graphvault/engine`'s parser at all), so `buildNoteHierarchy`
  takes a minimal structural `NoteHierarchyInput` (`{path, title,
frontmatter}`) rather than requiring the engine's full `ParsedNote` -
  letting both the engine's own parser AND the web client's independent one
  satisfy it without an adapter class, just a plain object literal at the
  call site.
- **Hydration safety**: the Folders/Hierarchy toggle's persisted preference
  reads `localStorage` in a `useEffect` after mount, not during the initial
  render or a `useState` initializer - exactly the pattern that was MISSING
  from `AppFrame.tsx`'s mobile FAB earlier this session and caused a real
  hydration-crash bug. Applied proactively here instead of found reactively.

### Verified end-to-end, not just unit-tested

Unit tests cover the pure `buildNoteHierarchy` logic (13 cases: multi-level
nesting, multiple roots, title-based resolution, 2- and 3-note cycles, self-
parenting, unresolvable parents). Separately, seeded a real seeded vault via
`localStorage` (multi-level nesting + a deliberately broken parent),
navigated the actual `/vault` page in headless Chromium, switched to
Hierarchy view, and confirmed via both a screenshot and the rendered tree
text that nesting, expand/collapse, the ⚠ on the broken parent, and clicking
through to open a note all work - not just that the underlying function
returns the right data shape.

### What's deferred, documented not silently dropped

v1 is read/render only - setting a note's parent is frontmatter-only (hand-
edit the YAML), no UI picker yet. Marked `⬜` in the roadmap rather than
implied as finished.

## The parent-picker UI almost shipped a real data-loss bug

### What happened

Immediate follow-up to the note hierarchy feature (previous entry): the
roadmap explicitly deferred "a UI to set a note's parent without hand-editing
frontmatter" as a fast-follow. Built it - a "Parent note (hierarchy)" section
in the Details panel with a native `<input list>` picker, backed by a new
pure `setFrontmatterField(content, key, value)` in the web client's own
`lib/vault/parse.ts` (add/replace/remove one scalar frontmatter field,
preserving every other line byte-for-byte - 9 unit tests including
value-quoting edge cases for colons and padded whitespace).

### The bug caught before shipping, not after

The wiring handler's first draft read the note's content from
`vault.getNote(path).content` - the last **persisted** version - rewrote the
`parent:` field into it, and called `vault.updateContent`. This looks
correct in isolation. It is not: the parent picker only ever renders for the
**currently open** note (the Details panel always shows the active tab), so
`path` here is always `activeTab.notePath` - meaning any time a user had
unsaved keystrokes in the editor (autosave hasn't flushed yet) and used the
picker, this rewrite would have silently overwritten those keystrokes with a
version built from the STALE persisted content plus the parent change -
classic silent data loss, and it would have shipped invisibly, since neither
typecheck nor the unit tests for `setFrontmatterField` itself would ever
catch it (the bug is in the CALLER's choice of which content to rewrite, not
in the pure function).

Caught by asking "what's the actual data flow here, given this UI can only
ever target the active note" rather than trusting that "reads the note, edits
one field, writes it back" was obviously safe. Fixed by rewriting from the
live `draft` React state (the in-editor text, including unsaved keystrokes)
whenever the target note is the active tab, falling back to persisted content
only for the (currently unreachable, but kept for safety) case where it
isn't.

### Rule for next time

Any time a new write path is added to an already-open, already-editable
document (not just a fresh create), ask explicitly: "could this note have
unsaved in-memory state that differs from what I'm about to read from
storage?" A function can be unit-tested, type-safe, and pass every existing
test while still discarding a user's most recent keystrokes if it reads from
the wrong source of truth. This is the same class of bug the autosave-on-
tab-switch and beforeunload/`directFlush` logic elsewhere in this codebase
already exists specifically to prevent - a new write path has to honor that
same invariant, not just parrot the SHAPE of "read, modify, write."

## A self-review caught a real round-trip bug in the frontmatter writer, hours after shipping it

### What happened

Doing a deliberate adversarial re-read of `setFrontmatterField`'s `quoteIfNeeded`
helper (shipped a few PRs earlier this same session) turned up a genuine
round-trip bug: it escaped an internal `"` as `\"` when WRITING a value that
needed quoting - but `unquote()` (the reader half, already existing code) only
ever strips a matching pair of _outer_ quote characters; it never un-escapes
anything inside them. So a parent value like `Chapter 1: "The Big Plan"`
(needs quoting because of the colon) would be written as
`parent: "Chapter 1: \"The Big Plan\""`, then read back as
`Chapter 1: \"The Big Plan\"` - literal backslashes baked into the string,
not matching the original at all. Confirmed empirically with a real call
through both `setFrontmatterField` and `splitFrontmatter`, not just reasoning
about the code - the "obvious" fix (backslash-escape the quote) is exactly
the kind of thing that looks correct on read-through but silently fails the
one property that actually matters: does it read back the same value it
wrote.

### The fix

Changed strategy entirely: instead of escaping, wrap the value in whichever
quote character (`"` or `'`) does NOT appear in it, so nothing inside ever
needs escaping - matching `unquote()`'s simplistic "strip the outer pair"
behavior exactly, since there's genuinely nothing to escape when the chosen
quote character never occurs inside the content. Falls back to double quotes
(best-effort, not perfectly round-trippable) only for the rare case where a
value contains BOTH quote characters at once. Also defensively flattens an
embedded raw newline to a space - this line-based writer has no way to
survive one (nothing downstream un-escapes it either), though no current
caller can actually produce one (the picker is a single-line `<input>`).

### Why this matters beyond the one bug

This function was already shipped, merged, and covered by "passing" tests -
the tests just didn't include a value containing a literal quote character,
so nothing caught it before. The lesson isn't "write more tests" in the
abstract; it's specifically: **when a function has a write side and a read
side maintained as a pair, test the actual round trip with adversarial
input for the read side's own known simplifications** - here, "the reader
doesn't un-escape anything" was already documented in the reader's own
history, which is exactly the clue that should have prompted testing a
quote-containing value in the writer's own test suite the first time.

### Rule for next time

After shipping any new "write" counterpart to an existing "read" function,
do one explicit pass asking "what does the read side assume that the write
side must therefore guarantee - and did I test that specific guarantee with
input designed to break it, not just input designed to exercise the happy
path?" A green test suite proves the cases you thought to write, not the
cases that actually matter.

## "This looks like garbage" with no screenshot - a real screenshot survey found a real bug

### What happened

User feedback this time was just "continue, because this looks like garbage"

- no screenshot, no specific page named. Rather than guess or ask for
  clarification immediately, took real screenshots of everything shipped in
  this session's recent stretch (hierarchy view, parent picker, details panel,
  both themes) to look for something concrete - the same discipline already
  established for vague visual complaints earlier in this session.

Found it in the split preview pane: a note's frontmatter block
(`---\nparent: Project.md\ntags: [design, ui]\n---`) was rendering as a
literal bold paragraph - `**parent: Project.md tags: [design, ui]**` - at
the very top of the rendered markdown, above the actual heading and body.
`MarkdownPreview.tsx` passed the FULL raw note content (frontmatter
included) straight to `renderMarkdown()` with no stripping at all.

### Not a new bug - but newly, visibly common

This was true for every note that ever had ANY frontmatter, since the
component was written - nothing about today's hierarchy feature caused it.
It just went from "rare, only visible on notes with manually-added
frontmatter" to "visible on every note that participates in the hierarchy,"
because that feature's whole point is adding a `parent:` field to notes.
Shipping a feature that makes existing users touch a code path more often is
exactly the kind of change that turns a latent, low-visibility bug into a
loud, obvious one - worth remembering as a reason to re-survey nearby UI
after any feature that changes how much a given data field gets used, even
when the new feature's own code is completely correct in isolation.

### The fix

One line: `splitFrontmatter(markdown).body` before calling
`renderMarkdown()`, reusing the already-thoroughly-tested `splitFrontmatter`
from `lib/vault/parse.ts` rather than writing new stripping logic. Confirmed
only one component (`MarkdownPreview.tsx`) needed it - grepped for every
`renderMarkdown` call site first; the other one (`AssistantPanel.tsx`)
renders AI responses, which never have frontmatter, so it was correctly
left alone rather than "fixed" defensively for a case that can't occur there.

### Rule for next time

When feedback is vague ("this looks bad") with no screenshot and no specific
page, take real screenshots of recently-changed surfaces before asking for
clarification - a vague complaint after a feature ships is often pointing at
a real, findable regression the feature made newly visible, not a
subjective taste question. Ask only after a genuine look turns up nothing.

## The whole session had only ever screenshotted desktop - mobile had a real overlap bug

### What happened

After several rounds of "make it beautiful" feedback and desktop-viewport
screenshot audits (landing page, settings, vault workspace), realized every
single visual check this entire session had used a 1440px desktop viewport.
Took real mobile-viewport (390×844, `isMobile: true`, `hasTouch: true`)
screenshots for the first time and found a genuine, concrete bug on the
first page checked: the mobile "+" FAB (fast-capture new-note button)
visibly overlapped the bottom pane-switcher nav bar's "Details" tab.

### Root cause, confirmed by measurement not eyeballing

Measured both elements' bounding boxes in headless Chromium rather than
trusting the screenshot alone: the FAB (`position: fixed; bottom: 0`,
positioned relative to the viewport) and the mobile nav bar (an ordinary
in-document-flow `<nav>`, 54px tall, added later than the FAB in this
project's history) overlapped by ~38px vertically - the FAB sat entirely
within the "Details" tab's horizontal span, silently eating part of its tap
target. `fixed` positioning doesn't know or care what's rendered in normal
flow at the same screen location; two independently-positioned pieces of
UI both claiming "the bottom of the screen" is exactly the kind of overlap
that never shows up in isolated component review, only in an integrated,
real-viewport screenshot.

### The fix, plus a second related bug found along the way

Cleared the nav bar's measured height (54px) plus original breathing room
(16px) in the FAB's bottom padding - a real measured number, not a guess.
While fixing this, noticed the FAB had no focus-mode awareness at all
(`AppFrame.tsx`'s render condition was just `hydrated && pathname ===
'/vault'`), while the nav bar it now had to clear correctly hides itself in
focus mode (distraction-free editing already hides the sidebar/details/nav
chrome). Left as-is, the FAB would have kept its now-larger padding with
nothing underneath to clear in focus mode - a smaller but still-real
"unexplained gap" bug. Fixed by hiding the FAB in focus mode too, matching
the mode's existing "hide all workspace chrome" intent rather than adding
special-cased conditional padding.

### Rule for next time

A "make it beautiful" mandate defaults to desktop-viewport screenshots
because that's what's convenient to capture and look at - actively
schedule a mobile-viewport pass as its own checklist item, not an
afterthought, especially for any component using `position: fixed`
(the single most common source of this exact class of overlap, since fixed
elements are blind to whatever else occupies the same screen coordinates).

## Native mobile: investigated for real, correctly concluded it can't be built here

### What happened

User first asked whether a Google AI Studio "Gemini builds Android apps in
Kotlin" tool was worth using to get a mobile app. Gave an honest recommendation
against it: a from-scratch native Kotlin app would throw away this project's
entire "one codebase across web + mobile + desktop" architecture for a result
already substantially covered by the installable PWA - a native app-store
presence, if genuinely wanted, belongs on Tauri Mobile (same framework
already proven working for desktop this session), not a disconnected rewrite.

User then explicitly asked to build native mobile. Investigated what's
actually achievable in this sandboxed session **before** writing any code or
claiming progress - same discipline as the earlier desktop-build investigation:

- `tauri android init` requires the official Android SDK to already exist
  locally - it refuses to even scaffold the project without it, let alone
  build. Getting the SDK requires downloading from `dl.google.com`.
- Tested that download directly rather than assuming: `curl` to
  `dl.google.com` returned a `403`, and the proxy's own status log confirmed
  it as a policy denial (`"gateway answered 403 to CONNECT (policy denial or
upstream failure)"`) - the exact same class of hard, non-negotiable block
  as the AppImage `AppRun` binary earlier this session. Checked for an
  alternative (Ubuntu `apt` ships scattered AOSP utility libraries under
  `android-*` package names) and confirmed they don't substitute for the
  official SDK layout Tauri's tooling expects.
- `tauri ios` isn't even a recognized subcommand on this Linux CLI build -
  iOS requires Xcode, which is an Apple-platform-only restriction with zero
  workaround on Linux, so the CLI doesn't pretend otherwise.

### What shipped instead of a build I couldn't verify

`docs/mobile-setup.md` - exact steps for the owner to run on a real machine
(Android Studio/SDK+NDK on any OS, or Xcode on a Mac), explaining precisely
why this reuses the existing Rust core + web frontend rather than being a
separate codebase, plus one concrete decision worth making before either
`init` command runs: `tauri.conf.json`'s `identifier` becomes the Android/iOS
package name verbatim, and renaming it now (before any store listing exists)
is free but gets disruptive later - flagged, not silently decided either way,
since the change couldn't be verified against a working build in this session.

### Rule for next time

"Environment-blocked" is a legitimate, complete answer when it's backed by an
actual attempted command and a real error message (or a direct network test
against the proxy's own status log) - not a guess that something "probably
won't work here." The difference between "I assume this needs X" and "I ran
the command, here's the exact error, here's the proxy's own confirmation of
why" is the difference between a shrug and a trustworthy report. Investigate
until you hit the real wall, then stop and document it - don't fabricate
partial progress (a scaffold that can't ever compile is not a deliverable),
and don't retry a confirmed policy denial hoping a different URL works.
