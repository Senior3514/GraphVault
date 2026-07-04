/**
 * Tauri native filesystem {@link StorageAdapter} (Milestone 16).
 *
 * Reads and writes real `.md` files on the host filesystem via
 * `@tauri-apps/plugin-fs`, for the desktop build only. It lives alongside the
 * other adapters (not in `apps/desktop`) so it is bundled and code-split the
 * same way as `fileSystemAdapter.ts` - the desktop app is just the same web
 * export running inside a Tauri webview, and `isAvailable()` keeps this
 * adapter completely inert (never touching the Tauri APIs) in every other
 * environment (plain browser, SSR, the Vercel-hosted PWA).
 *
 * ## How it works
 *
 * 1. `TauriStorageAdapter.pickFolder()` invokes the Rust `pick_vault_folder`
 *    IPC command, which shows the native folder picker AND grants that
 *    folder (only that folder) to the `fs` plugin's runtime scope - see the
 *    command's implementation in `apps/desktop/src-tauri/src/main.rs`. The
 *    plugin's *static* scope (`tauri.conf.json` → `plugins.fs.scope`) stays
 *    empty; no path is accessible until the user explicitly picks one.
 * 2. Subsequent `load()` / `save()` / `clear()` calls use
 *    `@tauri-apps/plugin-fs` to read/write real files at that path.
 *
 * ## Known limitation: no cross-restart persistence (yet)
 *
 * The fs plugin's scope grant lives in memory for the running process only -
 * it is not restored when the app is relaunched, so the folder must be
 * re-picked each session. The standard fix is the official
 * `tauri-plugin-persisted-scope` crate, which auto-saves/restores scope
 * across launches. It was evaluated and rejected for now: version 0.1.3 (the
 * only version compatible with this project's `rust-version = "1.77"` pin)
 * pulls in a `tauri = "^2.0.0"` / `wry = "^0.44.0"` dependency chain that
 * conflicts with the `kuchikiki` crate already resolved by the current
 * `tauri-plugin-dialog` version, breaking `cargo check` entirely. Newer
 * releases of the plugin need `rustc >= 1.77.2`. Re-attempt once the
 * `rust-version` floor is raised, or once a compatible release ships.
 */

import type { StorageAdapter } from './index';
import type { Note } from '../types';

// ---------------------------------------------------------------------------
// Tauri runtime detection
// ---------------------------------------------------------------------------

/** True when running inside the Tauri desktop webview (not a plain browser). */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

// ---------------------------------------------------------------------------
// Tauri IPC / fs helpers (lazy-imported so a plain browser build never pulls
// in `@tauri-apps/*` code paths that would throw outside a Tauri webview)
// ---------------------------------------------------------------------------

type InvokeFn = (cmd: string) => Promise<string | null>;
type FsPlugin = typeof import('@tauri-apps/plugin-fs');

// Test-only override seams (see `_setInvokeForTesting` / `_setFsForTesting`
// below) so unit tests can exercise load/save/clear against an in-memory fake
// instead of the real `@tauri-apps/*` packages, which throw outside an actual
// Tauri webview and cannot be driven from a plain Node test runner.
let _invokeOverride: InvokeFn | null = null;
let _fsOverride: FsPlugin | null = null;

async function invokePicker(): Promise<string | null> {
  if (_invokeOverride) return _invokeOverride('pick_vault_folder');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>('pick_vault_folder');
}

async function fs(): Promise<FsPlugin> {
  if (_fsOverride) return _fsOverride;
  return import('@tauri-apps/plugin-fs');
}

/** Test-only: replace the `invoke` call with a fake. Pass `null` to restore. */
export function _setInvokeForTesting(fn: InvokeFn | null): void {
  _invokeOverride = fn;
}

/** Test-only: replace the `@tauri-apps/plugin-fs` module with a fake. */
export function _setFsForTesting(fake: FsPlugin | null): void {
  _fsOverride = fake;
}

// ---------------------------------------------------------------------------
// TauriStorageAdapter
// ---------------------------------------------------------------------------

