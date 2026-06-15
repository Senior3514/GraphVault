/**
 * Pure helpers for the graph view: mapping the web vault's notes into the
 * engine's `NoteInput` shape, and small utilities over graph payloads.
 *
 * These are deliberately framework-free (no React, no DOM) so they can be unit
 * tested with `node:test` and reused. The actual index build + queries live in
 * `@graphvault/engine`; this module is only the thin glue the web client needs.
 */

import type { NoteInput } from '@graphvault/engine';

/** The minimal shape this module needs from a vault note. */
export interface VaultNoteLike {
  path: string;
  content: string;
  /** Epoch ms of last local modification. */
  mtime: number;
  /** Epoch ms the note was created. */
  ctime: number;
}

/**
 * Map the web vault's `Note[]` onto the engine's `NoteInput[]`.
 *
 * The vault tracks `ctime`/`mtime`; the engine speaks `createdAt`/`updatedAt`
 * (epoch ms). The note `path` is already a vault-relative POSIX path, which is
 * exactly what the engine expects for `NoteInput.path`.
 */
export function notesToInputs(notes: readonly VaultNoteLike[]): NoteInput[] {
  return notes.map((n) => ({
    path: n.path,
    content: n.content,
    createdAt: n.ctime,
    updatedAt: n.mtime,
  }));
}

/**
 * A restrained, dark-first categorical palette. Used to encode a node's first
 * tag (or an edge's link type) — meaning, not decoration (see DESIGN.md).
 */
export const GRAPH_PALETTE = [
  '#7aa2f7', // blue
  '#9ece6a', // green
  '#e0af68', // amber
  '#bb9af7', // violet
  '#f7768e', // rose
  '#7dcfff', // cyan
  '#ff9e64', // orange
  '#73daca', // teal
] as const;

/** Neutral fallback for nodes with no tag / unknown category. */
export const GRAPH_NEUTRAL = '#9ca3af';

/**
 * Deterministically pick a palette colour for a category key (e.g. a tag or a
 * link type). Stable across renders for a given key, so the legend matches the
 * canvas. An empty/undefined key yields the neutral colour.
 */
export function colorForKey(key: string | undefined): string {
  if (!key) return GRAPH_NEUTRAL;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % GRAPH_PALETTE.length;
  return GRAPH_PALETTE[idx];
}

/** Collect the distinct, sorted tags present across a set of notes' tag lists. */
export function distinctSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
