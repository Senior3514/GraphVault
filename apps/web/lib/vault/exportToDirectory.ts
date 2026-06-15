/**
 * Export vault notes to a user-picked directory using the File System Access
 * API (`showDirectoryPicker`). Each note is written as a real `.md` file with
 * subfolder structure preserved.
 *
 * This module is framework-free and dependency-free so it can be unit-tested
 * and reused by the desktop shell. It is a browser-only module — never import
 * it on the server side.
 *
 * Security notes:
 *  - All writes go through the handle the user explicitly chose; no traversal
 *    beyond that root is possible.
 *  - Folder segments are created with `getDirectoryHandle(..., { create: true })`,
 *    never with string-concatenation paths that could escape the picked root.
 */

import type { Note } from './types';

// ---------------------------------------------------------------------------
// Minimal type shim for showDirectoryPicker (not yet in all TS DOM libs)
// ---------------------------------------------------------------------------

/** Options accepted by `showDirectoryPicker`. */
interface ShowDirectoryPickerOptions {
  mode?: 'read' | 'readwrite';
  startIn?:
    | FileSystemHandle
    | 'desktop'
    | 'documents'
    | 'downloads'
    | 'music'
    | 'pictures'
    | 'videos';
  id?: string;
}

declare global {
  interface Window {
    showDirectoryPicker(options?: ShowDirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Typed alias for the picker function, resolved at call-time so tests can stub
// it on globalThis. In browsers, window === globalThis, so this works in both.
type PickerFn = (options?: ShowDirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;

function getPickerFn(): PickerFn | undefined {
  const g = globalThis as Record<string, unknown>;
  return typeof g['showDirectoryPicker'] === 'function'
    ? (g['showDirectoryPicker'] as PickerFn)
    : undefined;
}

/**
 * Return true when the File System Access `showDirectoryPicker` API is
 * available in the current environment. Suitable for feature-detection in UI.
 */
export function isDirectoryExportSupported(): boolean {
  return getPickerFn() !== undefined;
}

/** Summary returned after a directory export. */
export interface DirectoryExportSummary {
  /** Total notes written (or overwritten) successfully. */
  written: number;
  /** Notes that failed to write (path → error message). */
  errors: Array<{ path: string; message: string }>;
}

/**
 * Export `notes` as `.md` files into a directory the user picks via
 * `showDirectoryPicker`. Preserves subfolder structure by creating intermediate
 * directories as needed.
 *
 * Throws `DOMException` with `name === "AbortError"` if the user cancels the
 * picker — callers should catch and handle gracefully (show a "cancelled" hint,
 * not an error).
 *
 * @param notes   The notes to export (read-only; never mutated).
 * @param options Optional `showDirectoryPicker` options forwarded as-is.
 * @returns       A summary of what was written and any per-file errors.
 */
export async function exportToDirectory(
  notes: readonly Note[],
  options?: ShowDirectoryPickerOptions,
): Promise<DirectoryExportSummary> {
  if (!isDirectoryExportSupported()) {
    throw new Error('File System Access API is not available in this browser.');
  }

  const picker = getPickerFn()!;
  const root = await picker({ mode: 'readwrite', ...options });

  const summary: DirectoryExportSummary = { written: 0, errors: [] };

  for (const note of notes) {
    try {
      await writeNoteToDirectory(root, note);
      summary.written++;
    } catch (err) {
      summary.errors.push({
        path: note.path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

/**
 * Write a single note into `root`, creating intermediate directories as needed.
 *
 * @param root   The `FileSystemDirectoryHandle` the user chose (or a stub in tests).
 * @param note   The note to write.
 */
export async function writeNoteToDirectory(
  root: FileSystemDirectoryHandle,
  note: Note,
): Promise<void> {
  // Split the vault-relative path into segments. The path is already
  // normalised (POSIX, no leading slash, no `..`) by the vault layer.
  const segments = note.path.split('/');
  const filename = segments[segments.length - 1];
  const folders = segments.slice(0, -1);

  // Navigate / create intermediate directories.
  let dir: FileSystemDirectoryHandle = root;
  for (const segment of folders) {
    // We never use string concatenation or OS path APIs — each segment is
    // traversed via the API, so the browser enforces containment.
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }

  // Write the file. The File System Access API guarantees `createWritable`
  // on FileSystemFileHandle; we cast through `unknown` to avoid the strict
  // DOM lib requiring the full WritableStream interface on the result.
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(note.content);
  } finally {
    await writable.close();
  }
}
