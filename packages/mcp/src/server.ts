/**
 * MCP server wiring: registers the read-only GraphVault tools on an
 * {@link McpServer} with zod input schemas and clear descriptions.
 *
 * Tool handlers never throw out of the MCP boundary: any failure (network,
 * auth, missing note) is caught and returned as an `isError` text result so a
 * connected agent gets a clear message instead of crashing the transport.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DEFAULT_DEPTH, DEFAULT_LIMIT, MAX_DEPTH, MAX_LIMIT, type BoundTools } from './tools.js';
import { contentHashSchema } from '@graphvault/shared';
import type { BoundWriteTools } from './writes.js';
import { NOTE_MIME_TYPE, NOTE_URI_PREFIX, type BoundResources } from './resources.js';
import type { BoundPrompts } from './prompts.js';

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
 * Register the read-only tools, and - when writes are enabled - the
 * conflict-safe write tools, on `server`.
 *
 * @param server the MCP server instance.
 * @param tools  read handlers bound to a live vault manager.
 * @param writeTools write handlers; only registered when `writeTools.enabled`.
 */
export function registerTools(
  server: McpServer,
  tools: BoundTools,
  writeTools: BoundWriteTools,
): void {
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
        const stats = await tools.vaultStats();
        return jsonResult({ ...stats, writesEnabled: writeTools.enabled });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // Write tools are only registered when a device id is configured. This keeps
  // the tool surface honest: an agent connected to a read-only deployment never
  // sees create/update/append/delete in the tool picker.
  if (!writeTools.enabled) {
    return;
  }

  const writeNotePathSchema = z
    .string()
    .min(1)
    .describe('Vault-relative POSIX path of the note; must end in .md, e.g. "inbox/idea.md".');

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description:
        'Create a new Markdown note. FAILS if a non-deleted note already exists at `path` ' +
        '(never overwrites). Use update_note to change an existing note. Conflict-safe.',
      inputSchema: {
        path: writeNotePathSchema,
        content: z.string().describe('Full Markdown content of the new note.'),
      },
    },
    async (args) => {
      try {
        return jsonResult(await writeTools.createNote(args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'update_note',
    {
      title: 'Update a note',
      description:
        'Replace the content of an EXISTING note. FAILS if the note does not exist. ' +
        'Optionally pass `expectedHash` (the current `sha256:<hex>` content hash) for ' +
        'optimistic concurrency: the write is rejected if the server hash differs. ' +
        'Conflict-safe - a concurrent edit is reported, never overwritten.',
      inputSchema: {
        path: writeNotePathSchema,
        content: z.string().describe('New full Markdown content for the note.'),
        expectedHash: contentHashSchema
          .optional()
          .describe('If given, must equal the current server content hash, else the write fails.'),
      },
    },
    async (args) => {
      try {
        return jsonResult(await writeTools.updateNote(args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'append_to_note',
    {
      title: 'Append to a note',
      description:
        'Append text to an EXISTING note (read-modify-write, newline-separated). FAILS if the ' +
        'note does not exist. Conflict-safe - a concurrent edit between read and write is ' +
        'reported as a conflict, never overwritten.',
      inputSchema: {
        path: writeNotePathSchema,
        content: z.string().describe('Markdown text to append (a separating newline is added).'),
      },
    },
    async (args) => {
      try {
        return jsonResult(await writeTools.appendToNote(args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'delete_note',
    {
      title: 'Delete a note',
      description:
        'Delete (tombstone) an EXISTING note. FAILS if the note does not exist. Conflict-safe ' +
        'against concurrent edits.',
      inputSchema: { path: writeNotePathSchema },
    },
    async (args) => {
      try {
        return jsonResult(await writeTools.deleteNote(args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

/**
 * Register vault notes as MCP resources under a single `graphvault://note/{...}`
 * template. The list callback enumerates the cached vault index; the read
 * callback returns the note's markdown as `text/markdown`. Both are read-only.
 *
 * A read failure (unknown/traversal URI) is surfaced by throwing, which the SDK
 * turns into a JSON-RPC error for the host - the transport stays up.
 */
export function registerResources(server: McpServer, resources: BoundResources): void {
  const template = new ResourceTemplate(`${NOTE_URI_PREFIX}{+path}`, {
    list: async () => {
      const list = await resources.list();
      return {
        resources: list.map((r) => ({
          uri: r.uri,
          name: r.name,
          title: r.title,
          mimeType: r.mimeType,
        })),
      };
    },
  });

  server.registerResource(
    'note',
    template,
    {
      title: 'Vault note',
      description:
        'A Markdown note in the GraphVault vault, addressable as ' +
        `${NOTE_URI_PREFIX}<vault-relative-path>. Read-only.`,
      mimeType: NOTE_MIME_TYPE,
    },
    async (uri) => {
      // The read handler reuses the cached snapshot and validates the path from
      // the URI (no traversal; must be a known note, else a clear not-found).
      const contents = await resources.read(uri.href);
      return {
        contents: [{ uri: contents.uri, mimeType: contents.mimeType, text: contents.text }],
      };
    },
  );
}

/**
 * Register the ready-made prompt templates. Each pulls real vault context via
 * the bound prompt handlers and is read-only (always available).
 */
export function registerPrompts(server: McpServer, prompts: BoundPrompts): void {
  const promptPathSchema = z
    .string()
    .min(1)
    .describe('Vault-relative POSIX path of the note, e.g. "notes/ideas/graphs.md".');

  server.registerPrompt(
    'summarize_note',
    {
      title: 'Summarize a note',
      description: 'Embed a note from the vault and ask for a concise summary with key takeaways.',
      argsSchema: { path: promptPathSchema },
    },
    async ({ path }) => prompts.summarizeNote(path),
  );

  server.registerPrompt(
    'find_connections',
    {
      title: 'Find connections',
      description:
        'Embed a note plus its backlinks and 1-hop neighbors, and ask for related notes and ' +
        'likely missing links.',
      argsSchema: { path: promptPathSchema },
    },
    async ({ path }) => prompts.findConnections(path),
  );

  server.registerPrompt(
    'search_and_synthesize',
    {
      title: 'Search and synthesize',
      description:
        'Search the vault for a query, embed the top matching notes, and ask for a synthesis ' +
        'with citations to note paths.',
      argsSchema: {
        query: z.string().min(1).describe('Text to search the vault for.'),
      },
    },
    async ({ query }) => prompts.searchAndSynthesize(query),
  );
}
