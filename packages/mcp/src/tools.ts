/**
 * Read-only MCP tool handlers over a {@link VaultSnapshot}.
 *
 * DATA-SAFETY: this slice exposes NO write or delete tools. Every handler is a
 * pure read over the cached index/content, so an external agent can explore a
 * vault but never mutate it.
 *
 * Each handler returns a plain JS value; `registerTools` serializes it to the
 * MCP text-content envelope. Handlers are split out from the transport so they
 * can be unit-tested directly against an in-memory snapshot.
 */

import { getBacklinks, getLocalGraph } from '@graphvault/engine';
import type { VaultManager, VaultSnapshot } from './vault.js';

export interface ListNotesArgs {
  query?: string;
  limit?: number;
}

export interface NoteSummary {
  path: string;
  title: string;
  tags: string[];
}

export interface SearchResult extends NoteSummary {
  /** Which fields matched: any of title/tags/link/body. */
  matched: string[];
}

/** Default and maximum result counts for list/search tools. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** Notes as summaries, sorted by path for deterministic output. */
function allSummaries(snapshot: VaultSnapshot): NoteSummary[] {
  return [...snapshot.index.nodes.values()]
    .map((n) => ({ path: n.path, title: n.title, tags: n.tags }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** `list_notes` — optional substring filter on path/title. */
export function listNotes(snapshot: VaultSnapshot, args: ListNotesArgs): NoteSummary[] {
  const limit = clampLimit(args.limit);
  const q = args.query?.trim().toLowerCase();
  let summaries = allSummaries(snapshot);
  if (q) {
    summaries = summaries.filter(
      (n) => n.path.toLowerCase().includes(q) || n.title.toLowerCase().includes(q),
    );
  }
  return summaries.slice(0, limit);
}

/** `read_note` — raw markdown for a path, or an error when absent. */
export function readNote(snapshot: VaultSnapshot, path: string): string {
  const content = snapshot.contentByPath.get(path);
  if (content === undefined) {
    throw new Error(`Note not found: ${path}`);
  }
  return content;
}

/**
 * `search_notes` — match the query against title, tags, outbound link targets,
 * and body text. Combines the engine index (title/tags/links) with a content
 * scan of the cached markdown. Results are de-duplicated by path.
 */
export function searchNotes(
  snapshot: VaultSnapshot,
  args: { query: string; limit?: number },
): SearchResult[] {
  const limit = clampLimit(args.limit);
  const q = args.query.trim().toLowerCase();
  if (q === '') return [];

  const results: SearchResult[] = [];
  const nodes = [...snapshot.index.nodes.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  for (const node of nodes) {
    const matched: string[] = [];
    if (node.title.toLowerCase().includes(q)) matched.push('title');
    if (node.tags.some((t) => t.toLowerCase().includes(q))) matched.push('tags');

    const outbound = snapshot.index.outbound.get(node.id) ?? [];
    if (
      outbound.some(
        (e) => e.target.toLowerCase().includes(q) || (e.alias ?? '').toLowerCase().includes(q),
      )
    ) {
      matched.push('link');
    }

    const body = snapshot.contentByPath.get(node.path);
    if (body && body.toLowerCase().includes(q)) matched.push('body');

    if (matched.length > 0) {
      results.push({ path: node.path, title: node.title, tags: node.tags, matched });
    }
  }
  return results.slice(0, limit);
}

export interface BacklinkResult {
  /** Source note that links to the target. */
  path: string;
  type: string;
  alias?: string;
}

/** `get_backlinks` — resolved backlink edges pointing at `path`. */
export function backlinksFor(snapshot: VaultSnapshot, path: string): BacklinkResult[] {
  if (!snapshot.index.nodes.has(path)) {
    throw new Error(`Note not found: ${path}`);
  }
  return getBacklinks(snapshot.index, path).map((e) => {
    const r: BacklinkResult = { path: e.source, type: e.type };
    if (e.alias !== undefined) r.alias = e.alias;
    return r;
  });
}

export interface GraphNeighborsResult {
  root: string;
  depth: number;
  nodes: Array<{ path: string; title: string; tags: string[] }>;
  edges: Array<{ source: string; target: string; type: string; resolved: boolean }>;
  truncated: boolean;
}

/** Default and maximum traversal depth for `graph_neighbors`. */
export const DEFAULT_DEPTH = 1;
export const MAX_DEPTH = 4;

/** `graph_neighbors` — local subgraph (engine `getLocalGraph`) around `path`. */
export function graphNeighbors(
  snapshot: VaultSnapshot,
  args: { path: string; depth?: number },
): GraphNeighborsResult {
  if (!snapshot.index.nodes.has(args.path)) {
    throw new Error(`Note not found: ${args.path}`);
  }
  let depth = args.depth ?? DEFAULT_DEPTH;
  if (!Number.isFinite(depth) || depth < 0) depth = DEFAULT_DEPTH;
  depth = Math.min(Math.floor(depth), MAX_DEPTH);

  const payload = getLocalGraph(snapshot.index, args.path, depth);
  return {
    root: args.path,
    depth,
    nodes: payload.nodes.map((n) => ({ path: n.path, title: n.title, tags: n.tags })),
    edges: payload.edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      resolved: e.resolved,
    })),
    truncated: payload.truncated,
  };
}

export interface VaultStats {
  notes: number;
  tags: number;
  links: number;
  unresolved: number;
}

/** `vault_stats` — counts of notes, distinct tags, links, and unresolved links. */
export function vaultStats(snapshot: VaultSnapshot): VaultStats {
  const tagSet = new Set<string>();
  for (const node of snapshot.index.nodes.values()) {
    for (const tag of node.tags) tagSet.add(tag.toLowerCase());
  }
  let unresolved = 0;
  for (const edge of snapshot.index.edges) {
    if (!edge.resolved) unresolved++;
  }
  return {
    notes: snapshot.index.nodes.size,
    tags: tagSet.size,
    links: snapshot.index.edges.length,
    unresolved,
  };
}

/**
 * Bind tool handlers to a live {@link VaultManager}. Each call refreshes the
 * snapshot (respecting the TTL) so agents see recent edits.
 */
export interface BoundTools {
  listNotes(args: ListNotesArgs): Promise<NoteSummary[]>;
  readNote(path: string): Promise<string>;
  searchNotes(args: { query: string; limit?: number }): Promise<SearchResult[]>;
  backlinksFor(path: string): Promise<BacklinkResult[]>;
  graphNeighbors(args: { path: string; depth?: number }): Promise<GraphNeighborsResult>;
  vaultStats(): Promise<VaultStats>;
}

export function bindTools(manager: VaultManager): BoundTools {
  return {
    async listNotes(args) {
      return listNotes(await manager.getSnapshot(), args);
    },
    async readNote(path) {
      return readNote(await manager.getSnapshot(), path);
    },
    async searchNotes(args) {
      return searchNotes(await manager.getSnapshot(), args);
    },
    async backlinksFor(path) {
      return backlinksFor(await manager.getSnapshot(), path);
    },
    async graphNeighbors(args) {
      return graphNeighbors(await manager.getSnapshot(), args);
    },
    async vaultStats() {
      return vaultStats(await manager.getSnapshot());
    },
  };
}
