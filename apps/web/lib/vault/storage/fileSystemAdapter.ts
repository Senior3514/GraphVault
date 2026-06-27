/**
 * File System Access API-backed {@link StorageAdapter}.
 *
 * Each {@link Note} is stored as a real `.md` file inside a user-picked
 * directory handle. Path separators are preserved so `notes/ideas.md` becomes
 * a subdirectory `notes/` containing `ideas.md`.
 *
 * ## Availability
 * The File System Access API (`window.showDirectoryPicker`) is available in
 * Chromium-based browsers (Chrome 86+, Edge 86+, Opera 73+) and partially in
 * Safari 15.2+ (no `showDirectoryPicker` yet). The adapter degrades gracefully:
 * `isAvailable()` returns `false` in any environment where the API is absent
 * (Firefox, Safari < 15.2, Node, SSR). The registry will then fall through to
 * the localStorage adapter.
 *
 * ## Desktop reuse
 * The Tauri desktop app (Milestone 16) will wire a native FS shim that
 * satisfies the same {@link StorageAdapter} interface without using the web API
 * at all, so no UI changes are needed when the desktop path is added.
 *
 * ## Persistence of the directory handle
 * The Web API requires a user gesture to open a directory picker. This adapter
 * does NOT automatically re-open the picker on every page load - callers must
 * invoke {@link FileSystemAdapter.create} once per session with a user gesture,
 * then pass the resulting adapter to the registry (or swap it as the active
 * backend via Settings).
 *
 * ## Error handling / data-safety contract
 * - `load()` never silently drops notes: if a file read fails, a placeholder
 *   note with an error marker is returned so the caller can surface the problem.
 * - `save()` writes files atomically within the same directory; if a
 *   sub-directory for a nested path cannot be created, the error is rethrown so
 *   callers can detect partial saves.
 * - `clear()` removes only `.md` files that are part of the loaded note set;
 *   it does not wipe arbitrary files from the user's disk.
 */

import { seedNotes } from '../seed';
import type { Note } from '../types';
import type { StorageAdapter } from './index';
import {
  clearDirectoryHandle,
  loadDirectoryHandle,
  saveDirectoryHandle,
} from './handleStore';

// ---------------------------------------------------------------------------
// Minimal local interfaces for File System Access API surfaces we use.
//
// We use GV-prefixed names to avoid colliding with partial/inconsistent
// declarations already present in lib.dom.d.ts across different TS versions.
// TypeScript 5.x ships `FileSystemDirectoryHandle` but the writable stream
// and async-iterable parts are not always stable; prefixed interfaces avoid
// any re-declaration error while still letting us type-check the logic.
// ---------------------------------------------------------------------------

interface GVWritableFileStream {
  write(data: string | ArrayBuffer | ArrayBufferView | Blob): Promise<void>;
  close(): Promise<void>;
}

interface GVFileHandle {
  readonly kind: string;
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<GVWritableFileStream>;
}

/** Permission descriptor + state surfaces (not always in lib.dom.d.ts). */
type GVPermissionState = 'granted' | 'denied' | 'prompt';
interface GVPermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface GVDirectoryHandle {
  readonly kind: string;
  readonly name: string;
  values(): AsyncIterableIterator<GVDirectoryHandle | GVFileHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<GVFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<GVDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  queryPermission?: (descriptor?: GVPermissionDescriptor) => Promise<GVPermissionState>;
  requestPermission?: (descriptor?: GVPermissionDescriptor) => Promise<GVPermissionState>;
}

interface GVDirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: string;
}

// ---------------------------------------------------------------------------
// Safe accessor for `window.showDirectoryPicker` without re-declaring Window.
// Using `(window as unknown as Record<string, unknown>)` avoids any conflict
// with existing lib.dom.d.ts declarations.
// ---------------------------------------------------------------------------

function getShowDirectoryPicker():
  | ((options?: GVDirectoryPickerOptions) => Promise<GVDirectoryHandle>)
  | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    const fn = (window as unknown as Record<string, unknown>)['showDirectoryPicker'];
    return typeof fn === 'function'
      ? (fn as (options?: GVDirectoryPickerOptions) => Promise<GVDirectoryHandle>)
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk a directory handle recursively, yielding every `.md` file together with
 * its vault-relative path (using forward slashes).
 */
async function* collectMdFiles(
  dir: GVDirectoryHandle,
  prefix: string,
): AsyncGenerator<{ handle: GVFileHandle; path: string }> {
  for await (const handle of dir.values()) {
    const relPath = prefix ? `${prefix}/${handle.name}` : handle.name;
    if (handle.kind === 'directory') {
      yield* collectMdFiles(handle as GVDirectoryHandle, relPath);
    } else if (handle.kind === 'file' && handle.name.endsWith('.md')) {
      yield { handle: handle as GVFileHandle, path: relPath };
    }
  }
}

