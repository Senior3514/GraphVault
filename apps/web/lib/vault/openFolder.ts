/**
 * openFolder — map a local folder of Markdown into the vault.
 *
 * Uses `window.showDirectoryPicker()` (File System Access API) to let the user
 * pick a folder, recursively collects `.md` / `.markdown` / `.txt` files
 * (preserving relative paths), validates every path with {@link safeImportPath},
 * enforces the same per-file / total-bytes / file-count caps as the ZIP importer,
 * and returns a ready-to-feed {@link ImportEntry} array.
 *
 * ## Browser-only surface
 * The ONLY line that touches the browser API is the `showDirectoryPicker()` call
 * in {@link openFolder}. Everything else — path filtering, file reading, cap
 * enforcement — is in pure helpers that are independently unit-testable.
 *
 * ## Availability
 * Feature-detected at runtime via {@link isFolderPickerSupported}. Call that
 * first and show a graceful message when it returns `false` (Firefox, Safari
 * without the flag, SSR).
 *
 * ## AbortError
 * When the user dismisses the picker `showDirectoryPicker()` rejects with a
 * `DOMException` whose `.name === "AbortError"`. Callers should catch it and
 * treat it as a silent cancel — do not surface it as an error.
 */

import {
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_FILES,
  MAX_IMPORT_TOTAL_BYTES,
  safeImportPath,
  type ImportEntry,
} from './portability';

// ---------------------------------------------------------------------------
// Local File System Access API interfaces (GV-prefixed to avoid DOM clashes)
// ---------------------------------------------------------------------------

/** Minimal interface for a directory handle we need from the FS Access API. */
export interface GVFolderHandle {
  readonly kind: string;
  readonly name: string;
  values(): AsyncIterableIterator<GVFolderHandle | GVFileEntryHandle>;
}

/** Minimal interface for a file handle we need from the FS Access API. */
export interface GVFileEntryHandle {
  readonly kind: string;
  readonly name: string;
  getFile(): Promise<GVFileData>;
}

/** The minimal subset of `File` we use. */
export interface GVFileData {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  text(): Promise<string>;
}

/** Options passed to `showDirectoryPicker`. */
interface GVDirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the File System Access API's `showDirectoryPicker` is
 * available in the current environment.
 *
 * Checks `globalThis` (not `window`) so it is SSR/Node-safe and compatible with
 * the test harness shim pattern used throughout this codebase.
 */
export function isFolderPickerSupported(): boolean {
  try {
    const g = globalThis as Record<string, unknown>;
    return typeof g['showDirectoryPicker'] === 'function';
  } catch {
    return false;
  }
}

/** Retrieve the `showDirectoryPicker` function, or `undefined` if absent. */
function getShowDirectoryPicker():
  | ((options?: GVDirectoryPickerOptions) => Promise<GVFolderHandle>)
  | undefined {
  const g = globalThis as Record<string, unknown>;
  const fn = g['showDirectoryPicker'];
  return typeof fn === 'function'
    ? (fn as (options?: GVDirectoryPickerOptions) => Promise<GVFolderHandle>)
    : undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers — independently unit-testable, no browser API access
// ---------------------------------------------------------------------------

/**
 * Decide whether a file name is one we want to import.
 *
 * Accepted extensions: `.md`, `.markdown`, `.txt`.
 * Case-insensitive.
 */
export function isImportableFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt');
}

/**
 * Recursively walk a directory handle and yield every importable file together
 * with its vault-relative path (forward slashes, no leading slash).
 *
 * This is a pure generator over the handle tree — it does not call
 * `showDirectoryPicker` or touch any global state.
 *
 * @param dir   The directory handle to walk.
 * @param prefix The accumulated path prefix (empty string for the root).
 */
export async function* walkDirectory(
  dir: GVFolderHandle,
  prefix: string,
): AsyncGenerator<{ handle: GVFileEntryHandle; relativePath: string }> {
  for await (const entry of dir.values()) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      yield* walkDirectory(entry as GVFolderHandle, entryPath);
    } else if (entry.kind === 'file' && isImportableFilename(entry.name)) {
      yield { handle: entry as GVFileEntryHandle, relativePath: entryPath };
    }
  }
}

