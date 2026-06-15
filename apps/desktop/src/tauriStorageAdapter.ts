/**
 * Tauri native filesystem {@link StorageAdapter}.
 *
 * This adapter satisfies exactly the same `StorageAdapter` interface defined in
 * `apps/web/lib/vault/storage/index.ts` — no UI changes are required to use
 * it in the desktop build.
 *
 * ## How it works
 *
 * 1. On first use the web layer calls `TauriStorageAdapter.pickFolder()`, which
 *    invokes the Rust-side `pick_vault_folder` command and stores the returned
 *    absolute path.
 *
 * 2. Subsequent `load()` / `save()` / `clear()` calls use `@tauri-apps/plugin-fs`
 *    to read and write real `.md` files at that path via Tauri's IPC bridge —
 *    bypassing the File System Access browser API entirely (which requires a
 *    user gesture each session in a browser, but not in Tauri).
 *
 * ## Security
 *
 * - The fs plugin scope is configured in `src-tauri/tauri.conf.json` to the
 *   vault directory chosen by the user.  No other path is accessible.
 * - The adapter never executes arbitrary shell commands; all disk operations go
 *   through the typed `@tauri-apps/plugin-fs` surface.
 *
 * ## Wire-up in the web layer (no UI changes needed)
 *
 * In `apps/web/lib/vault/storage/index.ts` a new adapter can be conditionally
 * registered at app startup when running inside Tauri:
 *
 * ```ts
 * // Detect Tauri: window.__TAURI__ is injected by the Tauri runtime.
 * if (typeof window !== 'undefined' && '__TAURI__' in window) {
 *   const { tauriStorageAdapter } = await import('@graphvault/desktop/src/tauriStorageAdapter');
 *   registerAdapter(tauriStorageAdapter);
 * }
 * ```
 *
 * The desktop build is the only consumer — this file is NOT imported from the
 * web app's source tree.
 *
 * ## Status (Milestone 16)
 *
 * The interface and wiring plan are complete. The concrete read/write logic
 * (`readTextFile`, `writeTextFile`, `readDir`, `remove`) from
 * `@tauri-apps/plugin-fs` is stubbed below and ready to be fleshed out when
 * the Tauri toolchain is available in the build environment.
 */

import { invoke } from '@tauri-apps/api/core';

// We import types only from the plugin so this file can be type-checked without
// a full Tauri runtime present (e.g. in a dry-run CI that only runs tsc).
import type { StorageAdapter } from '../../apps/web/lib/vault/storage/index';
import type { Note } from '../../apps/web/lib/vault/types';

// ---------------------------------------------------------------------------
// Tauri IPC helpers
// ---------------------------------------------------------------------------

/** Invoke the Rust `pick_vault_folder` command and return the chosen path. */
async function invokePicker(): Promise<string | null> {
  return invoke<string | null>('pick_vault_folder');
}

// ---------------------------------------------------------------------------
// Runtime fs helpers (lazy-imported to avoid hard dependency in non-Tauri env)
// ---------------------------------------------------------------------------

type FsPlugin = typeof import('@tauri-apps/plugin-fs');

let _fs: FsPlugin | null = null;

async function fs(): Promise<FsPlugin> {
  if (!_fs) {
    _fs = await import('@tauri-apps/plugin-fs');
  }
  return _fs;
}

// ---------------------------------------------------------------------------
// TauriStorageAdapter
// ---------------------------------------------------------------------------

/**
 * A {@link StorageAdapter} that reads and writes real `.md` files on the host
 * filesystem via the Tauri fs plugin.
 *
 * This is the M16 equivalent of `FileSystemAdapter` for the desktop shell.
 * Its interface is identical; the only difference is the I/O layer underneath.
 */
export class TauriStorageAdapter implements StorageAdapter {
  readonly id = 'tauriFs';
  readonly label = 'Native filesystem (Tauri)';

  private vaultPath: string | null = null;

  constructor(vaultPath?: string) {
    this.vaultPath = vaultPath ?? null;
  }

  // ------------------------------------------------------------------
  // Factory / configuration
  // ------------------------------------------------------------------

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
  setVaultPath(path: string): void {
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
    return (
      typeof window !== 'undefined' &&
      '__TAURI__' in window &&
      this.vaultPath !== null
    );
  }

  /**
   * Walk the vault directory recursively and read every `.md` file.
   *
   * Files that cannot be read are surfaced as notes with an error-marker
   * content string — matching the data-safety contract of `FileSystemAdapter`.
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
            const errorContent =
              `<!-- GraphVault: failed to read file "${relPath}": ${String(err)} -->`;
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
        // `mkdir` with `recursive: true` is a no-op if the directory exists.
        await mkdir(dir, { recursive: true });
      }

      await writeTextFile(`${dir}/${filename}`, note.content);
    }
  }

  /**
   * Remove all `.md` files that were loaded from the vault directory.
   * Does not remove directories or non-`.md` files.
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
