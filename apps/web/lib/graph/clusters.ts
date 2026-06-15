/**
 * Pure, framework-free community / cluster detection for the graph view.
 *
 * Two algorithms, both O(V + E):
 *
 * 1. `computeConnectedComponents` — strict connected-components (nodes with no
 *    edges each get their own singleton component). Fast, deterministic, and
 *    enough to give the graph clear structural grouping.
 *
 * 2. `assignClusterColors` — maps the component IDs computed above onto the
 *    graph palette so every node in the same cluster shares a colour. The
 *    palette wraps around for large graphs; large singletons are always shown
 *    in neutral grey to keep the visual clean.
 *
 * These are intentionally side-effect-free: they accept plain objects and
 * return new objects — no canvas, no React, no DOM.
 */

import { GRAPH_NEUTRAL, GRAPH_PALETTE } from './model';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterNode {
  id: string;
}

export interface ClusterEdge {
  source: string;
  target: string;
}

/**
 * Result from connected-components. Each node maps to a cluster id (a small
 * integer starting at 0, ordered by discovery so it is deterministic given a
 * stable node/edge order).
 */
export interface ClusterResult {
  /** node id → cluster id (0-indexed) */
  nodeCluster: Map<string, number>;
  /** How many distinct clusters were found. */
  clusterCount: number;
  /**
   * cluster id → number of nodes in it. Ordered by cluster id so cluster 0
   * is always the largest (caller may re-order if desired).
   */
  clusterSize: Map<number, number>;
}

// ---------------------------------------------------------------------------
// Connected components (Union-Find / BFS)
// ---------------------------------------------------------------------------

/**
 * Compute connected components of an undirected interpretation of the graph
 * (edges treated as bidirectional, regardless of `source`/`target` direction).
 *
 * Pure — no mutations to input objects, no global state.
 */
export function computeConnectedComponents(
  nodes: readonly ClusterNode[],
  edges: readonly ClusterEdge[],
): ClusterResult {
  if (nodes.length === 0) {
    return { nodeCluster: new Map(), clusterCount: 0, clusterSize: new Map() };
  }

  // Build adjacency list for undirected traversal.
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);

  for (const e of edges) {
    const src = adjacency.get(e.source);
    const tgt = adjacency.get(e.target);
    // Only connect nodes that are actually in the node set.
    if (src !== undefined && tgt !== undefined) {
      src.push(e.target);
      tgt.push(e.source);
    }
  }

  const visited = new Set<string>();
  const nodeCluster = new Map<string, number>();
  let clusterId = 0;

  // BFS for each unvisited node.
  for (const n of nodes) {
    if (visited.has(n.id)) continue;

    const queue: string[] = [n.id];
    visited.add(n.id);

    while (queue.length > 0) {
      const cur = queue.shift()!;
      nodeCluster.set(cur, clusterId);

      for (const neighbour of adjacency.get(cur) ?? []) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          queue.push(neighbour);
        }
      }
    }

    clusterId++;
  }

  // Compute cluster sizes.
  const clusterSize = new Map<number, number>();
  for (const cid of nodeCluster.values()) {
    clusterSize.set(cid, (clusterSize.get(cid) ?? 0) + 1);
  }

  return { nodeCluster, clusterCount: clusterId, clusterSize };
}

// ---------------------------------------------------------------------------
// Colour assignment
// ---------------------------------------------------------------------------

/**
 * The minimum cluster size to receive a distinctive palette colour. Singleton
 * isolated nodes (or very small clusters) are drawn in the neutral colour so
 * the palette only highlights meaningful communities.
 */
export const CLUSTER_SINGLETON_THRESHOLD = 2;

/**
 * Assign a hex colour to each cluster, taking into account cluster sizes.
 *
 * Strategy:
 * - Sort clusters by descending size so large clusters get the first,
 *   most-distinctive palette slots.
 * - Clusters smaller than `CLUSTER_SINGLETON_THRESHOLD` receive the neutral
 *   grey so the canvas isn't cluttered with rare colours.
 * - The palette wraps around if there are more large clusters than palette
 *   entries.
 *
 * Returns a map from `clusterId → hex colour string`.
 */
export function assignClusterColors(result: ClusterResult): Map<number, string> {
  const colorMap = new Map<number, string>();

  if (result.clusterCount === 0) return colorMap;

  // Sort cluster IDs by descending size.
  const sorted = [...result.clusterSize.entries()].sort((a, b) => b[1] - a[1]);

  let paletteIndex = 0;
  for (const [cid, size] of sorted) {
    if (size < CLUSTER_SINGLETON_THRESHOLD) {
      colorMap.set(cid, GRAPH_NEUTRAL);
    } else {
      colorMap.set(cid, GRAPH_PALETTE[paletteIndex % GRAPH_PALETTE.length]);
      paletteIndex++;
    }
  }

  return colorMap;
}

