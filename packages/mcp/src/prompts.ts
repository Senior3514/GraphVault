/**
 * MCP Prompts: ready-made, parameterized prompt templates that embed real vault
 * context so an MCP host (e.g. Claude Desktop) can one-click a useful workflow.
 *
 * Each builder is a pure function over a {@link VaultSnapshot}: it reuses the
 * existing read-tool/vault helpers to fetch note content, backlinks, neighbors,
 * or search hits, then assembles a {@link GetPromptResult} of user messages. No
 * fetching is duplicated and nothing is mutated. Builders are split from the
 * transport so they can be unit-tested directly against an in-memory snapshot.
 */

import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { backlinksFor, graphNeighbors, readNote, searchNotes } from './tools.js';
import type { VaultManager, VaultSnapshot } from './vault.js';

/** A single user message carrying text content. */
function userText(text: string): GetPromptResult['messages'][number] {
  return { role: 'user', content: { type: 'text', text } };
}

/** Default number of top matches embedded by `search_and_synthesize`. */
export const SYNTHESIZE_MAX_NOTES = 8;

/**
 * `summarize_note` - embed a note's markdown and ask for a concise summary.
 */
export function summarizeNotePrompt(snapshot: VaultSnapshot, path: string): GetPromptResult {
  const content = readNote(snapshot, path); // throws "Note not found" for an unknown path
  return {
    description: `Summarize the note ${path}`,
    messages: [
      userText(
        `Summarize the following note from my GraphVault vault. Capture the key points and ` +
          `any decisions or open questions in a few sentences, then list the most important ` +
          `takeaways as bullets.\n\n` +
          `Note path: ${path}\n\n` +
          `--- BEGIN NOTE ---\n${content}\n--- END NOTE ---`,
      ),
    ],
  };
}

/**
 * `find_connections` - embed a note plus its backlinks and local-graph
 * neighbors, and ask for related notes and missing links.
 */
export function findConnectionsPrompt(snapshot: VaultSnapshot, path: string): GetPromptResult {
  const content = readNote(snapshot, path); // throws for an unknown path
  const backlinks = backlinksFor(snapshot, path);
  const graph = graphNeighbors(snapshot, { path, depth: 1 });

  const neighborList =
    graph.nodes
      .filter((n) => n.path !== path)
      .map((n) => `- ${n.path}${n.title && n.title !== n.path ? ` (${n.title})` : ''}`)
      .join('\n') || '(none)';
  const backlinkList =
    backlinks.map((b) => `- ${b.path}${b.alias ? ` (alias: ${b.alias})` : ''}`).join('\n') ||
    '(none)';

  return {
    description: `Find connections for the note ${path}`,
    messages: [
      userText(
        `Analyze the connections of the following note in my GraphVault vault. Suggest related ` +
          `notes I should link, and identify likely MISSING links (concepts mentioned in the ` +
          `body that aren't yet linked). Be specific and reference paths where possible.\n\n` +
          `Note path: ${path}\n\n` +
          `Existing backlinks (notes linking TO this one):\n${backlinkList}\n\n` +
          `Current neighbors (within 1 hop):\n${neighborList}\n\n` +
          `--- BEGIN NOTE ---\n${content}\n--- END NOTE ---`,
      ),
    ],
  };
}

/**
 * `search_and_synthesize` - embed the top notes matching a query and ask for a
 * synthesis across them.
 */
export function searchAndSynthesizePrompt(snapshot: VaultSnapshot, query: string): GetPromptResult {
  const hits = searchNotes(snapshot, { query, limit: SYNTHESIZE_MAX_NOTES });
  if (hits.length === 0) {
    return {
      description: `Synthesize notes matching "${query}"`,
      messages: [
        userText(
          `I searched my GraphVault vault for "${query}" but found no matching notes. ` +
            `Suggest related search terms I might try, or topics I may be missing.`,
        ),
      ],
    };
  }

  const sections = hits
    .map((h) => {
      const body = readNote(snapshot, h.path);
      return `## ${h.path}${h.title && h.title !== h.path ? ` - ${h.title}` : ''}\n\n${body}`;
    })
    .join('\n\n');

  return {
    description: `Synthesize notes matching "${query}"`,
    messages: [
      userText(
        `Synthesize the following notes from my GraphVault vault, which all match the search ` +
          `query "${query}". Identify common themes, reconcile any contradictions, and produce ` +
          `a concise overview with citations to the note paths.\n\n${sections}`,
      ),
    ],
  };
}

/**
 * Prompt handlers bound to a live {@link VaultManager}. Each call refreshes the
 * snapshot (respecting the TTL) so prompts embed recent edits.
 */
export interface BoundPrompts {
  summarizeNote(path: string): Promise<GetPromptResult>;
  findConnections(path: string): Promise<GetPromptResult>;
  searchAndSynthesize(query: string): Promise<GetPromptResult>;
}

export function bindPrompts(manager: VaultManager): BoundPrompts {
  return {
    async summarizeNote(path) {
      return summarizeNotePrompt(await manager.getSnapshot(), path);
    },
    async findConnections(path) {
      return findConnectionsPrompt(await manager.getSnapshot(), path);
    },
    async searchAndSynthesize(query) {
      return searchAndSynthesizePrompt(await manager.getSnapshot(), query);
    },
  };
}
