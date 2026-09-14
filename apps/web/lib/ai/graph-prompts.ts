/**
 * Pure prompt-builders for AI graph intelligence (M21).
 *
 * Privacy contract (same rules as prompts.ts):
 *  - ONLY titles and structural data (topology) are sent - note bodies NEVER
 *    leave the client through these builders.
 *  - Builders return `ChatMessage[]` ready to pass straight to `chat()`.
 *  - Every function here is pure and side-effect-free: no network, no React,
 *    no localStorage. Fully unit-testable in Node.
 *
 * Three graph-specific AI actions:
 *
 *  1. `buildClusterNamePrompt`  - given a list of cluster node-title sets,
 *     ask the model to label each cluster with a short, descriptive name.
 *
 *  2. `buildRelatedNotesPrompt` - given a selected note's title, its direct
 *     neighbours (by title), and the full vault title list, ask the model
 *     which other notes are likely related.
 *
 *  3. `buildGapFindingPrompt`   - given a selected note's title and its
 *     neighbourhood titles, ask the model what useful notes are *missing*
 *     from this cluster of thought.
 *
 * Response parsing:
 *  `parseClusterNames`      - parse the model's numbered/bulleted cluster-name
 *                             list back into an array of strings.
 *  `parseRelatedNotes`      - parse the model's "related notes" answer into
 *                             a list of `{ title, reason }` items, mapping
 *                             each title back to a node ID using the provided
 *                             lookup map.
 *  `parseGapSuggestions`    - parse the model's "gap" suggestions into a
 *                             simple string array (suggested note titles).
 *
 * All parsers validate their input and never throw; they return an empty /
 * best-effort result on malformed model output.
 */

import type { ChatMessage } from './types';

// ---------------------------------------------------------------------------
// Shared system prompt for graph actions
// ---------------------------------------------------------------------------

const GRAPH_SYSTEM_PROMPT =
  'You are a knowledge-graph assistant for a private Markdown notes app called GraphVault. ' +
  'You reason over note TITLES and graph structure only - you never see or repeat note body content. ' +
  'Be concise and specific. Return well-structured plain text or short Markdown lists. ' +
  'Do not fabricate note titles, URLs, or references that were not given to you.';

// ---------------------------------------------------------------------------
// 1. Cluster naming
// ---------------------------------------------------------------------------

/**
 * Cluster descriptor passed to the prompt builder. Contains only titles.
 */
export interface ClusterInput {
  /** Index into the cluster array (used as a stable key). */
  index: number;
  /** Node titles in this cluster. Never note bodies. */
  titles: string[];
}

/** Maximum titles per cluster we include in the prompt to stay within token budgets. */
export const MAX_TITLES_PER_CLUSTER = 20;

/** Maximum clusters to name in one call. */
export const MAX_CLUSTERS_TO_NAME = 10;

/**
 * Build the chat messages to name a set of graph clusters.
 *
 * Sends ONLY: cluster membership expressed as note titles (no bodies).
 * Each cluster is listed with its member titles; the model must return
 * the same number of short names, one per line / bullet.
 *
 * @param clusters - Up to `MAX_CLUSTERS_TO_NAME` clusters with their titles.
 */
export function buildClusterNamePrompt(clusters: ClusterInput[]): ChatMessage[] {
  if (clusters.length === 0) {
    return [
      { role: 'system', content: GRAPH_SYSTEM_PROMPT },
      { role: 'user', content: 'No clusters to name.' },
    ];
  }

  const clusterSection = clusters
    .map((c, i) => {
      const shown = c.titles.slice(0, MAX_TITLES_PER_CLUSTER);
      const titlesStr = shown.join(', ');
      const extra =
        c.titles.length > MAX_TITLES_PER_CLUSTER
          ? ` ... (+${c.titles.length - MAX_TITLES_PER_CLUSTER} more)`
          : '';
      return `Cluster ${i + 1}: ${titlesStr}${extra}`;
    })
    .join('\n');

  const user: ChatMessage = {
    role: 'user',
    content:
      `I have ${clusters.length} connected cluster${clusters.length === 1 ? '' : 's'} of notes ` +
      `in my knowledge graph. Each cluster is listed below with the titles of its member notes.\n\n` +
      `${clusterSection}\n\n` +
      `Please give each cluster a short, descriptive name (3-6 words) that captures ` +
      `the common theme of its notes. ` +
      `Return ONLY a numbered list, one line per cluster, in the same order:\n` +
      `1. <name for Cluster 1>\n2. <name for Cluster 2>\n... and so on.`,
  };

  return [{ role: 'system', content: GRAPH_SYSTEM_PROMPT }, user];
}

