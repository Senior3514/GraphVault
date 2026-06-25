/**
 * Tests for the read-only HTTP API (server.ts).
 * Run via: node --test "dist/**\/*.test.js"
 *
 * Each test starts `createVaultApiServer` on an ephemeral port (port 0),
 * resolves the real address, then `fetch`es endpoints and asserts status +
 * JSON shape. No fixed port is bound, so tests never collide.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { NoteInput } from '@graphvault/engine';
import { buildFromNotes } from './commands.js';
import { createVaultApiServer, normalizeVaultPath } from './server.js';

/**
 * Parse a Response body as JSON for assertions. The shape varies per endpoint,
 * so we use a single deliberately-loose return type here rather than per-call
 * casts throughout the suite (test-only convenience).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(r: Response): Promise<any> {
  return r.json();
}

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
  },
  {
    path: 'sub/beta.md',
    content: `---
title: Beta Note
tags: [engine]
---
# Beta Note

References [[alpha]] and is part of the engine.
`,
  },
  {
    path: 'orphan.md',
    content: `# Orphan

Nobody links here. #solo
`,
  },
];

describe('createVaultApiServer', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const index = buildFromNotes(NOTES);
    server = createVaultApiServer(NOTES, index);
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('GET /health → {status:ok, notes:N}', async () => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /application\/json/);
    const body = await json(r);
    assert.equal(body.status, 'ok');
    assert.equal(body.notes, 3);
  });

  it('GET /notes → list of {path,title,tags}', async () => {
    const r = await fetch(`${base}/notes`);
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.ok(Array.isArray(body.notes));
    assert.equal(body.notes.length, 3);
    const first = body.notes[0];
    assert.equal(typeof first.path, 'string');
    assert.equal(typeof first.title, 'string');
    assert.ok(Array.isArray(first.tags));
  });

  it('GET /notes/<path> → {path,title,content} (nested path)', async () => {
    const r = await fetch(`${base}/notes/sub/beta.md`);
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.equal(body.path, 'sub/beta.md');
    assert.equal(body.title, 'Beta Note');
    assert.ok(body.content.includes('# Beta Note'));
  });

  it('GET /note?path=... → {path,title,content}', async () => {
    const r = await fetch(`${base}/note?path=alpha.md`);
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.equal(body.path, 'alpha.md');
    assert.equal(body.title, 'Alpha Note');
  });

  it('GET /notes/<missing> → 404 NOT_FOUND', async () => {
    const r = await fetch(`${base}/notes/does-not-exist.md`);
    assert.equal(r.status, 404);
    const body = await json(r);
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('GET /search?q=... → results', async () => {
    const r = await fetch(`${base}/search?q=${encodeURIComponent('graph engine')}`);
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.equal(body.query, 'graph engine');
    assert.ok(body.results.some((x: { path: string }) => x.path === 'alpha.md'));
  });

  it('GET /search?limit=1 → respects limit', async () => {
    const r = await fetch(`${base}/search?q=engine&limit=1`);
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.ok(body.results.length <= 1);
  });

  it('GET /search?limit=0 → empty results (zero is valid)', async () => {
    const r = await fetch(`${base}/search?q=engine&limit=0`);
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.equal(body.results.length, 0);
  });

  it('GET /search?limit=99999 → clamped to at most 500', async () => {
    const r = await fetch(`${base}/search?q=engine&limit=99999`);
    assert.equal(r.status, 200);
    const body = await json(r);
    // Only a few notes exist; the point is the request is accepted and the
    // effective slice is capped (<= 500), never unbounded.
    assert.ok(body.results.length <= 500);
  });

  it('GET /search?limit=-1 → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/search?q=engine&limit=-1`);
    assert.equal(r.status, 400);
    const body = await json(r);
    assert.equal(body.error.code, 'BAD_REQUEST');
  });

  it('GET /search?limit=abc → 400 BAD_REQUEST (NaN)', async () => {
    const r = await fetch(`${base}/search?q=engine&limit=abc`);
    assert.equal(r.status, 400);
    const body = await json(r);
    assert.equal(body.error.code, 'BAD_REQUEST');
  });

  it('GET /search without q → 400', async () => {
    const r = await fetch(`${base}/search`);
    assert.equal(r.status, 400);
    const body = await json(r);
    assert.equal(body.error.code, 'BAD_REQUEST');
  });

  it('GET /graph → nodes + edges', async () => {
    const r = await fetch(`${base}/graph`);
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.equal(body.nodes.length, 3);
    assert.ok(Array.isArray(body.edges));
    assert.equal(body.truncated, false);
  });

  it('GET /backlinks?path=... → backlink edges', async () => {
    const r = await fetch(`${base}/backlinks?path=alpha.md`);
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.equal(body.path, 'alpha.md');
    assert.ok(Array.isArray(body.backlinks));
    // beta.md links to alpha → at least one resolved backlink.
    assert.ok(body.backlinks.some((e: { source: string }) => e.source === 'sub/beta.md'));
  });

  it('GET /backlinks for missing note → 404', async () => {
    const r = await fetch(`${base}/backlinks?path=nope.md`);
    assert.equal(r.status, 404);
  });

  it('GET /stats → stats shape', async () => {
    const r = await fetch(`${base}/stats`);
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.equal(body.noteCount, 3);
    assert.ok(Array.isArray(body.topTags));
    assert.ok(body.orphanNotes.includes('orphan.md'));
  });

  it('unknown route → 404 NOT_FOUND', async () => {
    const r = await fetch(`${base}/nope`);
    assert.equal(r.status, 404);
    const body = await json(r);
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('POST → 405 METHOD_NOT_ALLOWED', async () => {
    const r = await fetch(`${base}/notes`, { method: 'POST' });
    assert.equal(r.status, 405);
    assert.match(r.headers.get('allow') ?? '', /GET/);
    const body = await json(r);
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
  });

  it('path traversal on /note → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/note?path=${encodeURIComponent('../../etc/passwd')}`);
    assert.equal(r.status, 400);
    const body = await json(r);
    assert.equal(body.error.code, 'BAD_REQUEST');
  });

  it('path traversal on /notes/ → 400 BAD_REQUEST', async () => {
    // %2e%2e%2f decodes to ../ ; the server must reject it.
    const r = await fetch(`${base}/notes/%2e%2e%2fsecret.md`);
    assert.equal(r.status, 400);
  });
});

describe('normalizeVaultPath', () => {
  it('accepts clean relative paths', () => {
    assert.equal(normalizeVaultPath('a/b.md'), 'a/b.md');
    assert.equal(normalizeVaultPath('note.md'), 'note.md');
  });

  it('collapses redundant segments', () => {
    assert.equal(normalizeVaultPath('a//b/./c.md'), 'a/b/c.md');
  });

  it('rejects traversal, backslashes, NUL, and empties', () => {
    assert.equal(normalizeVaultPath('../x.md'), null);
    assert.equal(normalizeVaultPath('a/../../x.md'), null);
    assert.equal(normalizeVaultPath('a\\b.md'), null);
    assert.equal(normalizeVaultPath('a\0b.md'), null);
    assert.equal(normalizeVaultPath(''), null);
    assert.equal(normalizeVaultPath('/'), null);
  });
});
