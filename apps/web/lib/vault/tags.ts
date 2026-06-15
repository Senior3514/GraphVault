/**
 * Pure tag aggregation over the note index.
 *
 * Tags already live on each note's parsed metadata (frontmatter `tags` plus
 * inline `#tags`, normalized to lower case in {@link parseNote}). These helpers
 * roll them up for the sidebar tag list and the tag-filtered note view. They
 * are dependency-free and side-effect-free so they unit-test trivially and can
 * be reused from a real filesystem backend later.
 */

import type { IndexedNote, NotePath } from './types';

/** A tag plus how many notes carry it, for the sidebar tag list. */
export interface TagCount {
  /** The normalized tag name (no leading `#`). */
  tag: string;
  /** Number of notes that carry this tag. */
  count: number;
}

/**
 * Aggregate every tag across the notes with its frequency. Sorted by count
 * (descending) then alphabetically so the most-used tags surface first while
 * ties stay stable.
 */
export function aggregateTags(notes: IndexedNote[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const tag of note.parsed.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Paths of every note carrying the given tag (case-insensitive, leading `#`
 * ignored). Returned in the notes' incoming order so callers control display
 * ordering.
 */
export function notesWithTag(notes: IndexedNote[], tag: string): NotePath[] {
  const needle = tag.trim().replace(/^#/, '').toLowerCase();
  if (needle === '') return [];
  return notes.filter((n) => n.parsed.tags.includes(needle)).map((n) => n.path);
}