/**
 * Verify (and optionally request) readwrite permission on a directory handle
 * that was read back from IndexedDB. Handles loaded from storage may report
 * `prompt` even if previously granted, so we query first and (when allowed)
 * request inside the caller's user gesture.
 *
 * Returns the resulting permission state; `granted` means the handle is usable.
 * Any unexpected error is treated as `denied` rather than throwing.
 */
export async function verifyPermission(
  handle: GVDirectoryHandle,
  request: boolean,
): Promise<GVPermissionState> {
  const opts: GVPermissionDescriptor = { mode: 'readwrite' };
  try {
    if (typeof handle.queryPermission === 'function') {
      const state = await handle.queryPermission(opts);
      if (state === 'granted') return 'granted';
      if (state === 'denied') return 'denied';
      // state === 'prompt'
      if (request && typeof handle.requestPermission === 'function') {
        return await handle.requestPermission(opts);
      }
      return 'prompt';
    }
    // No permission API (older/partial impls): assume usable; a later read will
    // surface a real error if not.
    return 'granted';
  } catch {
    return 'denied';
  }
}

/**
 * Resolve the sub-directory chain for a nested path, creating directories as
 * needed. Returns the leaf directory handle.
 *
 * E.g. for path `notes/ideas.md` this ensures a `notes/` sub-directory exists
 * and returns its handle.
 */
async function ensureDirectory(
  root: GVDirectoryHandle,
  segments: string[],
): Promise<GVDirectoryHandle> {
  let current = root;
  for (const seg of segments) {
    current = await current.getDirectoryHandle(seg, { create: true });
  }
  return current;
}

// ---------------------------------------------------------------------------
// FileSystemAdapter class
// ---------------------------------------------------------------------------

/**
 * A {@link StorageAdapter} backed by a user-picked directory via the File
 * System Access API.
 *
 * Instantiate via the static {@link FileSystemAdapter.create} factory rather
 * than the constructor directly. The factory shows the directory picker to the
 * user (requires a browser gesture) and returns a configured adapter.
 */
export class FileSystemAdapter implements StorageAdapter {
  readonly id = 'fileSystem';
  readonly label = 'Local files (File System Access API)';

  /** The root directory handle, set after a successful picker interaction. */
  private directoryHandle: GVDirectoryHandle | null = null;

  constructor(handle?: GVDirectoryHandle) {
    this.directoryHandle = handle ?? null;
  }

  /**
   * Show the directory picker and return a configured adapter. Call this
   * inside a user-gesture handler (click, keydown, etc.).
   *
   * Throws `DOMException` with `name === "AbortError"` when the user cancels.
   * Throws `Error` when the File System Access API is not available.
   */
  static async create(): Promise<FileSystemAdapter> {
    const picker = getShowDirectoryPicker();
    if (!picker) {
      throw new Error(
        'The File System Access API is not available in this browser. ' +
          'Use the localStorage adapter as a fallback.',
      );
    }
    const handle = await picker({ id: 'graphvault', mode: 'readwrite' });
    // Persist the handle so the folder reconnects on the next session. Handles
    // are structured-clonable, so IndexedDB can hold them. Best-effort.
    await saveDirectoryHandle(handle);
    return new FileSystemAdapter(handle);
  }

  /**
   * Attempt to reconnect to a previously-selected folder from a prior session.
   *
   * Reads the persisted handle from IndexedDB and verifies read/write
   * permission. Permission may still be `granted` (silent reconnect) or have
   * lapsed to `prompt`; in the latter case re-granting requires a user gesture,
   * so by default we only reconnect when permission is already granted.
   *
   * @param requestIfNeeded When true and permission is in the `prompt` state,
   *   actively requests permission (must be called within a user gesture).
   * @returns The reconnected adapter, or `null` when there is no stored handle,
   *   the API is unavailable, or permission is not (yet) granted.
   */
  static async restore(requestIfNeeded = false): Promise<FileSystemAdapter | null> {
    if (!FileSystemAdapter.isApiAvailable()) return null;
    const handle = await loadDirectoryHandle<GVDirectoryHandle>();
    if (!handle) return null;
    const state = await verifyPermission(handle, requestIfNeeded);
    if (state !== 'granted') return null;
    return new FileSystemAdapter(handle);
  }

  /**
   * Whether a folder was selected in a previous session (a handle is persisted),
   * regardless of whether permission is currently granted. The UI uses this to
   * show a "reconnect your folder" banner instead of silently reverting to
   * localStorage.
   */
  static async hasPersistedHandle(): Promise<boolean> {
    if (!FileSystemAdapter.isApiAvailable()) return false;
    return (await loadDirectoryHandle()) !== null;
  }