/**
 * A {@link StorageAdapter} that reads and writes real `.md` files on the host
 * filesystem via the Tauri fs plugin. The desktop equivalent of
 * `FileSystemAdapter` (which uses the browser's File System Access API).
 */
export class TauriStorageAdapter implements StorageAdapter {
  readonly id = 'tauriFs';
  readonly label = 'Native filesystem (Tauri desktop)';

  private vaultPath: string | null = null;

  constructor(vaultPath?: string) {
    this.vaultPath = vaultPath ?? null;
  }

  /**
   * Open the native folder picker and return a configured adapter.
   * Returns `null` when the user dismisses the dialog.
   */
  static async pickFolder(): Promise<TauriStorageAdapter | null> {
    const chosen = await invokePicker();
    if (!chosen) return null;
    return new TauriStorageAdapter(chosen);
  }

  /** Set (or replace) the vault directory without showing the picker. */
  setVaultPath(path: string | null): void {
    this.vaultPath = path;
  }

  /** The currently configured vault directory, or `null`. */
  get path(): string | null {
    return this.vaultPath;
  }

  // ------------------------------------------------------------------
  // StorageAdapter implementation
  // ------------------------------------------------------------------

  isAvailable(): boolean {
    return isTauriRuntime() && this.vaultPath !== null;
  }

  /**
   * Walk the vault directory recursively and read every `.md` file.
   *
   * Files that cannot be read are surfaced as notes with an error-marker
   * content string - matching the data-safety contract of `FileSystemAdapter`.
   */
  async load(): Promise<Note[]> {
    const root = this._requirePath();
    const { readDir, readTextFile } = await fs();

    const notes: Note[] = [];

    async function walk(dir: string, prefix: string): Promise<void> {
      const entries = await readDir(dir);
      for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          await walk(`${dir}/${entry.name}`, relPath);
        } else if (entry.isFile && entry.name.endsWith('.md')) {
          try {
            const content = await readTextFile(`${dir}/${entry.name}`);
            const now = Date.now();
            notes.push({ path: relPath, content, mtime: now, ctime: now });
          } catch (err) {
            const errorContent = `<!-- GraphVault: failed to read file "${relPath}": ${String(err)} -->`;
            const now = Date.now();
            notes.push({ path: relPath, content: errorContent, mtime: now, ctime: now });
          }
        }
      }
    }

    await walk(root, '');
    return notes;
  }

  /** Write each note as a `.md` file under the vault directory. */
  async save(notes: Note[]): Promise<void> {
    const root = this._requirePath();
    const { mkdir, writeTextFile } = await fs();

    for (const note of notes) {
      const parts = note.path.split('/');
      const filename = parts[parts.length - 1];
      const subdirs = parts.slice(0, -1);

      let dir = root;
      for (const seg of subdirs) {
        dir = `${dir}/${seg}`;
        // `recursive: true` makes this a no-op if the directory exists.
        await mkdir(dir, { recursive: true });
      }

      await writeTextFile(`${dir}/${filename}`, note.content);
    }
  }

  /**
   * Remove every `.md` file that a fresh {@link load} currently tracks.
   * Does not remove directories or non-`.md` files - no arbitrary wipe.
   */
  async clear(): Promise<void> {
    const { remove } = await fs();

    let existing: Note[];
    try {
      existing = await this.load();
    } catch {
      return;
    }

    const root = this._requirePath();
    for (const note of existing) {
      try {
        await remove(`${root}/${note.path}`);
      } catch {
        // Partial clear is better than aborting.
      }
    }
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private _requirePath(): string {
    if (!this.vaultPath) {
      throw new Error(
        'TauriStorageAdapter: no vault path configured. ' +
          'Call TauriStorageAdapter.pickFolder() with a user gesture first, ' +
          'or use setVaultPath() to restore a previously chosen path.',
      );
    }
    return this.vaultPath;
  }
}

/**
 * Singleton template instance for the adapter registry.
 * `isAvailable()` returns `false` until the user picks a folder.
 */
export const tauriStorageAdapter = new TauriStorageAdapter();