/**
 * Parse the model's cluster-name response into an ordered string array.
 *
 * Handles both "1. Name" and "- Name" (and bare lines) formats.
 * Returns up to `expectedCount` names; shorter if the model returned fewer.
 * Never throws.
 *
 * @param raw - The raw text from the model.
 * @param expectedCount - How many clusters were asked about.
 */
export function parseClusterNames(raw: string, expectedCount: number): string[] {
  if (!raw || expectedCount <= 0) return [];

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const names: string[] = [];
  for (const line of lines) {
    if (names.length >= expectedCount) break;
    // Strip leading "1." "1)" "-" "*" numbering/bullets.
    const stripped = line.replace(/^(\d+[.)]\s*|-\s*|\*\s*)/, '').trim();
    if (stripped) names.push(stripped);
  }

  return names;
}

// ---------------------------------------------------------------------------
// 2. Related notes
// ---------------------------------------------------------------------------

/** Maximum vault titles included in the related-notes prompt. */
export const MAX_VAULT_TITLES_IN_PROMPT = 200;

/**
 * Build the chat messages to surface related notes for a selected node.
 *
 * Sends: selected note title + its neighbour titles (topology, no bodies) +
 * the full vault title list (for the model to choose from).
 *
 * @param selectedTitle   - Title of the selected note.
 * @param neighbourTitles - Titles of notes directly connected to it.
 * @param allTitles       - All note titles in the vault.
 */
export function buildRelatedNotesPrompt(
  selectedTitle: string,
  neighbourTitles: string[],
  allTitles: string[],
): ChatMessage[] {
  const neighbourSection =
    neighbourTitles.length > 0
      ? `\nNotes already directly linked to it:\n${neighbourTitles
          .slice(0, 30)
          .map((t) => `- ${t}`)
          .join('\n')}`
      : '\n(No notes are currently linked to it.)';

  // Limit the vault list to avoid enormous prompts.
  const vaultSample = allTitles.slice(0, MAX_VAULT_TITLES_IN_PROMPT);
  const vaultSection =
    vaultSample.length > 0
      ? `\nAll note titles in the vault (${allTitles.length} total, showing ${vaultSample.length}):\n` +
        vaultSample.map((t) => `- ${t}`).join('\n')
      : '\n(Vault is empty.)';

  const user: ChatMessage = {
    role: 'user',
    content:
      `Selected note: "${selectedTitle}"` +
      neighbourSection +
      vaultSection +
      `\n\nWhich notes from the vault list above are most likely related to "${selectedTitle}" ` +
      `but are NOT already linked to it? ` +
      `List up to 6, with a one-sentence reason for each. ` +
      `Use this exact format:\n` +
      `- **<title>**: <reason>\n` +
      `Only mention titles that appear in the vault list above.`,
  };

  return [{ role: 'system', content: GRAPH_SYSTEM_PROMPT }, user];
}

/**
 * A single parsed related-note suggestion.
 */
export interface RelatedNoteSuggestion {
  /** Title exactly as returned by the model. */
  title: string;
  /** One-sentence reason from the model. */
  reason: string;
  /**
   * Resolved node ID if the title maps to a known vault note.
   * `undefined` when the model hallucinated or used a slightly different title.
   */
  nodeId: string | undefined;
}

/**
 * Parse the model's related-notes response into structured suggestions.
 *
 * Expected format: `- **Title**: Reason` or `- Title: Reason`
 * Also handles `1. **Title**: Reason`.
 * Resolves each title against the provided `titleToId` map.
 * Never throws.
 *
 * @param raw       - Raw text from the model.
 * @param titleToId - Map from note title (lowercase-trimmed) to node ID.
 */
