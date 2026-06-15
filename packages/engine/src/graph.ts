/**
 * Renderer-agnostic graph API over a built {@link GraphIndex}.
 *
 * Every function returns a plain {@link GraphPayload} (`{ nodes, edges,
 * truncated }`) with no framework or DOM dependencies, suitable for any
 * renderer (React force graph, Cytoscape, server JSON, …).
 */

import type { GraphEdge, GraphIndex, GraphNode, GraphPayload, LinkType } from './types.js';

/** Default cap on the number of nodes returned by {@link getGraph}. */
export const DEFAULT_NODE_CAP = 2000;

export interface GetGraphOptions {
  /**
   * Maximum number of nodes to return. When the index has more, the result is
   * capped and `truncated` is set. Defaults to {@link DEFAULT_NODE_CAP}.
   */
  nodeCap?: number;
  /** Include edges to unresolved (missing) targets. Default `false`. */
  includeUnresolved?: boolean;
}

/** Filter criteria for {@link filterGraph}. All criteria are AND-combined. */
export interface FilterCriteria {
  /** Keep notes having at least one of these tags (case-insensitive). */
  tags?: string[];
  /** Keep notes whose folder equals or is nested under one of these. */
  folders?: string[];
  /** Keep notes whose `updatedAt` falls within this inclusive range (epoch ms). */
  updatedFrom?: number;
  updatedTo?: number;
  /** Keep only edges of these link types. */
  linkTypes?: LinkType[];
  /** Max nodes; truncates like {@link getGraph}. Defaults to {@link DEFAULT_NODE_CAP}. */
  nodeCap?: number;
  /** Include edges to unresolved targets. Default `false`. */
  includeUnresolved?: boolean;
}

/**
 * Build a payload from a chosen node set, keeping only edges whose endpoints
 * are both present (and, unless `includeUnresolved`, that are resolved).
 */
function payloadFromNodes(
  nodeList: GraphNode[],
  edges: readonly GraphEdge[],
  opts: { includeUnresolved: boolean; linkTypes?: Set<LinkType>; truncated: boolean },
): GraphPayload {
  const present = new Set(nodeList.map((n) => n.id));
  const keptEdges: GraphEdge[] = [];
  for (const edge of edges) {
    if (opts.linkTypes && !opts.linkTypes.has(edge.type)) continue;
    if (!present.has(edge.source)) continue;
    if (edge.resolved) {
      if (!present.has(edge.target)) continue;
    } else if (!opts.includeUnresolved) {
      continue;
    }
    keptEdges.push(edge);
  }
  return { nodes: nodeList, edges: keptEdges, truncated: opts.truncated };
}

/** Stable node ordering: by id, so output is deterministic. */
function sortedNodes(nodes: Iterable<GraphNode>): GraphNode[] {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The full graph, capped at `nodeCap` nodes. When capped, `truncated` is true
 * and only edges among the retained nodes are returned.
 */
export function getGraph(index: GraphIndex, opts: GetGraphOptions = {}): GraphPayload {
  const cap = opts.nodeCap ?? DEFAULT_NODE_CAP;
  const all = sortedNodes(index.nodes.values());
  const truncated = all.length > cap;
  const nodeList = truncated ? all.slice(0, cap) : all;
  return payloadFromNodes(nodeList, index.edges, {
    includeUnresolved: opts.includeUnresolved ?? false,
    truncated,
  });
}

export interface GetLocalGraphOptions {
  /** Traverse along resolved backlinks as well as outbound links. Default `true`. */
  includeBacklinks?: boolean;
  /** Include edges to unresolved targets on the frontier. Default `false`. */
  includeUnresolved?: boolean;
}

/**
 * BFS subgraph around `noteId` out to `depth` hops. Depth 0 is the note alone;
 * depth 1 adds its direct neighbours, and so on. Returns an empty payload when
 * the note is unknown.
 */
export function getLocalGraph(
  index: GraphIndex,
  noteId: string,
  depth: number,
  opts: GetLocalGraphOptions = {},
): GraphPayload {
  if (!index.nodes.has(noteId)) {
    return { nodes: [], edges: [], truncated: false };
  }
  const includeBacklinks = opts.includeBacklinks ?? true;
  const maxDepth = Math.max(0, Math.floor(depth));

  const visited = new Set<string>([noteId]);
  let frontier: string[] = [noteId];

  for (let d = 0; d < maxDepth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of index.outbound.get(id) ?? []) {
        if (edge.resolved && !visited.has(edge.target)) {
          visited.add(edge.target);
          next.push(edge.target);
        }
      }
      if (includeBacklinks) {
        for (const edge of index.backlinks.get(id) ?? []) {
          if (!visited.has(edge.source)) {
            visited.add(edge.source);
            next.push(edge.source);
          }
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const nodeList = sortedNodes(
    [...visited].map((id) => index.nodes.get(id)!).filter((n): n is GraphNode => n !== undefined),
  );
  return payloadFromNodes(nodeList, index.edges, {
    includeUnresolved: opts.includeUnresolved ?? false,
    truncated: false,
  });
}

/** True when `folder` equals `root` or is nested under it. */
function folderMatches(folder: string, root: string): boolean {
  if (root === '') return true;
  return folder === root || folder.startsWith(`${root}/`);
}

/**
 * Filter the graph by tags, folders, updated-date range, and link types. All
 * supplied criteria are combined with AND. Edges are kept only between retained
 * nodes (and matching `linkTypes`, when given).
 */
export function filterGraph(index: GraphIndex, criteria: FilterCriteria = {}): GraphPayload {
  const wantTags = criteria.tags?.map((t) => t.toLowerCase());
  const wantFolders = criteria.folders;
  const cap = criteria.nodeCap ?? DEFAULT_NODE_CAP;

  const matched: GraphNode[] = [];
  for (const node of index.nodes.values()) {
    if (wantTags && wantTags.length > 0) {
      const nodeTags = node.tags.map((t) => t.toLowerCase());
      if (!wantTags.some((t) => nodeTags.includes(t))) continue;
    }
    if (wantFolders && wantFolders.length > 0) {
      if (!wantFolders.some((f) => folderMatches(node.folder, f))) continue;
    }
    if (criteria.updatedFrom !== undefined) {
      if (node.updatedAt === undefined || node.updatedAt < criteria.updatedFrom) continue;
    }
    if (criteria.updatedTo !== undefined) {
      if (node.updatedAt === undefined || node.updatedAt > criteria.updatedTo) continue;
    }
    matched.push(node);
  }

  const sorted = sortedNodes(matched);
  const truncated = sorted.length > cap;
  const nodeList = truncated ? sorted.slice(0, cap) : sorted;

  return payloadFromNodes(nodeList, index.edges, {
    includeUnresolved: criteria.includeUnresolved ?? false,
    linkTypes: criteria.linkTypes ? new Set(criteria.linkTypes) : undefined,
    truncated,
  });
}
