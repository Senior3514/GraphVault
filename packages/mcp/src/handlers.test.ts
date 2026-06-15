/**
 * Unit tests for the MCP handlers and transport framing.
 *
 * Run via: node --test dist/handlers.test.js
 * (tsc compiles this file as part of the package build.)
 *
 * No real subprocess or filesystem access — notes are supplied inline.
 * The transport is tested by feeding framed JSON-RPC strings through
 * runMessages() which drives serveStdio() end-to-end without spawning a
 * child process.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteInput } from '@graphvault/engine';
import {
  buildContext,
  handleInitialize,
  handleResourceRead,
  handleResourcesList,
  handleToolCall,
  handleToolsList,
  MCP_PROTOCOL_VERSION,
  TOOL_DEFS,
} from './handlers.js';
import { runMessages } from './transport.js';
import type { JsonRpcRequest } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOTES: NoteInput[] = [
  {
    path: 'alpha.md',
    content: `---
title: Alpha Note
tags: [engine, graph]
---
# Alpha Note

This is about the graph engine. See [[beta]].
`,
    updatedAt: 1_700_000_000_000,
    createdAt: 1_699_000_000_000,
  },
  {
    path: 'beta.md',
    content: `---
title: Beta Note
tags: [engine]
---
# Beta Note

References [[alpha]] and is part of the engine.
`,
    updatedAt: 1_700_100_000_000,
  },
  {
    path: 'orphan.md',
    content: `# Orphan

Nobody links here. #solo
`,
  },
];

const CTX = buildContext(NOTES);

// ---------------------------------------------------------------------------
// handleInitialize
// ---------------------------------------------------------------------------

describe('handleInitialize', () => {
  it('returns the correct protocol version and server info', () => {
    const result = handleInitialize({});
    assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(result.serverInfo.name, '@graphvault/mcp');
    assert.ok(typeof result.serverInfo.version === 'string');
    assert.ok('tools' in result.capabilities);
    assert.ok('resources' in result.capabilities);
  });
});

// ---------------------------------------------------------------------------
// handleToolsList
// ---------------------------------------------------------------------------

describe('handleToolsList', () => {
  it('returns all expected tool definitions', () => {
    const { tools } = handleToolsList();
    assert.equal(tools.length, TOOL_DEFS.length);
    const names = new Set(tools.map((t) => t.name));
    assert.ok(names.has('list_notes'));
    assert.ok(names.has('search_notes'));
    assert.ok(names.has('get_note'));
    assert.ok(names.has('graph_neighbors'));
    assert.ok(names.has('get_stats'));
  });

  it('each tool has a name, description, and inputSchema', () => {
    const { tools } = handleToolsList();
    for (const tool of tools) {
      assert.ok(typeof tool.name === 'string' && tool.name.length > 0);
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0);
      assert.ok(tool.inputSchema.type === 'object');
    }
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — list_notes
// ---------------------------------------------------------------------------

describe('handleToolCall list_notes', () => {
  it('returns one entry per note sorted by path', () => {
    const result = handleToolCall({ name: 'list_notes' }, CTX);
    assert.equal(result.isError, undefined);
    const notes = JSON.parse(result.content[0]!.text) as Array<{
      path: string;
      title: string;
      tags: string[];
    }>;
    assert.equal(notes.length, 3);
    assert.equal(notes[0]!.path, 'alpha.md');
    assert.equal(notes[0]!.title, 'Alpha Note');
    assert.deepEqual(notes[0]!.tags, ['engine', 'graph']);
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — search_notes
// ---------------------------------------------------------------------------

describe('handleToolCall search_notes', () => {
  it('finds notes by title substring', () => {
    const result = handleToolCall({ name: 'search_notes', arguments: { query: 'alpha' } }, CTX);
    assert.equal(result.isError, undefined);
    const hits = JSON.parse(result.content[0]!.text) as Array<{ path: string }>;
    assert.ok(hits.some((h) => h.path === 'alpha.md'));
  });

  it('finds notes by content substring and includes context', () => {
    const result = handleToolCall(
      { name: 'search_notes', arguments: { query: 'graph engine' } },
      CTX,
    );
    const hits = JSON.parse(result.content[0]!.text) as Array<{
      path: string;
      context?: string;
    }>;
    const hit = hits.find((h) => h.path === 'alpha.md');
    assert.ok(hit !== undefined);
    assert.ok(typeof hit.context === 'string');
    assert.ok(hit.context.toLowerCase().includes('graph engine'));
  });

  it('returns empty array when nothing matches', () => {
    const result = handleToolCall(
      { name: 'search_notes', arguments: { query: 'xyznotfound' } },
      CTX,
    );
    const hits = JSON.parse(result.content[0]!.text) as unknown[];
    assert.equal(hits.length, 0);
  });

  it('returns an error when query is missing', () => {
    const result = handleToolCall({ name: 'search_notes', arguments: {} }, CTX);
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — get_note
// ---------------------------------------------------------------------------

describe('handleToolCall get_note', () => {
  it('returns full note content', () => {
    const result = handleToolCall({ name: 'get_note', arguments: { path: 'alpha.md' } }, CTX);
    assert.equal(result.isError, undefined);
    const note = JSON.parse(result.content[0]!.text) as {
      path: string;
      title: string;
      content: string;
    };
    assert.equal(note.path, 'alpha.md');
    assert.equal(note.title, 'Alpha Note');
    assert.ok(note.content.includes('graph engine'));
  });

  it('returns error for unknown path', () => {
    const result = handleToolCall({ name: 'get_note', arguments: { path: 'nonexistent.md' } }, CTX);
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — graph_neighbors
// ---------------------------------------------------------------------------

describe('handleToolCall graph_neighbors', () => {
  it('returns outbound and backlink edges', () => {
    const result = handleToolCall(
      { name: 'graph_neighbors', arguments: { path: 'alpha.md' } },
      CTX,
    );
    assert.equal(result.isError, undefined);
    const data = JSON.parse(result.content[0]!.text) as {
      outbound: Array<{ target: string }>;
      backlinks: Array<{ source: string }>;
      subgraph: { nodes: unknown[]; edges: unknown[] };
    };
    assert.ok(data.outbound.some((e) => e.target === 'beta.md'));
    assert.ok(data.backlinks.some((e) => e.source === 'beta.md'));
    assert.ok(data.subgraph.nodes.length >= 2);
  });

  it('returns error for unknown path', () => {
    const result = handleToolCall(
      { name: 'graph_neighbors', arguments: { path: 'missing.md' } },
      CTX,
    );
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — get_stats
// ---------------------------------------------------------------------------

describe('handleToolCall get_stats', () => {
  it('returns correct note count', () => {
    const result = handleToolCall({ name: 'get_stats' }, CTX);
    assert.equal(result.isError, undefined);
    const stats = JSON.parse(result.content[0]!.text) as {
      noteCount: number;
      orphanNotes: string[];
    };
    assert.equal(stats.noteCount, 3);
    assert.ok(stats.orphanNotes.includes('orphan.md'));
  });
});

// ---------------------------------------------------------------------------
// handleToolCall — unknown tool
// ---------------------------------------------------------------------------

describe('handleToolCall unknown tool', () => {
  it('returns isError for unknown tool name', () => {
    const result = handleToolCall({ name: 'nonexistent_tool' }, CTX);
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// handleResourcesList + handleResourceRead
// ---------------------------------------------------------------------------

describe('handleResourcesList', () => {
  it('returns one resource per note with graphvault:// URIs', () => {
    const { resources } = handleResourcesList(CTX);
    assert.equal(resources.length, 3);
    assert.ok(resources.every((r) => r.uri.startsWith('graphvault://note/')));
    assert.ok(resources.every((r) => r.mimeType === 'text/markdown'));
  });
});

describe('handleResourceRead', () => {
  it('returns note content for a valid URI', () => {
    const result = handleResourceRead({ uri: 'graphvault://note/alpha.md' }, CTX);
    assert.equal(result.contents.length, 1);
    assert.equal(result.contents[0]!.mimeType, 'text/markdown');
    assert.ok(result.contents[0]!.text?.includes('graph engine'));
  });

  it('throws for unknown URI', () => {
    assert.throws(() => handleResourceRead({ uri: 'graphvault://note/missing.md' }, CTX));
  });

  it('throws for unsupported URI scheme', () => {
    assert.throws(() => handleResourceRead({ uri: 'file:///etc/passwd' }, CTX));
  });
});

// ---------------------------------------------------------------------------
// Transport — end-to-end through runMessages()
// ---------------------------------------------------------------------------

describe('transport: runMessages end-to-end', () => {
  it('handles initialize → tools/list → tools/call sequence', async () => {
    // Build a minimal dispatcher that mimics index.ts.
    function dispatch(req: JsonRpcRequest) {
      if (req.id === undefined || req.id === null) return null;
      const id = req.id;
      try {
        let result: unknown;
        switch (req.method) {
          case 'initialize':
            result = handleInitialize({});
            break;
          case 'tools/list':
            result = handleToolsList();
            break;
          case 'tools/call':
            result = handleToolCall(req.params as { name: string }, CTX);
            break;
          default:
            return {
              jsonrpc: '2.0' as const,
              id,
              error: { code: -32601, message: 'Method not found' },
            };
        }
        return { jsonrpc: '2.0' as const, id, result };
      } catch (err) {
        return {
          jsonrpc: '2.0' as const,
          id,
          error: { code: -32603, message: String(err) },
        };
      }
    }

    const requests: JsonRpcRequest[] = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_notes' },
      },
    ];

    const responses = await runMessages(requests, dispatch);
    assert.equal(responses.length, 3);

    // Response 1: initialize
    const init = responses[0]!;
    assert.equal(init.id, 1);
    assert.ok(init.result !== undefined);
    assert.equal(
      (init.result as { protocolVersion: string }).protocolVersion,
      MCP_PROTOCOL_VERSION,
    );

    // Response 2: tools/list
    const toolsList = responses[1]!;
    assert.equal(toolsList.id, 2);
    const tools = (toolsList.result as { tools: Array<{ name: string }> }).tools;
    assert.ok(tools.some((t) => t.name === 'list_notes'));

    // Response 3: tools/call list_notes
    const callResult = responses[2]!;
    assert.equal(callResult.id, 3);
    const content = (callResult.result as { content: Array<{ type: string; text: string }> })
      .content;
    assert.equal(content[0]!.type, 'text');
    const notes = JSON.parse(content[0]!.text) as Array<{ path: string }>;
    assert.equal(notes.length, 3);
  });

  it('returns method-not-found for an unknown method', async () => {
    function dispatch(req: JsonRpcRequest) {
      if (!req.id) return null;
      return {
        jsonrpc: '2.0' as const,
        id: req.id,
        error: { code: -32601, message: 'Method not found' },
      };
    }

    const responses = await runMessages(
      [{ jsonrpc: '2.0', id: 99, method: 'unknown/method' }],
      dispatch,
    );
    assert.equal(responses.length, 1);
    assert.equal(responses[0]!.error?.code, -32601);
  });

  it('handles notification messages (no id) without response', async () => {
    function dispatch(req: JsonRpcRequest) {
      if (req.id === undefined || req.id === null) return null;
      return { jsonrpc: '2.0' as const, id: req.id, result: {} };
    }

    // Send one notification (no id) and one request (id: 1).
    const responses = await runMessages(
      [
        { jsonrpc: '2.0', id: null, method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 1, method: 'ping' },
      ],
      dispatch,
    );
    // Only the request (id:1) should get a response.
    assert.equal(responses.length, 1);
    assert.equal(responses[0]!.id, 1);
  });
});