  /** Forget any persisted folder handle (used when switching to localStorage). */
  static async forgetPersistedHandle(): Promise<void> {
    await clearDirectoryHandle();
  }

  /**
   * Returns `true` when `window.showDirectoryPicker` is available. Does NOT
   * require a directory handle to have been set.
   */
  static isApiAvailable(): boolean {
    return getShowDirectoryPicker() !== undefined;
  }

  // ------------------------------------------------------------------
  // StorageAdapter implementation
  // ------------------------------------------------------------------

  /**
   * Returns `true` when:
   * 1. The File System Access API is available in the browser, AND
   * 2. A directory handle has been obtained (i.e. the user has picked a folder
   *    this session via {@link FileSystemAdapter.create}).
   */
  isAvailable(): boolean {
    return FileSystemAdapter.isApiAvailable() && this.directoryHandle !== null;
  }

  /**
   * Read all `.md` files from the directory and return them as notes.
   *
   * On first run (empty directory), seeds the vault with sample notes and
   * persists them. Failed file reads surface as notes with an error-marker
   * content so the caller can detect and surface the problem - no silent data
   * loss.
   */
  async load(): Promise<Note[]> {
    const dir = this._requireHandle();
    const notes: Note[] = [];

    for await (const { handle, path } of collectMdFiles(dir, '')) {
      try {
        const file = await handle.getFile();
        const content = await file.text();
        const mtime = file.lastModified;
        // ctime is not available from the web API; use mtime as a proxy.
        notes.push({ path, content, mtime, ctime: mtime });
      } catch (err) {
        // Surface the error as a special note rather than silently dropping it.
        const errorContent =
          `<!-- GraphVault: failed to read file "${path}": ${String(err)} -->`;
        const now = Date.now();
        notes.push({ path, content: errorContent, mtime: now, ctime: now });
      }
    }

    // First run: seed and persist sample notes.
    if (notes.length === 0) {
      const seeded = seedNotes();
      await this.save(seeded);
      return seeded;
    }

    return notes;
  }

  /**
   * Write each note as a `.md` file in the directory, creating sub-directories
   * as needed. Existing files are overwritten; the vault is the single source
   * of truth.
   *
   * Does NOT delete `.md` files that are no longer in `notes` - use
   * {@link clear} first if a full reset is needed. This prevents accidental
   * deletion of files the user placed in the folder manually.
   */
  async save(notes: Note[]): Promise<void> {
    const dir = this._requireHandle();

    for (const note of notes) {
      const parts = note.path.split('/');
      const filename = parts[parts.length - 1];
      const subdirs = parts.slice(0, -1);

      const targetDir = subdirs.length > 0 ? await ensureDirectory(dir, subdirs) : dir;

      const fileHandle = await targetDir.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(note.content);
      await writable.close();
    }
  }

  /**
   * Remove every `.md` file that the adapter currently tracks.
   *
   * Only removes files whose paths are present in a fresh `load()` call - no
   * arbitrary directory wipe. If `load()` itself errors (e.g. permission
   * revoked), the clear is a no-op rather than throwing, to avoid leaving the
   * vault in a broken state.
   */
  async clear(): Promise<void> {
    const dir = this._requireHandle();

    let existing: Note[];
    try {
      existing = await this.load();
    } catch {
      return; // Cannot enumerate - do nothing rather than guess.
    }

    for (const note of existing) {
      const parts = note.path.split('/');
      const filename = parts[parts.length - 1];
      const subdirs = parts.slice(0, -1);

      try {
        let targetDir = dir;
        for (const seg of subdirs) {
          targetDir = await targetDir.getDirectoryHandle(seg);
        }
        await targetDir.removeEntry(filename);
      } catch {
        // If a specific file cannot be removed, continue - partial clear is
        // better than aborting the whole operation.
      }
    }
  }

  /**
   * Replace the underlying directory handle, e.g. when the user picks a
   * different folder in Settings. The old handle is released.
   */
  setDirectory(handle: GVDirectoryHandle): void {
    this.directoryHandle = handle;
  }

  /** The current directory handle, or `null` if none has been set. */
  get directory(): GVDirectoryHandle | null {
    return this.directoryHandle;
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private _requireHandle(): GVDirectoryHandle {
    if (!this.directoryHandle) {
      throw new Error(
        'FileSystemAdapter: no directory handle. ' +
          'Call FileSystemAdapter.create() with a user gesture first.',
      );
    }
    return this.directoryHandle;
  }
}

/**
 * A singleton "template" instance used for the registry check.
 *
 * It has no directory handle yet (`isAvailable()` returns `false` until the
 * user picks a folder), but its `id` and `label` are visible to Settings so a
 * "Use local files" button can call `FileSystemAdapter.create()` and install
 * the result as the active adapter.
 */
export const fileSystemAdapter = new FileSystemAdapter();