/**
 * Read the content of a file handle and validate it against the per-file cap.
 *
 * Returns `null` when:
 * - The path fails {@link safeImportPath} (traversal, bad extension, etc.)
 * - The reported file size exceeds {@link MAX_IMPORT_FILE_BYTES} (guard against
 *   reading the bytes at all — avoids OOM on huge files)
 *
 * Throws if the underlying `file.text()` call fails (the caller decides whether
 * to skip or abort).
 */
export async function readFileEntry(
  handle: GVFileEntryHandle,
  relativePath: string,
): Promise<ImportEntry | null> {
  const safePath = safeImportPath(relativePath);
  if (!safePath) return null;

  const file = await handle.getFile();
  if (file.size > MAX_IMPORT_FILE_BYTES) return null; // skip oversized file

  const content = await file.text();
  // Second-pass byte check after reading (size from metadata can be unreliable).
  if (new TextEncoder().encode(content).length > MAX_IMPORT_FILE_BYTES) return null;

  return {
    path: safePath,
    content,
    mtime: file.lastModified > 0 ? file.lastModified : undefined,
    ctime: file.lastModified > 0 ? file.lastModified : undefined,
  };
}

/**
 * Collect all importable entries from an already-opened directory handle.
 *
 * This is the main pure workhorse: combines {@link walkDirectory} +
 * {@link readFileEntry} while enforcing the global caps
 * ({@link MAX_IMPORT_FILES}, {@link MAX_IMPORT_TOTAL_BYTES}). Oversized or
 * path-unsafe files are silently skipped (consistent with ZIP import behaviour);
 * if the total caps are hit an error is thrown.
 *
 * @param dir Root directory handle (already opened — no picker call here).
 */
export async function collectEntriesFromDirectory(dir: GVFolderHandle): Promise<ImportEntry[]> {
  const entries: ImportEntry[] = [];
  let totalBytes = 0;

  for await (const { handle, relativePath } of walkDirectory(dir, '')) {
    if (entries.length >= MAX_IMPORT_FILES) {
      throw new Error(
        `Folder contains more than ${MAX_IMPORT_FILES.toLocaleString()} importable files. ` +
          'Please import a sub-folder or reduce the number of files.',
      );
    }

    let entry: ImportEntry | null;
    try {
      entry = await readFileEntry(handle, relativePath);
    } catch {
      // Skip unreadable files — surface count but never abort the whole batch.
      continue;
    }
    if (!entry) continue; // oversized or unsafe path — skip

    const byteCount = new TextEncoder().encode(entry.content).length;
    totalBytes += byteCount;
    if (totalBytes > MAX_IMPORT_TOTAL_BYTES) {
      throw new Error(
        'The total size of files in this folder exceeds the 64 MiB import limit. ' +
          'Please choose a smaller folder or remove large files.',
      );
    }

    entries.push(entry);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Main entry point (browser-only: calls showDirectoryPicker)
// ---------------------------------------------------------------------------

/**
 * Show a native folder picker, recursively read all importable Markdown/text
 * files (relative paths preserved), validate paths and enforce size caps, and
 * return the ready-to-import entries.
 *
 * **Browser-only.** Call {@link isFolderPickerSupported} first and show a
 * graceful message when it returns `false`.
 *
 * - User cancellation: the promise rejects with a `DOMException` whose
 *   `.name === "AbortError"`. Treat as silent cancel in the UI layer.
 * - API unavailable: throws `Error` with a human-readable message.
 * - Cap exceeded: throws `Error` with a human-readable message.
 *
 * @returns Validated {@link ImportEntry} array, ready for `vault.importNotes()`.
 */
export async function openFolder(): Promise<ImportEntry[]> {
  const picker = getShowDirectoryPicker();
  if (!picker) {
    throw new Error(
      'The File System Access API (showDirectoryPicker) is not available in this browser. ' +
        'Try Chrome 86+, Edge 86+, or another Chromium-based browser.',
    );
  }

  const dirHandle = await picker({ id: 'graphvault-open-folder', mode: 'read' });
  return collectEntriesFromDirectory(dirHandle);
}
