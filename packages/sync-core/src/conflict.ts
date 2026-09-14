/**
 * Conflict-copy naming (spec §6.2).
 *
 * When a push is rejected with CONTENT_CONFLICT or DELETE_EDIT_CONFLICT the
 * client keeps the server version at the canonical path (so every device
 * converges) and writes the *local* version to a sibling file:
 *
 *   notes/idea.md
 *   notes/idea (conflict 2026-06-15 from <device>).md
 *
 * The copy is a normal note: it appears in search/graph and can be merged or
 * deleted by the user. This guarantees no silent data loss.
 */

import type { FilePath } from '@graphvault/shared';

/**
 * A read-only view of the existing paths a new conflict copy must not collide
 * with. The sync engine passes its in-cycle index map; any structure with a
 * `has(path)` probe works.
 */
export interface PathSet {
  has(path: FilePath): boolean;
}

/** Split a path into `{ dir, stem, ext }`, where ext includes the leading dot. */
function splitPath(path: string): { dir: string; stem: string; ext: string } {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  // Treat a leading-dot filename (".gitignore") as having no extension.
  if (dot <= 0) return { dir, stem: name, ext: '' };
  return { dir, stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** The `YYYY-MM-DD` date used in the conflict-copy suffix. */
export function conflictDate(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** Matches path separators plus C0 control chars (incl. \n, \t, \r) and DEL. */
// eslint-disable-next-line no-control-regex
const UNSAFE_DEVICE_CHARS = /[\\/\u0000-\u001f\u007f]/g;

/**
 * Sanitise a device name into a safe single path segment: strip path
 * separators and control characters (newline/tab/CR/…), and collapse `..` so a
 * device name can never escape the directory or break the filename.
 */
function sanitizeDevice(device: string): string {
  const cleaned = device
    .replace(UNSAFE_DEVICE_CHARS, '-')
    // Collapse any run of two-or-more dots so it can't form a `..` segment.
    .replace(/\.{2,}/g, '.');
  return cleaned.trim() || 'unknown';
}

/**
 * Build the conflict-copy path for `path`, e.g.
 * `notes/idea.md` → `notes/idea (conflict 2026-06-15 from laptop).md`.
 *
 * `device` is sanitised so the result stays a valid single-segment filename.
 *
 * Two conflicts on the same file, same device, and same day would otherwise
 * produce an identical path and the second copy would silently overwrite the
 * first. When `existing` is supplied, a `(2)`, `(3)`, … disambiguator is
 * appended until the path is unique, guaranteeing no silent data loss.
 */
export function conflictCopyPath(
  path: FilePath,
  device: string,
  at: Date = new Date(),
  existing?: PathSet,
): FilePath {
  const { dir, stem, ext } = splitPath(path);
  const safeDevice = sanitizeDevice(device);
  const date = conflictDate(at);
  const base = `${dir}${stem} (conflict ${date} from ${safeDevice})`;

  let candidate = `${base}${ext}` as FilePath;
  if (existing) {
    let counter = 2;
    while (existing.has(candidate)) {
      candidate = `${base} (${counter})${ext}` as FilePath;
      counter += 1;
    }
  }
  return candidate;
}
