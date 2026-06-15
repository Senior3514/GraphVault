/**
 * Core data model for the GraphVault graph engine.
 *
 * The engine is intentionally framework-free and filesystem-free: callers feed
 * in raw note content (see {@link NoteInput}) and receive plain data structures
 * back. Nothing here imports React, the DOM, or `node:fs`.
 */

import type { FilePath } from '@graphvault/shared';

/**
 * Raw input for a single note. The engine never reads the filesystem; the host
 * application is responsible for walking the vault and supplying these.
 */
export interface NoteInput {
  /** Vault-relative POSIX path, e.g. `notes/ideas/graphs.md`. */
  path: FilePath;
  /** Raw markdown content, exactly as stored on disk. */
  content: string;
  /** Creation time, Unix epoch milliseconds. Optional. */
  createdAt?: number;
  /** Last-modified time, Unix epoch milliseconds. Optional. */
  updatedAt?: number;
}

/**
 * The kind of a link/edge.
 * - `wikilink`   — `[[Target]]` style.
 * - `markdown`   — `[text](relative.md)` style.
 * - any other string — a typed relation declared in frontmatter
 *   (e.g. `references`, `supports`), preserved verbatim.
 */
export type LinkType = 'wikilink' | 'markdown' | (string & {});

/** A single outbound link parsed out of a note, before resolution. */
export interface ParsedLink {
  /** The raw target text as written (path or note title/wikilink target). */
  target: string;
  /** Display text / alias, if any (the `|alias` part or `[text]`). */
  alias?: string;
  /** Heading anchor within the target (`#heading`), without the `#`. */
  heading?: string;
  /** Link kind; see {@link LinkType}. */
  type: LinkType;
}

/** The result of parsing one note's raw markdown. */
export interface ParsedNote {
  path: FilePath;
  /** Resolved title: frontmatter `title` → first H1 → filename (no extension). */
  title: string;
  /** Parsed YAML frontmatter as a plain object (empty when none). */
  frontmatter: Record<string, unknown>;
  /** Inline `#tags`, de-duplicated, without the leading `#`. */
  tags: string[];
  /** All outbound links, in document order. */
  links: ParsedLink[];
}

/** A node in the graph index: one note. */
export interface GraphNode {
  /** Stable note id. In v0 this is the note's vault-relative path. */
  id: string;
  path: FilePath;
  title: string;
  tags: string[];
  /** Containing folder (vault-relative, `''` for the vault root). */
  folder: string;
  createdAt?: number;
  updatedAt?: number;
}

/** A directed edge between two notes (or a note and an unresolved target). */
export interface GraphEdge {
  /** Source note id. */
  source: string;
  /**
   * Target note id when {@link resolved} is true, otherwise the raw,
   * unresolved target text as written in the note.
   */
  target: string;
  /** Link kind; see {@link LinkType}. */
  type: LinkType;
  /** True when `target` resolves to a known note id. */
  resolved: boolean;
  /** Heading anchor within the target, if the link specified one. */
  heading?: string;
  /** Display text / alias, if any. */
  alias?: string;
}

/**
 * The built in-memory index. All lookups the graph API needs are precomputed:
 * nodes by id, outbound and inbound (backlink) edges per note.
 */
export interface GraphIndex {
  /** All nodes, keyed by id. */
  nodes: Map<string, GraphNode>;
  /** All edges, in build order. */
  edges: GraphEdge[];
  /** Outbound edges per source note id. */
  outbound: Map<string, GraphEdge[]>;
  /** Inbound (backlink) edges per target note id (resolved edges only). */
  backlinks: Map<string, GraphEdge[]>;
}

/** A plain, renderer-agnostic graph payload. */
export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the result was capped and some nodes/edges were omitted. */
  truncated: boolean;
}
