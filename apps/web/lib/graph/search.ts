/**
 * Pure, framework-free helpers for in-graph node search.
 *
 * `matchNodes` takes a query string and the full list of render-ready nodes and
 * returns the subset whose title or tagKey contains the query (case-insensitive,
 * substring). The caller then uses the returned `Set<string>` of IDs to dim
 * non-matching nodes on the canvas and display a live match count.
 *
 * Keeping this function outside React means it is unit-testable with node:test
 * and reusable by future non-UI consumers (e.g. an analytics pipeline).
 */

import type { RenderNode } from './model';

/**
 * Return the IDs of nodes whose title or first tag contains `query`
 * (case-insensitive substring). Returns `null` when the query is blank so the
 * caller can distinguish "no search active" from "search active, zero matches".
 */
export function matchNodes(nodes: readonly RenderNode[], query: string): Set<string> | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const ids = new Set<string>();
  for (const node of nodes) {
    const titleMatch = node.title.toLowerCase().includes(q);
    const tagMatch = node.tagKey?.toLowerCase().includes(q) ?? false;
    if (titleMatch || tagMatch) ids.add(node.id);
  }
  return ids;
}

/**
 * Produce a human-readable summary of the match state.
 *
 *   "3 matches"
 *   "1 match"
 *   "No matches"
 */
export function matchSummary(count: number): string {
  if (count === 0) return 'No matches';
  return count === 1 ? '1 match' : `${count} matches`;
}
