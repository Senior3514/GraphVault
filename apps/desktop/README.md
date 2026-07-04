# @graphvault/desktop - Tauri shell (Milestone 16)

GraphVault as a native desktop application. A lightweight Tauri 2 shell wraps
the existing Next.js web client so the full editor and graph view work
identically - no UI rewrite required.

> **Status: native build verified, native disk storage wired.** The Tauri
> shell compiles and bundles real installers (`cargo build --release` +
> `tauri build` produce genuine `.deb`/`.rpm`/`.AppImage` packages). Native
> `.md`-on-disk storage is now wired end-to-end: `TauriStorageAdapter` (in
> `apps/web/lib/vault/storage/tauriAdapter.ts`) is registered in the adapter
> registry and reachable from Settings → Storage location → "Open a vault
> folder (native)" whenever the app is running inside Tauri. One known gap:
> the picked folder is **not remembered across app restarts** yet (see
> "Known limitations" below) - re-pick it each session for now.

---

## Architecture

```
apps/desktop/
  src-tauri/
    Cargo.toml          Rust workspace member; Tauri 2 runtime + plugins
    build.rs            Tauri code-gen entry point
    tauri.conf.json     Window config, CSP, fs plugin static (empty) scope
    capabilities/
      default.json      ACL: which fs/dialog commands the main window may call
    src/main.rs          IPC commands: pick_vault_folder, app_version
    icons/               Placeholder icons (replace before release)
  package.json
  README.md              (this file)
```

The actual `StorageAdapter` implementation
(`apps/web/lib/vault/storage/tauriAdapter.ts`) lives in the web workspace, not
here - it is bundled and code-split the same way as every other adapter
(WebDAV, S3, File System Access, ...), and is completely inert outside a Tauri
webview (`isTauriRuntime()` gates every Tauri-only code path). `apps/desktop`
itself is Rust/Tauri-CLI only now; it has no TypeScript source of its own.

The web layer (`apps/web`) is otherwise unchanged. In production Tauri loads
the static export (`apps/web/out`); in development it proxies to the Next.js
dev server on `http://localhost:3000`.

---

## Prerequisites

| Tool             | Minimum version | Install                                      |
| ---------------- | --------------- | -------------------------------------------- |
| Rust + cargo     | 1.77            | <https://rustup.rs>                          |
| Tauri CLI        | 2.x             | `cargo install tauri-cli --version "^2"`     |
| Node.js          | 20              | <https://nodejs.org>                         |
| pnpm             | 9+              | `npm i -g pnpm`                              |
| System libraries | -               | See <https://tauri.app/start/prerequisites/> |

On **Linux** you additionally need `webkit2gtk-4.1`, `libappindicator3-1`,
`librsvg2-dev`, and `libssl-dev` (Debian/Ubuntu) or the equivalents for your
distro. On **macOS** Xcode command-line tools are sufficient. On **Windows**
Microsoft Edge WebView2 (pre-installed from Win11) or the installer from
<https://developer.microsoft.com/microsoft-edge/webview2/> is required.

---

## Running in development

```bash
# 1. Install JS dependencies (run once, from the repo root)
pnpm install

# 2. Start the Tauri dev build - this also starts the Next.js dev server.
#    The first run compiles Rust dependencies (~2-5 min); subsequent runs are fast.
pnpm --filter @graphvault/desktop dev
# or, from apps/desktop/:
pnpm dev
```

Internally `pnpm dev` runs `tauri dev`, which:

1. Executes `beforeDevCommand` → `pnpm --filter @graphvault/web dev` (Next.js on
   port 3000).
2. Compiles the Rust shell and opens a native window pointing at
   `http://localhost:3000`.
3. Hot-reloads Rust on source change (Cargo watch) and the web layer via
   Next.js Fast Refresh.

---

## Building for distribution

```bash
# From the repo root - builds web client to apps/web/out, then compiles Tauri.
pnpm --filter @graphvault/desktop build
# or, from apps/desktop/:
pnpm build
```

Internally `pnpm build` runs `tauri build`, which:

1. Executes `beforeBuildCommand` → `pnpm run build:web` (static export to
   `apps/web/out`).
