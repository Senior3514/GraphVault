# @graphvault/desktop — Tauri shell (Milestone 16)

GraphVault as a native desktop application. A lightweight Tauri 2 shell wraps
the existing Next.js web client so the full editor, graph view, and storage-seam
work identically — no UI rewrite required.

---

## Architecture

```
apps/desktop/
  src-tauri/
    Cargo.toml          Rust workspace member; Tauri 2 runtime + plugins
    build.rs            Tauri code-gen entry point
    tauri.conf.json     Window config, CSP, fs plugin scope
    src/main.rs         IPC commands: pick_vault_folder, app_version
    icons/              Placeholder icons (replace before release)
  src/
    tauriStorageAdapter.ts  StorageAdapter shim (TypeScript, Tauri IPC)
  tsconfig.json
  package.json
  README.md             (this file)
```

The web layer (`apps/web`) is unchanged.  In production Tauri loads the static
export (`apps/web/out`); in development it proxies to the Next.js dev server on
`http://localhost:3000`.

---

## Prerequisites

| Tool | Minimum version | Install |
|------|----------------|---------|
| Rust + cargo | 1.77 | <https://rustup.rs> |
| Tauri CLI | 2.x | `cargo install tauri-cli --version "^2"` |
| Node.js | 20 | <https://nodejs.org> |
| pnpm | 9+ | `npm i -g pnpm` |
| System libraries | — | See <https://tauri.app/start/prerequisites/> |

On **Linux** you additionally need `webkit2gtk-4.1`, `libappindicator3-1`,
`librsvg2-dev`, and `libssl-dev` (Debian/Ubuntu) or the equivalents for your
distro.  On **macOS** Xcode command-line tools are sufficient.  On **Windows**
Microsoft Edge WebView2 (pre-installed from Win11) or the installer from
<https://developer.microsoft.com/microsoft-edge/webview2/> is required.

---

## Running in development

```bash
# 1. Install JS dependencies (run once, from the repo root)
pnpm install

# 2. Start the Tauri dev build — this also starts the Next.js dev server.
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
# From the repo root — builds web client to apps/web/out, then compiles Tauri.
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

## The `.md`-on-disk storage path

GraphVault already has a pluggable `StorageAdapter` seam defined in
`apps/web/lib/vault/storage/index.ts`.  The desktop build adds a native
implementation (`src/tauriStorageAdapter.ts`) that:

1. Invokes the Rust `pick_vault_folder` IPC command to show the OS folder picker.
2. Uses `@tauri-apps/plugin-fs` to read/write real `.md` files in the chosen
   directory — one file per note, vault-relative paths preserved.
3. Exports `tauriStorageAdapter` as a singleton that the web layer registers into
   the adapter registry when it detects `window.__TAURI__`:

```ts
// Example wiring in apps/web/lib/vault/storage bootstrap (NOT yet added — M17):
if (typeof window !== 'undefined' && '__TAURI__' in window) {
  const { tauriStorageAdapter } = await import(
    // Path must be adjusted once the desktop package is wired as a dep
    '@graphvault/desktop/src/tauriStorageAdapter'
  );
  registerAdapter(tauriStorageAdapter);
}
```

Because `TauriStorageAdapter` implements exactly the same `StorageAdapter`
interface as `FileSystemAdapter` and `LocalStorageAdapter`, **no UI changes are
needed** in the editor, vault page, or Settings to switch to native disk I/O.

### File layout on disk

```
~/Documents/MyVault/
  notes.md
  ideas/
    brainstorm.md
    todo.md
  .graphvault/         ← metadata / index (planned, M16/M17)
```

### Security posture

- **Allowlist is minimal**: only `tauri-plugin-fs` and `tauri-plugin-dialog` are
  loaded; no shell, HTTP, or clipboard plugins.
- **FS scope**: the `fs` plugin starts with an empty `allow` list; scope is
  added dynamically via the `pick_vault_folder` IPC return value. Files outside
  the chosen folder are not accessible to the webview.
- **CSP**: configured in `tauri.conf.json`; scripts limited to `'self'`;
  `connect-src` allows `localhost:*` only in dev mode.
- **No auto-update**: not enabled in this scaffold; add `tauri-plugin-updater`
  and code-signing before enabling.

---

## Native file watching (planned — Milestone 17)

Once the storage adapter is wired end-to-end, the next step is native file
watching via `tauri-plugin-fs`'s `watch` API.  This lets an external editor
(VS Code, etc.) modify notes on disk and have GraphVault pick up the changes
without a manual reload — replacing the current "poll on focus" approach.

---

## Integration note (for the orchestrator)

`apps/desktop` is a new pnpm workspace member (already covered by the
`apps/*` glob in `pnpm-workspace.yaml`).  No root config changes are needed.

The `@tauri-apps/api`, `@tauri-apps/plugin-fs`, and `@tauri-apps/plugin-dialog`
JS packages are listed as `dependencies` in `apps/desktop/package.json`.  Run
`pnpm install` from the repo root to install them; the orchestrator owns the
lockfile regeneration step.

The `tauriStorageAdapter.ts` imports `StorageAdapter` and `Note` **by type
only** from `apps/web/…` (erased at compile time, no runtime dep); no new
`workspace:*` entry in the web package is needed.
