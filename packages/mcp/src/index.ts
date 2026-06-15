#!/usr/bin/env node
/**
 * graphvault-mcp — GraphVault MCP server entry point.
 *
 * Exposes a vault directory as an MCP (Model Context Protocol) server over
 * stdio using Content-Length-framed JSON-RPC 2.0. Compatible with Claude
 * Desktop and any MCP client.
 *
 * Usage:
 *   graphvault-mcp --vault <dir>
 *   GRAPHVAULT_VAULT=~/notes graphvault-mcp
 *
 * Tools exposed:
 *   list_notes        — list all notes
 *   search_notes      — full-text search
 *   get_note          — retrieve a note by path
 *   graph_neighbors   — BFS neighbors + backlinks for a note
 *   get_stats         — vault statistics
 *
 * Resources exposed:
 *   graphvault://note/<vault-relative-path>  (one per note)
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import {
  buildContext,
  handleInitialize,
  handleResourceRead,
  handleResourcesList,
  handleToolCall,
  handleToolsList,
  MCP_PROTOCOL_VERSION,
} from './handlers.js';
import { serveStdio, writeMessage } from './transport.js';
import { readVault } from './vault.js';
import type {
  InitializeParams,
  JsonRpcRequest,
  JsonRpcResponse,
  ResourceReadParams,
  ToolCallParams,
} from './types.js';
import { INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND, PARSE_ERROR } from './types.js';

function die(msg: string): never {
  process.stderr.write(`graphvault-mcp: ${msg}\n`);
  process.exit(1);
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      vault: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    strict: false,
  });

  if (values.version) {
    process.stdout.write('graphvault-mcp v0.0.0\n');
    return;
  }

  if (values.help) {
    process.stdout.write(
      [
        'graphvault-mcp — GraphVault MCP server',
        '',
        'Usage:',
        '  graphvault-mcp --vault <dir>',
        '  GRAPHVAULT_VAULT=<dir> graphvault-mcp',
        '',
        'Options:',
        '  --vault <dir>   Vault directory (overrides $GRAPHVAULT_VAULT)',
        '  --version       Print version',
        '  --help          Show this help',
      ].join('\n') + '\n',
    );
    return;
  }

  const vaultArg =
    typeof values.vault === 'string' ? values.vault : process.env['GRAPHVAULT_VAULT'];
  if (!vaultArg) {
    die('No vault directory specified. Use --vault <dir> or set $GRAPHVAULT_VAULT.');
  }
  const vaultDir = resolve(vaultArg);

  // Load vault once at startup. (Vault is read eagerly; not re-read on change.)
  let notes;
  try {
    notes = readVault(vaultDir);
  } catch (err) {
    die(`Cannot read vault at "${vaultDir}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const ctx = buildContext(notes);

  process.stderr.write(
    `graphvault-mcp: loaded ${notes.length} notes from ${vaultDir}\n` +
      `graphvault-mcp: MCP protocol ${MCP_PROTOCOL_VERSION} — listening on stdio\n`,
  );

  // ---------------------------------------------------------------------------
  // JSON-RPC dispatcher
  // ---------------------------------------------------------------------------
  function dispatch(req: JsonRpcRequest): JsonRpcResponse | null {
    const id = req.id ?? null;

    // Notifications (id === undefined/null) get no response, but we still
    // process "initialized" etc. for completeness.
    const isNotification = req.id === undefined || req.id === null;

    try {
      let result: unknown;

      switch (req.method) {
        case 'initialize':
          result = handleInitialize((req.params ?? {}) as InitializeParams);
          break;

        case 'initialized':
          // Client notification — no response needed.
          return null;

        case 'tools/list':
          result = handleToolsList();
          break;

        case 'tools/call': {
          if (!req.params || typeof req.params !== 'object') {
            return errorResp(id, INVALID_PARAMS, 'tools/call requires params');
          }
          result = handleToolCall(req.params as ToolCallParams, ctx);
          break;
        }

        case 'resources/list':
          result = handleResourcesList(ctx);
          break;

        case 'resources/read': {
          if (!req.params || typeof req.params !== 'object') {
            return errorResp(id, INVALID_PARAMS, 'resources/read requires params');
          }
          result = handleResourceRead(req.params as ResourceReadParams, ctx);
          break;
        }

        case 'ping':
          result = {};
          break;

        default:
          if (isNotification) return null;
          return errorResp(id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);
      }

      if (isNotification) return null;
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (isNotification) return null;
      const message = err instanceof Error ? err.message : String(err);
      return errorResp(id, INTERNAL_ERROR, message);
    }
  }

  function errorResp(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  // Suppress unused-import warning; PARSE_ERROR is referenced from types but
  // the transport handles raw parse errors itself.
  void PARSE_ERROR;

  serveStdio(process.stdin, process.stdout, dispatch).catch((err) => {
    process.stderr.write(`graphvault-mcp: fatal: ${String(err)}\n`);
    process.exit(1);
  });
}

main();
