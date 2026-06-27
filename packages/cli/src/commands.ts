/**
 * Pure, IO-free command logic for the graphvault CLI.
 *
 * Every exported function takes a pre-built GraphIndex (or the raw note data)
 * and returns a plain data result. No filesystem reads, no console.log here -
 * all that lives in the index.ts entry-point so this module is unit-testable
 * with node:test.
 */

import type { GraphIndex, NoteInput } from '@graphvault/engine';
import { buildIndex, getGraph } from '@graphvault/engine';
import type { GraphResult, NoteEntry, SearchResult, StatsResult } from './types.js';

/** Build an index from a list of NoteInput values. */
export function buildFromNotes(notes: NoteInput[]): GraphIndex {
  return buildIndex(notes);
}

/**
 * List all notes as path + title, sorted by path.
 */
export function listNotes(index: GraphIndex): NoteEntry[] {
  return [...index.nodes.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((n) => ({ path: n.path, title: n.title }));
}

/**
 * Search notes by case-insensitive title or content substring.
 * `contents` must be passed in parallel with `notes` (same index order)
 * so we can check the raw text without re-reading files.
 */
export function searchNotes(index: GraphIndex, notes: NoteInput[], query: string): SearchResult[] {
  const q = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const note of notes) {
    const node = index.nodes.get(note.path);
    if (!node) continue;
    const titleHit = node.title.toLowerCase().includes(q);
    const contentHit = note.content.toLowerCase().includes(q);
    if (!titleHit && !contentHit) continue;

    let context: string | undefined;
    if (contentHit) {
      const idx = note.content.toLowerCase().indexOf(q);
      const start = Math.max(0, idx - 40);
      const end = Math.min(note.content.length, idx + query.length + 40);
      const snippet = note.content.slice(start, end).replace(/\n/g, ' ').trim();
      context = (start > 0 ? '…' : '') + snippet + (end < note.content.length ? '…' : '');
    }
    results.push({ path: note.path, title: node.title, context });
  }

  return results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Compute vault statistics:
 * - note count, link count (total and resolved), tag count
 * - top 10 tags by usage frequency
 * - orphan notes (nodes with no resolved inbound links)
 */
export function computeStats(index: GraphIndex): StatsResult {
  const noteCount = index.nodes.size;
  const linkCount = index.edges.length;
  const resolvedLinkCount = index.edges.filter((e) => e.resolved).length;

  // Collect all tags across all nodes.
  const tagFrequency = new Map<string, number>();
  for (const node of index.nodes.values()) {
    for (const tag of node.tags) {
      tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
    }
  }
  const tagCount = tagFrequency.size;

  const topTags = [...tagFrequency.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  // Orphan notes: no resolved inbound link from any other note.
  const hasInbound = new Set<string>();
  for (const edge of index.edges) {
    if (edge.resolved) hasInbound.add(edge.target);
  }
  const orphanNotes = [...index.nodes.keys()].filter((id) => !hasInbound.has(id)).sort();

  return { noteCount, linkCount, resolvedLinkCount, tagCount, topTags, orphanNotes };
}

/**
 * Return the full graph payload (nodes + edges) using the engine's getGraph.
 * Shaped for easy JSON serialisation or pretty printing.
 */
export function graphPayload(index: GraphIndex, includeUnresolved = false): GraphResult {
  const payload = getGraph(index, { includeUnresolved });
  return {
    nodes: payload.nodes.map((n) => ({ id: n.id, title: n.title, tags: n.tags })),
    edges: payload.edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      resolved: e.resolved,
    })),
    truncated: payload.truncated,
  };
}
