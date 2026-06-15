/**
 * Wikilink resolution and backlink computation.
 *
 * A `[[wikilink]]` target may be written as a note title (`[[My Idea]]`), a
 * path with or without the `.md` extension (`[[notes/idea]]`), or with a
 * folder prefix. Resolution is case-insensitive on the title/basename and
 * prefers an exact path match. Targets that resolve to no note are "unresolved"
 * (rendered as create-on-click links by the UI).
 */

import { basename } from './parse';
import type { IndexedNote, NotePath, WikiLink } from './types';

/** A resolver mapping a wikilink target string to a note path, if any. */
export interface LinkResolver {
  resolve(target: string): NotePath | null;
}

function normalizeTarget(target: string): string {
  return target.trim().replace(/\.md$/i, '').toLowerCase();
}

/**
 * Build a resolver over the given notes. Indexes by full path (sans `.md`),
 * by basename, and by title so any reasonable wikilink spelling resolves.
 * Earlier notes win on collision to keep resolution deterministic.
 */
export function buildLinkResolver(notes: IndexedNote[]): LinkResolver {
  const byPath = new Map<string, NotePath>();
  const byBasename = new Map<string, NotePath>();
  const byTitle = new Map<string, NotePath>();

  for (const note of notes) {
    const pathKey = normalizeTarget(note.path);
    if (!byPath.has(pathKey)) byPath.set(pathKey, note.path);

    const baseKey = normalizeTarget(basename(note.path));
    if (!byBasename.has(baseKey)) byBasename.set(baseKey, note.path);

    const titleKey = note.parsed.title.trim().toLowerCase();
    if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, note.path);
  }

  return {
    resolve(target: string): NotePath | null {
      const key = normalizeTarget(target);
      return (
        byPath.get(key) ?? byBasename.get(key) ?? byTitle.get(target.trim().toLowerCase()) ?? null
      );
    },
  };
}

/** A backlink: a note that links to the subject, with the link as written. */
export interface Backlink {
  /** Path of the note containing the link. */
  from: NotePath;
  /** Display title of the linking note. */
  fromTitle: string;
  /** The wikilink as written in the source note. */
  link: WikiLink;
}

/**
 * Compute, for every note path, the list of notes that link to it. Returns a
 * map keyed by the linked-to note path. Notes with no inbound links are absent.
 */
export function computeBacklinks(notes: IndexedNote[]): Map<NotePath, Backlink[]> {
  const resolver = buildLinkResolver(notes);
  const backlinks = new Map<NotePath, Backlink[]>();

  for (const note of notes) {
    for (const link of note.parsed.links) {
      const targetPath = resolver.resolve(link.target);
      if (!targetPath || targetPath === note.path) continue;
      const list = backlinks.get(targetPath) ?? [];
      list.push({ from: note.path, fromTitle: note.parsed.title, link });
      backlinks.set(targetPath, list);
    }
  }

  return backlinks;
}

/** Backlinks pointing at a single note path. */
export function backlinksFor(notes: IndexedNote[], path: NotePath): Backlink[] {
  return computeBacklinks(notes).get(path) ?? [];
}
