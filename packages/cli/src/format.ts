/**
 * Human-readable formatting for command results.
 *
 * All functions return a string (no console.log); the entry-point prints them.
 * This keeps formatting testable.
 */

import type { CodeGraph } from '@graphvault/engine';
import type { GraphResult, NoteEntry, SearchResult, StatsResult } from './types.js';

/** Box-draw separator line. */
function hr(width = 60): string {
  return '─'.repeat(width);
}

export function formatList(notes: NoteEntry[]): string {
  if (notes.length === 0) return '(no notes found)';
  const lines = notes.map((n) => `  ${n.path.padEnd(50)} ${n.title}`);
  return [`Notes (${notes.length})`, hr(), ...lines].join('\n');
}

export function formatSearch(results: SearchResult[], query: string): string {
  if (results.length === 0) return `No results for "${query}"`;
  const lines: string[] = [`Results for "${query}" (${results.length})`, hr()];
  for (const r of results) {
    lines.push(`  ${r.path}`);
    lines.push(`    Title: ${r.title}`);
    if (r.context !== undefined) lines.push(`    …${r.context}`);
  }
  return lines.join('\n');
}

export function formatStats(stats: StatsResult): string {
  const lines: string[] = [
    'Vault Statistics',
    hr(),
    `  Notes          : ${stats.noteCount}`,
    `  Links (total)  : ${stats.linkCount}`,
    `  Links (resolved): ${stats.resolvedLinkCount}`,
    `  Unique tags    : ${stats.tagCount}`,
  ];

  if (stats.topTags.length > 0) {
    lines.push('', 'Top Tags');
    lines.push(hr());
    for (const { tag, count } of stats.topTags) {
      lines.push(`  #${tag.padEnd(28)} ${count}`);
    }
  }

  if (stats.orphanNotes.length > 0) {
    lines.push('', `Orphan Notes (${stats.orphanNotes.length} - no inbound links)`);
    lines.push(hr());
    for (const p of stats.orphanNotes) lines.push(`  ${p}`);
  } else {
    lines.push('', '(No orphan notes - all notes are linked.)');
  }

  return lines.join('\n');
}

export function formatGraph(graph: GraphResult): string {
  const lines: string[] = [
    `Graph  (${graph.nodes.length} nodes, ${graph.edges.length} edges${graph.truncated ? ', truncated' : ''})`,
    hr(),
    'Nodes:',
  ];
  for (const n of graph.nodes) {
    const tags = n.tags.length > 0 ? `  [${n.tags.map((t) => `#${t}`).join(' ')}]` : '';
    lines.push(`  ${n.id}${tags}`);
  }
  lines.push('', 'Edges:');
  for (const e of graph.edges) {
    const marker = e.resolved ? '->' : '~~>';
    lines.push(`  ${e.source} ${marker} ${e.target}  (${e.type})`);
  }
  return lines.join('\n');
}

export function formatGraphJson(graph: GraphResult): string {
  return JSON.stringify(graph, null, 2);
}

export function formatCodeGraph(graph: CodeGraph): string {
  const resolvedCount = graph.edges.filter((e) => e.resolved).length;
  const lines: string[] = [
    `Code graph  (${graph.nodes.length} files, ${graph.edges.length} imports, ${resolvedCount} resolved intra-repo)`,
    hr(),
    'Files:',
  ];
  for (const n of graph.nodes) {
    lines.push(`  ${n.path}  (${n.lines} lines)`);
  }
  lines.push('', 'Imports:');
  for (const e of graph.edges) {
    const marker = e.resolved ? '->' : '~~>';
    lines.push(`  ${e.from} ${marker} ${e.to}`);
  }
  return lines.join('\n');
}

export function formatCodeGraphJson(graph: CodeGraph): string {
  return JSON.stringify(graph, null, 2);
}

/** One file's dependency/dependent listing (used by --dependencies / --dependents). */
export function formatFileRelations(
  path: string,
  kind: 'dependencies' | 'dependents',
  files: string[],
): string {
  if (files.length === 0)
    return `${path} has no ${kind === 'dependencies' ? 'resolved intra-repo imports' : 'known dependents'}.`;
  const label = kind === 'dependencies' ? 'imports' : 'is imported by';
  return [`${path} ${label} (${files.length}):`, ...files.map((f) => `  ${f}`)].join('\n');
}
