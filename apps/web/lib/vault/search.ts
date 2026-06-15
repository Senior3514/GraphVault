/**
 * Local full-text + title search over the note index, backed by MiniSearch.
 *
 * Kept UI-independent: it takes parsed notes and returns ranked path results.
 * Title and tag matches are boosted over body matches so navigating by name
 * stays fast and predictable. Prefix + fuzzy matching make the search box
 * feel responsive as the user types.
 */

import MiniSearch from 'minisearch';
import type { IndexedNote, NotePath } from './types';

interface SearchDoc {
  id: NotePath;
  title: string;
  tags: string;
  body: string;
}

export interface SearchResult {
  path: NotePath;
  title: string;
  /** Relevance score (higher is better). */
  score: number;
}

const SEARCH_FIELDS = ['title', 'tags', 'body'] as const;

function toDoc(note: IndexedNote): SearchDoc {
  return {
    id: note.path,
    title: note.parsed.title,
    tags: note.parsed.tags.join(' '),
    body: note.parsed.body,
  };
}

/** A reusable search index over a set of notes. */
export class NoteSearchIndex {
  private mini: MiniSearch<SearchDoc>;
  private titles = new Map<NotePath, string>();

  constructor(notes: IndexedNote[]) {
    this.mini = new MiniSearch<SearchDoc>({
      fields: [...SEARCH_FIELDS],
      storeFields: ['title'],
      searchOptions: {
        boost: { title: 3, tags: 2 },
        prefix: true,
        fuzzy: 0.2,
      },
    });
    this.replaceAll(notes);
  }

  /** Rebuild the index from scratch for the given notes. */
  replaceAll(notes: IndexedNote[]): void {
    this.mini.removeAll();
    this.titles.clear();
    for (const note of notes) this.titles.set(note.path, note.parsed.title);
    this.mini.addAll(notes.map(toDoc));
  }

  /** Run a query; empty query returns no results. */
  search(query: string, limit = 50): SearchResult[] {
    const q = query.trim();
    if (q === '') return [];
    return this.mini
      .search(q)
      .slice(0, limit)
      .map((r) => ({
        path: String(r.id),
        title: this.titles.get(String(r.id)) ?? String(r.id),
        score: r.score,
      }));
  }
}

/**
 * One-shot search helper for callers that don't keep an index around (e.g.
 * tests). Prefer {@link NoteSearchIndex} when searching repeatedly.
 */
export function searchNotes(notes: IndexedNote[], query: string, limit = 50): SearchResult[] {
  return new NoteSearchIndex(notes).search(query, limit);
}