// ---------------------------------------------------------------------------
// Convenience: build the full cluster colour map for a graph in one call
// ---------------------------------------------------------------------------

export interface ClusterColorInfo {
  result: ClusterResult;
  colorMap: Map<number, string>;
  /** Convenience: node id → colour. */
  nodeColor: Map<string, string>;
}

/**
 * Single entry point: compute clusters and build the node-colour map in one
 * step. Returns a `nodeColor` map keyed by node id for fast per-node lookup
 * inside the canvas draw callback.
 */
export function buildClusterColors(
  nodes: readonly ClusterNode[],
  edges: readonly ClusterEdge[],
): ClusterColorInfo {
  const result = computeConnectedComponents(nodes, edges);
  const colorMap = assignClusterColors(result);

  const nodeColor = new Map<string, string>();
  for (const [nodeId, cid] of result.nodeCluster) {
    nodeColor.set(nodeId, colorMap.get(cid) ?? GRAPH_NEUTRAL);
  }

  return { result, colorMap, nodeColor };
}

// ---------------------------------------------------------------------------
// Legend helper
// ---------------------------------------------------------------------------

/**
 * Build legend entries for the cluster view. Returns at most `maxEntries`
 * items (the largest clusters), plus a summary row if more exist. The legend
 * mirrors exactly what `assignClusterColors` draws so it can never drift.
 */
export function clusterLegendEntries(
  result: ClusterResult,
  colorMap: Map<number, string>,
  maxEntries = 6,
): Array<{ label: string; color: string }> {
  // Gather clusters with distinct (non-neutral) colours, largest first.
  const sorted = [...result.clusterSize.entries()]
    .filter(([cid]) => colorMap.get(cid) !== GRAPH_NEUTRAL)
    .sort((a, b) => b[1] - a[1]);

  const items = sorted.slice(0, maxEntries).map(([cid, size], i) => ({
    label: `Cluster ${i + 1} (${size})`,
    color: colorMap.get(cid) ?? GRAPH_NEUTRAL,
  }));

  // If there are singletons / tiny clusters, add a grey row.
  const singletonCount = [...result.clusterSize.values()].filter(
    (s) => s < CLUSTER_SINGLETON_THRESHOLD,
  ).length;
  if (singletonCount > 0) {
    items.push({ label: `Isolated (${singletonCount})`, color: GRAPH_NEUTRAL });
  }

  return items;
}

// ---------------------------------------------------------------------------
// AI helper: extract title sets per cluster
// ---------------------------------------------------------------------------

export interface ClusterTitleNode {
  id: string;
  title: string;
}

/**
 * Build an ordered list of `{ index, titles }` descriptors for each
 * non-singleton cluster (size >= `CLUSTER_SINGLETON_THRESHOLD`), sorted by
 * descending cluster size. Used by the AI cluster-naming prompt builder
 * (`lib/ai/graph-prompts.ts`) which must receive ONLY titles, never bodies.
 *
 * @param nodes     - Nodes with an id and title (no bodies).
 * @param result    - ClusterResult from `computeConnectedComponents`.
 * @param colorMap  - Color map from `assignClusterColors` (used to filter to
 *                    non-neutral clusters, matching the visual legend).
 * @param maxClusters - Cap on the number of clusters returned (default 10).
 */
export function clusterTitlesForAI(
  nodes: readonly ClusterTitleNode[],
  result: ClusterResult,
  colorMap: Map<number, string>,
  maxClusters = 10,
): Array<{ index: number; titles: string[] }> {
  // Build nodeId → title map.
  const titleOf = new Map<string, string>(nodes.map((n) => [n.id, n.title]));

  // Build clusterId → titles array.
  const clusterTitles = new Map<number, string[]>();
  for (const [nodeId, clusterId] of result.nodeCluster) {
    const title = titleOf.get(nodeId);
    if (!title) continue;
    if (!clusterTitles.has(clusterId)) clusterTitles.set(clusterId, []);
    clusterTitles.get(clusterId)!.push(title);
  }

  // Only include clusters with a non-neutral colour (mirrors the visual legend).
  const visibleClusters = [...result.clusterSize.entries()]
    .filter(([cid]) => colorMap.get(cid) !== GRAPH_NEUTRAL)
    .sort((a, b) => b[1] - a[1]) // largest first
    .slice(0, maxClusters);

  return visibleClusters.map(([cid], i) => ({
    index: i,
    titles: clusterTitles.get(cid) ?? [],
  }));
}
