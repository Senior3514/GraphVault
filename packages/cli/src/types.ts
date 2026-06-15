/**
 * CLI-internal types: pure data shapes for command results, decoupled from IO.
 */

export interface NoteEntry {
  path: string;
  title: string;
}

export interface SearchResult {
  path: string;
  title: string;
  /** Snippet context or undefined. */
  context?: string;
}

export interface StatsResult {
  noteCount: number;
  linkCount: number;
  resolvedLinkCount: number;
  tagCount: number;
  /** Tags sorted by frequency, descending. */
  topTags: Array<{ tag: string; count: number }>;
  /** Note paths with no inbound resolved links. */
  orphanNotes: string[];
}

export interface GraphResult {
  nodes: Array<{ id: string; title: string; tags: string[] }>;
  edges: Array<{ source: string; target: string; type: string; resolved: boolean }>;
  truncated: boolean;
}