2. Compiles an optimised Rust binary and bundles the static files into a
   platform installer (`.dmg` on macOS, `.msi`/NSIS on Windows,
   `.AppImage`/`.deb`/`.rpm` on Linux).

Installer output lands in:

```
apps/desktop/src-tauri/target/release/bundle/
```

---

## The `.md`-on-disk storage path (wired)

GraphVault has a pluggable `StorageAdapter` seam defined in
`apps/web/lib/vault/storage/index.ts`. `TauriStorageAdapter`
(`apps/web/lib/vault/storage/tauriAdapter.ts`) is the native implementation:

1. Settings → Storage location → "Open a vault folder (native)" invokes the
   Rust `pick_vault_folder` IPC command, which shows the OS folder picker
   **and** grants that one folder to the `fs` plugin's runtime scope (see
   "Security posture" below).
2. `@tauri-apps/plugin-fs` reads/writes real `.md` files in that directory -
   one file per note, vault-relative paths preserved.
3. `tauriStorageAdapter` is registered into the adapter registry
   unconditionally at module load (`apps/web/lib/vault/store.ts`); its
   `isAvailable()` stays `false` (falling through to the next adapter) until
   both `window.__TAURI__` is present AND a folder has been picked, so it is
   fully inert in a plain browser or the hosted PWA.
4. Switching to it goes through the same copy-verify-activate
   `migrateAdapter()` path as every other backend (WebDAV, S3, File System
   Access) - the previous backend's notes are preserved as a backup, never
   auto-cleared.

Because `TauriStorageAdapter` implements exactly the same `StorageAdapter`
interface as every other backend, no editor/vault-page changes were needed.

### File layout on disk

```
~/Documents/MyVault/
  notes.md
  ideas/
    brainstorm.md
    todo.md
```

### Security posture

- **Allowlist is minimal**: only `tauri-plugin-fs` and `tauri-plugin-dialog`
  are loaded; no shell, HTTP, or clipboard plugins.
- **FS scope is least-privilege and dynamic**: the `fs` plugin's _static_
  scope (`tauri.conf.json` → `plugins.fs.scope`) stays permanently empty - no
  path is pre-approved at build time. `capabilities/default.json` grants the
  `fs:read-all` / `fs:write-all` _command_ permissions (which commands may be
  called) with **no path attached**; `pick_vault_folder` (in
  `src-tauri/src/main.rs`) is the _only_ place a path is ever added to the
  scope, via `app.fs_scope().allow_directory(path, true)`, and only for the
  single folder the user just explicitly chose.
- **Known limitation - no persistence across restarts**: the scope grant lives
  in the running process's memory only; it is not restored when the app
  relaunches, so the folder must be re-picked each session. The standard fix
  is the official `tauri-plugin-persisted-scope` crate, evaluated and
  rejected for now - see the doc comment at the top of `tauriAdapter.ts` for
  the exact dependency conflict found and the conditions under which to retry.
- **CSP**: configured in `tauri.conf.json`; scripts limited to `'self'`;
  `connect-src` allows `localhost:*` only in dev mode.
- **No auto-update**: not enabled yet; add `tauri-plugin-updater` and
  code-signing before enabling.

---

## Native file watching (planned)

Now that native disk storage is wired, the next step is native file watching
via `tauri-plugin-fs`'s `watch` API. This lets an external editor (VS Code,
etc.) modify notes on disk and have GraphVault pick up the changes without a
manual reload - replacing the current "poll on focus" approach.

---

## Integration note (for the orchestrator)

`apps/desktop` is a pnpm workspace member (already covered by the `apps/*`
glob in `pnpm-workspace.yaml`) containing only the Rust/Tauri-CLI shell - no
TypeScript source of its own. `@tauri-apps/api` and `@tauri-apps/plugin-fs`
are `dependencies` of `apps/web/package.json` instead (that's where
`tauriAdapter.ts` lives and gets bundled/code-split); `@tauri-apps/plugin-dialog`
is used only from Rust (`pick_vault_folder` calls it directly, not via IPC from
the web layer), so it is a Rust-only dependency and has no JS-side package.
