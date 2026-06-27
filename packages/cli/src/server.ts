/**
 * Local read-only HTTP API for a GraphVault vault.
 *
 * `graphvault serve` exposes the same read operations the CLI prints
 * (list / search / stats / graph / backlinks / a single note) over HTTP so
 * local scripts and integrations can query the vault programmatically.
 *
 * SECURITY / local-first defaults:
 *   - Binds to 127.0.0.1 by default (loopback only). Binding to a non-loopback
 *     host (e.g. 0.0.0.0) exposes the vault to the network and is strictly
 *     opt-in via `--host`.
 *   - READ-ONLY: only GET is accepted; every other method returns 405.
 *   - No authentication (it is a localhost dev API). Do NOT expose it to an
 *     untrusted network.
 *   - No CORS header is set by default (same-origin / local scripts).
 *
 * Built on `node:http` only - zero runtime dependencies beyond the engine.
 */

import http from 'node:http';
import { URL } from 'node:url';
import type { GraphIndex, NoteInput } from '@graphvault/engine';
import { getBacklinks } from '@graphvault/engine';
import { buildFromNotes, computeStats, graphPayload, searchNotes } from './commands.js';
import { readVault } from './vault.js';

/** Options for the API server. */
export interface ServeOptions {
  /** Host/interface to bind. Defaults to `127.0.0.1` (loopback only). */
  host?: string;
  /** TCP port. Defaults to `4111`. Use `0` for an ephemeral port (tests). */
  port?: number;
}

/** Default loopback host - never expose the vault by default. */
export const DEFAULT_HOST = '127.0.0.1';
/** Default port. */
export const DEFAULT_PORT = 4111;

/** A small JSON error envelope, mirroring the rest of the project. */
interface ApiError {
  error: { code: string; message: string };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function errorBody(code: string, message: string): ApiError {
  return { error: { code, message } };
}

/**
 * Normalize a vault-relative path coming from a request into the exact POSIX
 * form the engine uses as a note id, or return `null` if it is unsafe
 * (absolute, contains `..` traversal, or escapes the vault root).
 */
export function normalizeVaultPath(raw: string): string | null {
  if (raw === '') return null;
  // Decoded already by URLSearchParams / pathname parsing; reject control chars
  // and backslashes (the engine only ever uses forward slashes).
  if (raw.includes('\0') || raw.includes('\\')) return null;

  const segments = raw.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue; // collapse empty / current-dir
    if (seg === '..') return null; // traversal - reject outright
    out.push(seg);
  }
  if (out.length === 0) return null;
  return out.join('/');
}

/** Find a note by its (normalized) vault-relative path. */
function findNote(notes: NoteInput[], path: string): NoteInput | undefined {
  return notes.find((n) => n.path === path);
}

/**
 * Create a read-only HTTP API server over an already-loaded vault.
 *
 * Pure-ish: it does no filesystem or network IO itself until you call
 * `.listen()`. This lets tests start it on an ephemeral port (port 0).
 */
