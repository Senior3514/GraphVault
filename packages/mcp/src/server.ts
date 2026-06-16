/**
 * MCP server wiring: registers the read-only GraphVault tools on an
 * {@link McpServer} with zod input schemas and clear descriptions.
 *
 * Tool handlers never throw out of the MCP boundary: any failure (network,
 * auth, missing note) is caught and returned as an `isError` text result so a
 * connected agent gets a clear message instead of crashing the transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DEFAULT_DEPTH, DEFAULT_LIMIT, MAX_DEPTH, MAX_LIMIT, type BoundTools } from './tools.js';

/** A non-empty, vault-relative note path. */
const notePathSchema = z
  .string()
  .min(1)
  .describe('Vault-relative POSIX path of the note, e.g. "notes/ideas/graphs.md".');

const limitSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_LIMIT)
  .optional()
  .describe(`Maximum results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`);

/** Serialize a tool result value as a pretty-printed JSON text block. */
function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Render any thrown error as a safe, non-crashing MCP error result. */
function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/**
 * Register all six read-only tools on `server`, delegating to `tools`.
 *
 * @param server the MCP server instance.
 * @param tools  handlers bound to a live vault manager.
 */
export function registerTools(server: McpServer, tools: BoundTools): void {
  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description:
        'List notes in the vault. Optionally filter by a case-insensitive substring of the ' +
        'path or title. Returns [{ path, title, tags }]. Read-only.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring to match against note path or title.'),
        limit: limitSchema,
      },
    },
    async (args) => {
      try {
        return jsonResult(await tools.listNotes(args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'read_note',
    {
      title: 'Read a note',
      description: 'Return the raw Markdown content of a single note by its vault-relative path.',
      inputSchema: { path: notePathSchema },
    },
    async ({ path }) => {
      try {
        return { content: [{ type: 'text', text: await tools.readNote(path) }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description:
        'Search notes whose title, tags, outbound links, or body text contain the query ' +
        '(case-insensitive). Returns [{ path, title, tags, matched }] where `matched` lists ' +
        'which fields matched. Read-only.',
      inputSchema: {
        query: z.string().min(1).describe('Case-insensitive text to search for.'),
        limit: limitSchema,
      },
    },
    async (args) => {
      try {
        return jsonResult(await tools.searchNotes(args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_backlinks',
    {
      title: 'Get backlinks',
      description:
        'List notes that link to the given note (resolved backlinks). Returns ' +
        '[{ path, type, alias? }] where `path` is the linking note. Read-only.',
      inputSchema: { path: notePathSchema },
    },
    async ({ path }) => {
      try {
        return jsonResult(await tools.backlinksFor(path));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'graph_neighbors',
    {
      title: 'Graph neighbors',
      description:
        'Return the local subgraph around a note: all notes reachable within `depth` hops ' +
        '(following links and backlinks), plus the edges among them. Returns ' +
        '{ root, depth, nodes, edges, truncated }. Read-only.',
      inputSchema: {
        path: notePathSchema,
        depth: z
          .number()
          .int()
          .min(0)
          .max(MAX_DEPTH)
          .optional()
          .describe(`Traversal depth in hops (default ${DEFAULT_DEPTH}, max ${MAX_DEPTH}).`),
      },
    },
    async (args) => {
      try {
        return jsonResult(await tools.graphNeighbors(args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'vault_stats',
    {
      title: 'Vault statistics',
      description:
        'Return counts for the vault: { notes, tags, links, unresolved } where `unresolved` ' +
        'is the number of links pointing at missing notes. Read-only.',
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await tools.vaultStats());
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
