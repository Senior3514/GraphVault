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

/**
 * Build the conflict-copy path for `path`, e.g.
 * `notes/idea.md` → `notes/idea (conflict 2026-06-15 from laptop).md`.
 *
 * `device` is sanitised so the result stays a valid single-segment filename.
 */
export function conflictCopyPath(path: FilePath, device: string, at: Date = new Date()): FilePath {
  const { dir, stem, ext } = splitPath(path);
  const safeDevice = device.replace(/[\\/]/g, '-').trim() || 'unknown';
  const date = conflictDate(at);
  return `${dir}${stem} (conflict ${date} from ${safeDevice})${ext}` as FilePath;
}
