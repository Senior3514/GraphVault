/**
 * Pure, IO-free MCP request handlers.
 *
 * Every exported function takes a pre-built VaultContext (or plain data)
 * and returns a serialisable result object. No stdio, no fs here — all that
 * lives in index.ts so this module is unit-testable with node:test.
 */

import type { GraphIndex, NoteInput } from '@graphvault/engine';
import { buildIndex, getBacklinks, getLocalGraph, getOutbound } from '@graphvault/engine';
import type {
  InitializeParams,
  InitializeResult,
  ResourceDef,
  ResourceReadResult,
  ToolCallParams,
  ToolCallResult,
  ToolDef,
  ToolsListResult,
} from './types.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = '@graphvault/mcp';
const SERVER_VERSION = '0.0.0';

// ---------------------------------------------------------------------------
// Vault context
// ---------------------------------------------------------------------------

/** Pre-built context passed to all tool/resource handlers. */
export interface VaultContext {
  notes: NoteInput[];
  index: GraphIndex;
}

/** Build a VaultContext from raw NoteInput values. */
export function buildContext(notes: NoteInput[]): VaultContext {
  return { notes, index: buildIndex(notes) };
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export function handleInitialize(_params: InitializeParams): InitializeResult {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    capabilities: {
      tools: {},
      resources: {},
    },
  };
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'list_notes',
    description: 'List all notes in the vault. Returns an array of {path, title, tags} objects.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'search_notes',
    description:
      'Search notes by a case-insensitive substring match on title or content. ' +
      'Returns an array of {path, title, context} objects.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The substring to search for.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_note',
    description:
      'Retrieve the full content of a single note by its vault-relative path (e.g. "ideas/graph.md").',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Vault-relative POSIX path of the note.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'graph_neighbors',
    description:
      'Return the immediate graph neighbors (outbound links + backlinks) for a note. ' +
      'Returns {outbound: [...], backlinks: [...]} with resolved note ids.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Vault-relative POSIX path of the note.',
        },
        depth: {
          type: 'number',
          description: 'BFS depth to traverse (default 1, max 3).',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_stats',
    description:
      'Return vault statistics: note count, link counts, tag count, top tags, and orphan notes.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export function handleToolsList(): ToolsListResult {
  return { tools: TOOL_DEFS };
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

/** Call a tool by name with the given arguments and vault context. */
export function handleToolCall(params: ToolCallParams, ctx: VaultContext): ToolCallResult {
  try {
    const result = dispatchTool(params, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

function dispatchTool(params: ToolCallParams, ctx: VaultContext): unknown {
  const args = params.arguments ?? {};

  switch (params.name) {
    case 'list_notes':
      return toolListNotes(ctx);

    case 'search_notes': {
      const query = args['query'];
      if (typeof query !== 'string' || query.trim() === '') {
        throw new Error('search_notes requires a non-empty "query" argument');
      }
      return toolSearchNotes(ctx, query.trim());
    }

    case 'get_note': {
      const path = args['path'];
      if (typeof path !== 'string' || path.trim() === '') {
        throw new Error('get_note requires a non-empty "path" argument');
      }
      return toolGetNote(ctx, path.trim());
    }

    case 'graph_neighbors': {
      const path = args['path'];
      if (typeof path !== 'string' || path.trim() === '') {
        throw new Error('graph_neighbors requires a non-empty "path" argument');
      }
      const rawDepth = args['depth'];
      const depth =
        typeof rawDepth === 'number' ? Math.min(3, Math.max(1, Math.floor(rawDepth))) : 1;
      return toolGraphNeighbors(ctx, path.trim(), depth);
    }

    case 'get_stats':
      return toolGetStats(ctx);

    default:
      throw new Error(`Unknown tool: ${params.name}`);
  }
}

// ---------------------------------------------------------------------------
// Individual tool implementations
// ---------------------------------------------------------------------------

function toolListNotes(ctx: VaultContext): Array<{ path: string; title: string; tags: string[] }> {
  return [...ctx.index.nodes.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((n) => ({ path: n.path, title: n.title, tags: n.tags }));
}

interface SearchHit {
  path: string;
  title: string;
  context?: string;
}

function toolSearchNotes(ctx: VaultContext, query: string): SearchHit[] {
  const q = query.toLowerCase();
  const results: SearchHit[] = [];

  for (const note of ctx.notes) {
    const node = ctx.index.nodes.get(note.path);
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
      context = (start > 0 ? '...' : '') + snippet + (end < note.content.length ? '...' : '');
    }
    results.push({ path: note.path, title: node.title, context });
  }

  return results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

interface GetNoteResult {
  path: string;
  title: string;
  tags: string[];
  content: string;
  createdAt?: number;
  updatedAt?: number;
}

function toolGetNote(ctx: VaultContext, path: string): GetNoteResult {
  const node = ctx.index.nodes.get(path);
  if (!node) {
    throw new Error(`Note not found: ${path}`);
  }
  const note = ctx.notes.find((n) => n.path === path);
  if (!note) {
    throw new Error(`Note content not found: ${path}`);
  }
  const result: GetNoteResult = {
    path: node.path,
    title: node.title,
    tags: node.tags,
    content: note.content,
  };
  if (node.createdAt !== undefined) result.createdAt = node.createdAt;
  if (node.updatedAt !== undefined) result.updatedAt = node.updatedAt;
  return result;
}

interface NeighborEdge {
  source: string;
  target: string;
  type: string;
  resolved: boolean;
}

interface GraphNeighborsResult {
  noteId: string;
  depth: number;
  outbound: NeighborEdge[];
  backlinks: NeighborEdge[];
  subgraph: {
    nodes: Array<{ id: string; title: string; tags: string[] }>;
    edges: NeighborEdge[];
  };
}

function toolGraphNeighbors(ctx: VaultContext, path: string, depth: number): GraphNeighborsResult {
  if (!ctx.index.nodes.has(path)) {
    throw new Error(`Note not found: ${path}`);
  }

  const outboundEdges = getOutbound(ctx.index, path).map((e) => ({
    source: e.source,
    target: e.target,
    type: e.type,
    resolved: e.resolved,
  }));

  const backlinkEdges = getBacklinks(ctx.index, path).map((e) => ({
    source: e.source,
    target: e.target,
    type: e.type,
    resolved: e.resolved,
  }));

  const subgraph = getLocalGraph(ctx.index, path, depth);
  return {
    noteId: path,
    depth,
    outbound: outboundEdges,
    backlinks: backlinkEdges,
    subgraph: {
      nodes: subgraph.nodes.map((n) => ({ id: n.id, title: n.title, tags: n.tags })),
      edges: subgraph.edges.map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type,
        resolved: e.resolved,
      })),
    },
  };
}

interface StatsResult {
  noteCount: number;
  linkCount: number;
  resolvedLinkCount: number;
  tagCount: number;
  topTags: Array<{ tag: string; count: number }>;
  orphanNotes: string[];
}

function toolGetStats(ctx: VaultContext): StatsResult {
  const noteCount = ctx.index.nodes.size;
  const linkCount = ctx.index.edges.length;
  const resolvedLinkCount = ctx.index.edges.filter((e) => e.resolved).length;

  const tagFrequency = new Map<string, number>();
  for (const node of ctx.index.nodes.values()) {
    for (const tag of node.tags) {
      tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
    }
  }
  const tagCount = tagFrequency.size;

  const topTags = [...tagFrequency.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  const hasInbound = new Set<string>();
  for (const edge of ctx.index.edges) {
    if (edge.resolved) hasInbound.add(edge.target);
  }
  const orphanNotes = [...ctx.index.nodes.keys()].filter((id) => !hasInbound.has(id)).sort();

  return { noteCount, linkCount, resolvedLinkCount, tagCount, topTags, orphanNotes };
}

// ---------------------------------------------------------------------------
// resources/list + resources/read
// ---------------------------------------------------------------------------

/** Build resource descriptors for all notes in the vault. */
export function handleResourcesList(ctx: VaultContext): { resources: ResourceDef[] } {
  const resources: ResourceDef[] = [...ctx.index.nodes.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((node) => ({
      uri: `graphvault://note/${node.path}`,
      name: node.title,
      description: `Note: ${node.path}`,
      mimeType: 'text/markdown',
    }));
  return { resources };
}

const NOTE_URI_PREFIX = 'graphvault://note/';

export function handleResourceRead(params: { uri: string }, ctx: VaultContext): ResourceReadResult {
  const { uri } = params;
  if (!uri.startsWith(NOTE_URI_PREFIX)) {
    throw new Error(`Unsupported resource URI scheme: ${uri}`);
  }
  const notePath = uri.slice(NOTE_URI_PREFIX.length);
  const note = ctx.notes.find((n) => n.path === notePath);
  if (!note) {
    throw new Error(`Resource not found: ${uri}`);
  }
  return {
    contents: [
      {
        uri,
        mimeType: 'text/markdown',
        text: note.content,
      },
    ],
  };
}