export function parseRelatedNotes(
  raw: string,
  titleToId: Map<string, string>,
): RelatedNoteSuggestion[] {
  if (!raw) return [];

  const results: RelatedNoteSuggestion[] = [];
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (results.length >= 6) break;

    // Strip leading bullet / number.
    const stripped = line.replace(/^(\d+[.)]\s*|-\s*|\*\s*)/, '').trim();
    if (!stripped) continue;

    // Try "**Title**: Reason" or "Title: Reason"
    const boldMatch = stripped.match(/^\*\*(.+?)\*\*\s*[:\--]\s*(.+)$/);
    const plainMatch = stripped.match(/^(.+?)\s*[:\--]\s*(.+)$/);

    const match = boldMatch ?? plainMatch;
    if (!match) continue;

    const title = (match[1] ?? '').trim();
    const reason = (match[2] ?? '').trim();
    if (!title || !reason) continue;

    // Try exact match then lowercase match.
    const nodeId = titleToId.get(title) ?? titleToId.get(title.toLowerCase()) ?? undefined;
    results.push({ title, reason, nodeId });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 3. Gap finding
// ---------------------------------------------------------------------------

/**
 * Build the chat messages to find knowledge gaps for a selected node.
 *
 * Sends: selected note title + its neighbourhood titles.
 * Asks the model to suggest MISSING notes that would strengthen this cluster.
 *
 * @param selectedTitle   - Title of the selected note.
 * @param neighbourTitles - Titles of notes in the neighbourhood.
 */
export function buildGapFindingPrompt(
  selectedTitle: string,
  neighbourTitles: string[],
): ChatMessage[] {
  const neighbourSection =
    neighbourTitles.length > 0
      ? `\nExisting notes in its neighbourhood:\n${neighbourTitles
          .slice(0, 30)
          .map((t) => `- ${t}`)
          .join('\n')}`
      : '\n(No notes are currently linked to it.)';

  const user: ChatMessage = {
    role: 'user',
    content:
      `Selected note: "${selectedTitle}"` +
      neighbourSection +
      `\n\nBased on the cluster of notes above, what useful notes are MISSING from this area ` +
      `of the knowledge graph? Suggest 3-6 note titles that would fill gaps or strengthen ` +
      `the connections. These are notes that don't exist yet - possible future notes to create.\n` +
      `Return a plain numbered list of suggested note titles only (no explanations, just titles):`,
  };

  return [{ role: 'system', content: GRAPH_SYSTEM_PROMPT }, user];
}

/**
 * Parse the model's gap-finding response into an array of suggested titles.
 *
 * Expected format: `1. Title` or `- Title`.
 * Returns at most 6 suggestions. Never throws.
 */
export function parseGapSuggestions(raw: string): string[] {
  if (!raw) return [];

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const suggestions: string[] = [];
  for (const line of lines) {
    if (suggestions.length >= 6) break;
    // Strip leading "1." "1)" "-" "*"
    const stripped = line.replace(/^(\d+[.)]\s*|-\s*|\*\s*)/, '').trim();
    // Strip surrounding quotes or bold markers.
    const clean = stripped
      .replace(/^\*\*(.+)\*\*$/, '$1')
      .replace(/^["“](.+)["”]$/, '$1')
      .trim();
    if (clean && clean.length < 120) {
      suggestions.push(clean);
    }
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Context descriptor (shown to user before sending)
// ---------------------------------------------------------------------------

/**
 * Human-readable description of what will be sent to the AI for each
 * graph action. Used in the "confirm what's sent" affordance.
 * Mirrors `buildSendContext` from `prompts.ts` but for graph actions.
 */
export function buildGraphSendContext(
  action: 'cluster-names' | 'related-notes' | 'find-gaps',
  params: {
    clusterCount?: number;
    totalTitles?: number;
    selectedTitle?: string;
    neighbourCount?: number;
  },
): { description: string; detail: string } {
  switch (action) {
    case 'cluster-names':
      return {
        description: `${params.clusterCount ?? 0} cluster title lists`,
        detail:
          'Sends only note titles grouped by cluster - no note content. ' +
          'The AI will label each cluster with a short descriptive name.',
      };
    case 'related-notes':
      return {
        description:
          `"${params.selectedTitle ?? ''}" + ` +
          `${params.neighbourCount ?? 0} neighbours + ` +
          `${params.totalTitles ?? 0} vault titles`,
        detail:
          'Sends only note titles and link topology - no note content. ' +
          'The AI will suggest related notes not yet linked.',
      };
    case 'find-gaps':
      return {
        description:
          `"${params.selectedTitle ?? ''}" + ` +
          `${params.neighbourCount ?? 0} neighbourhood titles`,
        detail:
          'Sends only note titles and link topology - no note content. ' +
          'The AI will suggest missing notes to fill knowledge gaps.',
      };
  }
}
