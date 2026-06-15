#!/usr/bin/env node
/**
 * graphvault CLI — entry point.
 *
 * Commands:
 *   graphvault list
 *   graphvault search <query>
 *   graphvault stats
 *   graphvault graph [--json]
 *   graphvault --help
 *   graphvault --version
 *
 * Global option: --vault <dir>  (default: cwd)
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { buildFromNotes, computeStats, graphPayload, listNotes, searchNotes } from './commands.js';
import { formatGraph, formatGraphJson, formatList, formatSearch, formatStats } from './format.js';
import { readVault } from './vault.js';

const VERSION = '0.0.0';

const HELP = `
graphvault — GraphVault CLI (v${VERSION})

Usage:
  graphvault <command> [options]

Commands:
  list                  List all notes (path + title)
  search <query>        Search notes by title or content
  stats                 Show vault statistics
  graph [--json]        Print the link graph; --json for machine-readable output

Options:
  --vault <dir>         Vault directory (default: current directory)
  --version             Print version
  --help                Show this help message

Examples:
  graphvault list --vault ~/notes
  graphvault search "graph engine" --vault ~/notes
  graphvault stats --vault ~/notes
  graphvault graph --json --vault ~/notes
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
      json: { type: 'boolean', default: false },
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