export function createVaultApiServer(notes: NoteInput[], index: GraphIndex): http.Server {
  return http.createServer((req, res) => {
    // Read-only: reject anything that is not a GET (or HEAD treated as GET).
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', `Method ${method} not allowed`));
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendJson(res, 400, errorBody('BAD_REQUEST', 'Malformed request URL'));
      return;
    }

    const pathname = decodeURIComponent(url.pathname);

    try {
      // GET /health
      if (pathname === '/health') {
        sendJson(res, 200, { status: 'ok', notes: index.nodes.size });
        return;
      }

      // GET /notes  → list of {path, title, tags}
      if (pathname === '/notes') {
        const entries = [...index.nodes.values()]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((n) => ({ path: n.path, title: n.title, tags: n.tags }));
        sendJson(res, 200, { notes: entries });
        return;
      }

      // GET /notes/<vault-relative-path>  → {path, title, content}
      if (pathname.startsWith('/notes/')) {
        const raw = pathname.slice('/notes/'.length);
        sendNote(res, notes, index, raw);
        return;
      }

      // GET /note?path=...  → {path, title, content}
      if (pathname === '/note') {
        const raw = url.searchParams.get('path') ?? '';
        sendNote(res, notes, index, raw);
        return;
      }

      // GET /search?q=...&limit=...
      if (pathname === '/search') {
        const q = (url.searchParams.get('q') ?? '').trim();
        if (q === '') {
          sendJson(res, 400, errorBody('BAD_REQUEST', 'Missing required query parameter "q"'));
          return;
        }
        const results = searchNotes(index, notes, q);
        const limitRaw = url.searchParams.get('limit');
        let limited = results;
        if (limitRaw !== null) {
          const n = Number(limitRaw);
          if (!Number.isFinite(n) || n < 0) {
            sendJson(
              res,
              400,
              errorBody('BAD_REQUEST', 'Query parameter "limit" must be a non-negative number'),
            );
            return;
          }
          // Clamp to a sane maximum so a single request can't ask for an
          // unbounded slice (mirrors the 500-result cap the MCP tools enforce).
          const limit = Math.min(Math.floor(n), 500);
          limited = results.slice(0, limit);
        }
        sendJson(res, 200, { query: q, results: limited });
        return;
      }

      // GET /graph
      if (pathname === '/graph') {
        const includeUnresolved = url.searchParams.get('unresolved') === 'true';
        sendJson(res, 200, graphPayload(index, includeUnresolved));
        return;
      }

      // GET /backlinks?path=...
      if (pathname === '/backlinks') {
        const raw = url.searchParams.get('path') ?? '';
        const path = normalizeVaultPath(raw);
        if (path === null) {
          sendJson(res, 400, errorBody('BAD_REQUEST', 'Invalid or missing "path"'));
          return;
        }
        if (!index.nodes.has(path)) {
          sendJson(res, 404, errorBody('NOT_FOUND', `No note at "${path}"`));
          return;
        }
        const edges = getBacklinks(index, path).map((e) => ({
          source: e.source,
          target: e.target,
          type: e.type,
          resolved: e.resolved,
        }));
        sendJson(res, 200, { path, backlinks: edges });
        return;
      }

      // GET /stats
      if (pathname === '/stats') {
        sendJson(res, 200, computeStats(index));
        return;
      }

      // Unknown route.
      sendJson(res, 404, errorBody('NOT_FOUND', `No route for ${pathname}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, errorBody('INTERNAL', message));
    }
  });
}

/** Shared handler for `/notes/<path>` and `/note?path=`. */
function sendNote(
  res: http.ServerResponse,
  notes: NoteInput[],
  index: GraphIndex,
  raw: string,
): void {
  const path = normalizeVaultPath(raw);
  if (path === null) {
    sendJson(res, 400, errorBody('BAD_REQUEST', 'Invalid or missing "path"'));
    return;
  }
  const node = index.nodes.get(path);
  const note = findNote(notes, path);
  if (!node || !note) {
    sendJson(res, 404, errorBody('NOT_FOUND', `No note at "${path}"`));
    return;
  }
  sendJson(res, 200, { path: node.path, title: node.title, content: note.content });
}

/**
 * `graphvault serve` command: load the vault, build the index, start listening,
 * print the URL, and run until interrupted (SIGINT/SIGTERM → graceful close).
 */
export function serveCommand(vaultDir: string, options: ServeOptions = {}): http.Server {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;

  const notes = readVault(vaultDir);
  const index = buildFromNotes(notes);
  const server = createVaultApiServer(notes, index);

  server.listen(port, host, () => {
    const addr = server.address();
    const shownPort = addr !== null && typeof addr === 'object' ? addr.port : port;
    process.stdout.write(
      `graphvault: read-only API listening on http://${host}:${shownPort} ` +
        `(${notes.length} notes)\n`,
    );
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      process.stdout.write(
        `graphvault: WARNING - bound to non-loopback host "${host}"; ` +
          `the vault is now reachable over the network (no auth).\n`,
      );
    }
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
