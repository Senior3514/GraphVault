/**
 * Pure operations over a collection of notes: indexing, create/rename/delete,
 * folder-tree building. None of these touch persistence or React — the store
 * (persistence) and hooks (state) compose them.
 *
 * All functions are non-mutating: they return new arrays/objects so callers can
 * keep immutable state and avoid silent data loss.
 */

import { basename, dirname, parseNote } from './parse';
import type { IndexedNote, Note, NotePath } from './types';

/** Normalize a path to the vault's canonical form (forward slashes, no `./`). */
export function normalizePath(path: string): NotePath {
  const cleaned = path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
  return cleaned;
}

/** Ensure a path ends with `.md` (the only note type in v0). */
export function ensureMdExtension(path: string): NotePath {
  return /\.md$/i.test(path) ? path : `${path}.md`;
}

/** Attach parsed metadata to a note. */
export function indexNote(note: Note): IndexedNote {
  return { ...note, parsed: parseNote(note.path, note.content) };
}

/** Attach parsed metadata to every note, sorted by title for stable display. */
export function indexNotes(notes: Note[]): IndexedNote[] {
  return notes.map(indexNote).sort((a, b) => a.parsed.title.localeCompare(b.parsed.title));
}

export class VaultError extends Error {}

function assertValidPath(path: NotePath): void {
  if (path === '') throw new VaultError('Path must not be empty.');
  if (path.split('/').some((seg) => seg === '..')) {
    throw new VaultError('Path must not contain ".." segments.');
  }
}

/** Create a new note. Throws if the path already exists. */
export function createNote(notes: Note[], rawPath: string, content = ''): Note[] {
  const path = ensureMdExtension(normalizePath(rawPath));
  assertValidPath(path);
  if (notes.some((n) => n.path === path)) {
    throw new VaultError(`A note already exists at "${path}".`);
  }
  const now = Date.now();
  const note: Note = { path, content, ctime: now, mtime: now };
  return [...notes, note];
}

/** Update a note's content (no-op if unchanged). Throws if it doesn't exist. */
export function updateNoteContent(notes: Note[], path: NotePath, content: string): Note[] {
  let found = false;
  const next = notes.map((n) => {
    if (n.path !== path) return n;
    found = true;
    if (n.content === content) return n;
    return { ...n, content, mtime: Date.now() };
  });
  if (!found) throw new VaultError(`No note at "${path}".`);
  return next;
}

/** Rename/move a note. Throws if the source is missing or target exists. */
export function renameNote(notes: Note[], from: NotePath, rawTo: string): Note[] {
  const to = ensureMdExtension(normalizePath(rawTo));
  assertValidPath(to);
  if (!notes.some((n) => n.path === from)) {
    throw new VaultError(`No note at "${from}".`);
  }
  if (from !== to && notes.some((n) => n.path === to)) {
    throw new VaultError(`A note already exists at "${to}".`);
  }
  return notes.map((n) => (n.path === from ? { ...n, path: to, mtime: Date.now() } : n));
}

/** Delete a note by path. Returns the list unchanged if it doesn't exist. */
export function deleteNote(notes: Note[], path: NotePath): Note[] {
  return notes.filter((n) => n.path !== path);
}

/** One incoming note for {@link mergeImport}. */
export interface ImportNote {
  path: NotePath;
  content: string;
  ctime?: number;
  mtime?: number;
}

/** What an import did, for an honest "here's what happened" summary. */
export interface ImportSummary {
  /** New notes added at their original path. */
  added: number;
  /** Notes whose path collided and were saved under a new name (kept both). */
  renamed: { from: NotePath; to: NotePath }[];
  /** Identical notes already present — skipped, nothing changed. */
  unchanged: number;
}

/** Insert ` (imported)` (then ` (imported 2)`, …) before a path's extension. */
function conflictPath(path: NotePath, taken: (p: NotePath) => boolean): NotePath {
  const ext = /\.[^./]+$/.exec(path)?.[0] ?? '';
  const stem = ext ? path.slice(0, -ext.length) : path;
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? ' (imported)' : ` (imported ${i})`;
    const candidate = `${stem}${suffix}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * Merge imported notes into the vault **without ever losing data**. On a path
 * collision: if the content is identical it's skipped; otherwise the import is
 * kept under a conflict-copy name (`note (imported).md`) so both survive. This
 * mirrors the sync engine's conflict-copy policy.
 */
export function mergeImport(
  existing: Note[],
  incoming: readonly ImportNote[],
): { notes: Note[]; summary: ImportSummary } {
  const notes = [...existing];
  const byPath = new Map<NotePath, Note>(notes.map((n) => [n.path, n]));
  const summary: ImportSummary = { added: 0, renamed: [], unchanged: 0 };

  for (const raw of incoming) {
    const path = ensureMdExtension(normalizePath(raw.path));
    if (path === '' || path.split('/').some((seg) => seg === '..')) continue; // defense in depth
    const now = Date.now();
    const note: Note = {
      path,
      content: raw.content,
      ctime: raw.ctime ?? now,
      mtime: raw.mtime ?? now,
    };

    const clash = byPath.get(path);
    if (!clash) {
      notes.push(note);
      byPath.set(path, note);
      summary.added += 1;
      continue;
    }
    if (clash.content === note.content) {
      summary.unchanged += 1;
      continue;
    }
    const dest = conflictPath(path, (p) => byPath.has(p));
    const copy: Note = { ...note, path: dest };
    notes.push(copy);
    byPath.set(dest, copy);
    summary.renamed.push({ from: path, to: dest });
  }

  return { notes, summary };
}

/** A node in the vault's folder tree. */
export interface TreeNode {
  name: string;
  path: NotePath;
  /** Present only on folder nodes. */
  children?: TreeNode[];
  /** Present only on file (note) nodes. */
  note?: IndexedNote;
}

/**
 * Build a nested folder tree from indexed notes. Folders are sorted before
 * files, both alphabetically, so the sidebar reads predictably.
 */
export function buildTree(notes: IndexedNote[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] };

  for (const note of notes) {
    const parts = note.path.split('/');
    let cursor = root;
    for (let i = 0; i < parts.length; i += 1) {
      const isFile = i === parts.length - 1;
      const segPath = parts.slice(0, i + 1).join('/');
      if (isFile) {
        cursor.children!.push({ name: parts[i], path: segPath, note });
      } else {
        let child = cursor.children!.find((c) => c.path === segPath && c.children);
        if (!child) {
          child = { name: parts[i], path: segPath, children: [] };
          cursor.children!.push(child);
        }
        cursor = child;
      }
    }
  }

  const sortLevel = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      const aFolder = !!a.children;
      const bFolder = !!b.children;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.children) sortLevel(n.children);
    return nodes;
  };

  return sortLevel(root.children ?? []);
}

export { basename, dirname };
