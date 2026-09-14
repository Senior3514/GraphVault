#!/usr/bin/env node
/**
 * graphvault CLI - entry point.
 *
 * Commands:
 *   graphvault list
 *   graphvault search <query>
 *   graphvault stats
 *   graphvault graph [--json]
 *   graphvault codegraph [--json] [--dependencies <path>] [--dependents <path>]
 *   graphvault serve [--host <h>] [--port <n>]
 *   graphvault --help
 *   graphvault --version
 *
 * Global option: --vault <dir>  (default: cwd) - also used by `codegraph` as
 * the source directory to scan (it's not a Markdown vault there, but the same
 * "root directory" semantics apply).
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { buildCodeGraph, findDependencies, findDependents } from '@graphvault/engine';
import { buildFromNotes, computeStats, graphPayload, listNotes, searchNotes } from './commands.js';
import {
  formatCodeGraph,
  formatCodeGraphJson,
  formatFileRelations,
  formatGraph,
  formatGraphJson,
  formatList,
  formatSearch,
  formatStats,
} from './format.js';
import { readVault } from './vault.js';
import { walkSourceFiles } from './codeGraph.js';
import { DEFAULT_HOST, DEFAULT_PORT, serveCommand } from './server.js';

const VERSION = '0.1.0';

const HELP = `
graphvault - GraphVault CLI (v${VERSION})

Usage:
  graphvault <command> [options]

Commands:
  list                  List all notes (path + title)
  search <query>        Search notes by title or content
  stats                 Show vault statistics
  graph [--json]        Print the link graph; --json for machine-readable output
  codegraph [--json]    Scan a source tree and print its import graph (file -> file),
    [--dependencies <path>]  so an AI coding agent (or you) can see what a file
    [--dependents <path>]   depends on / what depends on it without reading every
                            file first. Not Markdown-specific - scans .ts/.tsx/.js/
                            .jsx/.mjs/.cjs under --vault (used here as "root dir").
  serve [--host h]      Start a local, READ-ONLY HTTP API over the vault
        [--port n]      (default: http://${DEFAULT_HOST}:${DEFAULT_PORT}, loopback only)

Options:
  --vault <dir>         Vault / source directory (default: current directory)
  --host <host>         serve: bind host (default: ${DEFAULT_HOST}; loopback only)
  --port <port>         serve: bind port (default: ${DEFAULT_PORT})
  --version             Print version
  --help                Show this help message

Examples:
  graphvault list --vault ~/notes
  graphvault search "graph engine" --vault ~/notes
  graphvault stats --vault ~/notes
  graphvault graph --json --vault ~/notes
  graphvault codegraph --vault ~/code/my-project
  graphvault codegraph --json --vault . > codegraph.json
  graphvault codegraph --dependents src/index.ts --vault .
  graphvault serve --vault ~/notes --port 4111

Note: "serve" exposes a READ-ONLY (GET-only) HTTP API and binds to
${DEFAULT_HOST} (localhost) by default. Binding to a non-loopback --host
exposes your vault to the network with no authentication - opt-in only.
`.trim();

function die(msg: string): never {
  process.stderr.write(`graphvault: ${msg}\n`);
  process.exit(1);
}

function main(): void {
  // Parse top-level flags; positional args become the sub-command + its args.
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      vault: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      json: { type: 'boolean', default: false },
      dependencies: { type: 'string' },
      dependents: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: true,
    strict: false, // allow unknown flags from sub-commands without throwing
  });

  if (values.version) {
    process.stdout.write(`graphvault v${VERSION}\n`);
    return;
  }

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP + '\n');
    return;
  }

  const cmd = positionals[0];
  const vaultDir = resolve(typeof values.vault === 'string' ? values.vault : process.cwd());

  // `serve` loads the vault itself and runs until interrupted; handle it before
  // the shared one-shot vault read below.
  if (cmd === 'serve') {
    const host = typeof values.host === 'string' ? values.host : undefined;
    let port: number | undefined;
    if (typeof values.port === 'string') {
      port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        die(`Invalid --port "${values.port}" (expected an integer 0-65535)`);
      }
    }
    try {
      serveCommand(vaultDir, { host, port });
    } catch (err) {
      die(`Cannot start server: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // `codegraph` scans a source tree, not a Markdown vault - handle it before
  // the shared readVault() below, which would either find nothing or waste
  // work walking the same directory a second time for the wrong file type.
  if (cmd === 'codegraph') {
    let files;
    try {
      files = walkSourceFiles(vaultDir);
    } catch (err) {
      die(
        `Cannot read directory "${vaultDir}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const graph = buildCodeGraph(files);

    if (typeof values.dependencies === 'string') {
      process.stdout.write(
        formatFileRelations(
          values.dependencies,
          'dependencies',
          findDependencies(graph, values.dependencies),
        ) + '\n',
      );
    } else if (typeof values.dependents === 'string') {
      process.stdout.write(
        formatFileRelations(
          values.dependents,
          'dependents',
          findDependents(graph, values.dependents),
        ) + '\n',
      );
    } else {
      process.stdout.write(
        (values.json ? formatCodeGraphJson(graph) : formatCodeGraph(graph)) + '\n',
      );
    }
    return;
  }

  // Load vault notes (shared across all commands).
  let notes;
  try {
    notes = readVault(vaultDir);
  } catch (err) {
    die(`Cannot read vault at "${vaultDir}": ${err instanceof Error ? err.message : String(err)}`);
  }

  const index = buildFromNotes(notes);

  switch (cmd) {
    case 'list': {
      const entries = listNotes(index);
      process.stdout.write(formatList(entries) + '\n');
      break;
    }

    case 'search': {
      const query = positionals.slice(1).join(' ').trim();
      if (query === '') die('search requires a query argument');
      const results = searchNotes(index, notes, query);
      process.stdout.write(formatSearch(results, query) + '\n');
      break;
    }

    case 'stats': {
      const stats = computeStats(index);
      process.stdout.write(formatStats(stats) + '\n');
      break;
    }

    case 'graph': {
      const asJson = values.json === true;
      const result = graphPayload(index, false);
      process.stdout.write((asJson ? formatGraphJson(result) : formatGraph(result)) + '\n');
      break;
    }

    default:
      die(`Unknown command "${cmd}". Run "graphvault --help" for usage.`);
  }
}

main();
