/**
 * Conflict-safe write-tool tests against a stubbed global `fetch`.
 *
 * No real network is used. A small in-memory fake server answers /changes
 * (current FileState per path), /blobs PUT (records uploads), and /push (applies
 * fast-forward-only, returns conflicts otherwise), so the read-modify-write and
 * conflict paths are exercised end-to-end through the real client.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { FileState } from '@graphvault/shared';
import { GraphVaultClient } from './client.js';
import type { McpConfig } from './config.js';
import { VaultManager } from './vault.js';
import {
  bindWriteTools,
  contentHashOf,
  validateNotePath,
  WriteConflictError,
  WritesDisabledError,
} from './writes.js';

const BASE = 'https://vault.example.com';
const VAULT = 'v1';
const DEVICE = 'device-123';

function hashOf(content: string): string {
  return 'sha256:' + createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

/**
 * A tiny in-memory server keyed by path -> current FileState. `push` only
 * fast-forward accepts (baseRevision === current revision); otherwise it
 * returns a conflict and does NOT mutate state.
 */
class FakeServer {
  revision = 0;
  states = new Map<string, FileState>();
  blobs = new Map<string, string>();

  seed(path: string, content: string, revision: number): void {
    this.blobs.set(hashOf(content), content);
    this.states.set(path, {
      path,
      hash: hashOf(content),
      size: Buffer.byteLength(content, 'utf8'),
      mtime: 1,
      deleted: false,
      revision,
    });
    if (revision > this.revision) this.revision = revision;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;

    // GET /v1/vaults/:id/changes
    if (method === 'GET' && /\/changes$/.test(path)) {
      const changes = [...this.states.values()];
      return json({ revision: this.revision, changes, hasMore: false });
    }
    // PUT /v1/blobs/:hash
    if (method === 'PUT' && /\/v1\/blobs\//.test(path)) {
      const hash = decodeURIComponent(path.split('/').pop() ?? '');
      const bytes = init?.body as Uint8Array;
      this.blobs.set(hash, new TextDecoder().decode(bytes));
      return json({ hash, size: bytes.byteLength }, 201);
    }
    // GET /v1/blobs/:hash
    if (method === 'GET' && /\/v1\/blobs\//.test(path)) {
      const hash = decodeURIComponent(path.split('/').pop() ?? '');
      const content = this.blobs.get(hash);
      if (content === undefined)
        return json({ error: { code: 'NOT_FOUND', message: 'no blob' } }, 404);
      return new Response(new TextEncoder().encode(content), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    // POST /v1/vaults/:id/push
    if (method === 'POST' && /\/push$/.test(path)) {
      const body = JSON.parse(String(init?.body)) as {
        deviceId: string;
        ops: Array<{
          path: string;
          hash: string | null;
          size: number;
          deleted: boolean;
          baseRevision: number;
        }>;
      };
      const applied: string[] = [];
      const conflicts: Array<{ path: string; kind: string; server: FileState | null }> = [];
      for (const op of body.ops) {
        const server = this.states.get(op.path) ?? null;
        const serverRev = server?.revision ?? 0;
        if (op.baseRevision !== serverRev) {
          const kind = !op.deleted && server && !server.deleted ? 'CONTENT_CONFLICT' : 'STALE_BASE';
          conflicts.push({ path: op.path, kind, server });
          continue;
        }
        if (!op.deleted && op.hash !== null && !this.blobs.has(op.hash)) {
          conflicts.push({ path: op.path, kind: 'MISSING_BLOB', server });
          continue;
        }
        this.revision += 1;
        this.states.set(op.path, {
          path: op.path,
          hash: op.deleted ? null : op.hash,
          size: op.deleted ? 0 : op.size,
          mtime: 1,
          deleted: op.deleted,
          revision: this.revision,
        });
        applied.push(op.path);
      }
      return json({ revision: this.revision, applied, conflicts });
    }
    throw new Error(`FakeServer: unexpected ${method} ${path}`);
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeConfig(over: Partial<McpConfig>): McpConfig {
  return {
    serverUrl: BASE,
    token: 't',
    vaultId: VAULT,
    vaultName: undefined,
    deviceId: DEVICE,
    indexTtlMs: 1000,
    ...over,
  };
}

function setup(server: FakeServer, configOver: Partial<McpConfig> = {}) {
  const config = makeConfig(configOver);
  const client = new GraphVaultClient(config, { fetchImpl: server.fetch });
  const manager = new VaultManager(client, config);
  const tools = bindWriteTools(manager, client, config);
  return { config, client, manager, tools };
}

// --- pure helpers ----------------------------------------------------------

test('contentHashOf is the SHA-256 of the UTF-8 plaintext as sha256:<hex>', () => {
  const content = '# Héllo wörld\n';
  const expected =
    'sha256:' + createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
  assert.equal(contentHashOf(content), expected);
  assert.match(contentHashOf(content), /^sha256:[0-9a-f]{64}$/);
});

test('validateNotePath rejects traversal, absolute, and non-markdown paths', () => {
  assert.equal(validateNotePath('a/b.md'), 'a/b.md');
  assert.throws(() => validateNotePath('/abs.md'), /vault-relative/);
  assert.throws(() => validateNotePath('a/../b.md'), /segments/);
  assert.throws(() => validateNotePath('a\\b.md'), /forward slashes/);
  assert.throws(() => validateNotePath('notes/plain.txt'), /\.md/);
});

// --- create ----------------------------------------------------------------

test('create_note creates a new note and uploads the plaintext blob', async () => {
  const server = new FakeServer();
  const { tools } = setup(server);

  const res = await tools.createNote({ path: 'inbox/new.md', content: '# New\n' });
  assert.equal(res.path, 'inbox/new.md');
  assert.equal(res.hash, hashOf('# New\n'));
  // The blob was uploaded with the correct content addressed by hash.
  assert.equal(server.blobs.get(hashOf('# New\n')), '# New\n');
  // The push committed a live state.
  assert.equal(server.states.get('inbox/new.md')?.deleted, false);
});

test('create_note rejects when a live note already exists (no clobber)', async () => {
  const server = new FakeServer();
  server.seed('exists.md', 'original', 1);
  const { tools } = setup(server);

  await assert.rejects(
    () => tools.createNote({ path: 'exists.md', content: 'OVERWRITE' }),
    /already exists/,
  );
  // The original content is untouched.
  assert.equal(server.states.get('exists.md')?.hash, hashOf('original'));
});

// --- update ----------------------------------------------------------------

test('update_note rejects when the note is missing', async () => {
  const server = new FakeServer();
  const { tools } = setup(server);
  await assert.rejects(() => tools.updateNote({ path: 'nope.md', content: 'x' }), /no note exists/);
});

test('update_note replaces content at the current revision', async () => {
  const server = new FakeServer();
  server.seed('note.md', 'v1 body', 1);
  const { tools } = setup(server);

  const res = await tools.updateNote({ path: 'note.md', content: 'v2 body' });
  assert.equal(res.hash, hashOf('v2 body'));
  assert.equal(server.states.get('note.md')?.hash, hashOf('v2 body'));
});

test('update_note with a matching expectedHash succeeds', async () => {
  const server = new FakeServer();
  server.seed('note.md', 'current', 1);
  const { tools } = setup(server);

  const res = await tools.updateNote({
    path: 'note.md',
    content: 'next',
    expectedHash: hashOf('current'),
  });
  assert.equal(res.hash, hashOf('next'));
});

test('update_note rejects a mismatched expectedHash (optimistic concurrency)', async () => {
  const server = new FakeServer();
  server.seed('note.md', 'current', 1);
  const { tools } = setup(server);

  await assert.rejects(
    () =>
      tools.updateNote({
        path: 'note.md',
        content: 'next',
        expectedHash: 'sha256:' + 'f'.repeat(64),
      }),
    /expectedHash .* does not match/,
  );
  // Unchanged — no clobber.
  assert.equal(server.states.get('note.md')?.hash, hashOf('current'));
});

// --- append ----------------------------------------------------------------

test('append_to_note reads, appends with a newline separator, and writes', async () => {
  const server = new FakeServer();
  server.seed('log.md', 'line one', 1); // no trailing newline
  const { tools } = setup(server);

  await tools.appendToNote({ path: 'log.md', content: 'line two' });
  const newHash = server.states.get('log.md')?.hash;
  assert.equal(newHash, hashOf('line one\nline two'));
  assert.equal(server.blobs.get(newHash as string), 'line one\nline two');
});

test('append_to_note does not double a newline when content already ends in one', async () => {
  const server = new FakeServer();
  server.seed('log.md', 'line one\n', 1);
  const { tools } = setup(server);

  await tools.appendToNote({ path: 'log.md', content: 'line two' });
  assert.equal(server.states.get('log.md')?.hash, hashOf('line one\nline two'));
});

test('append_to_note rejects when the note is missing', async () => {
  const server = new FakeServer();
  const { tools } = setup(server);
  await assert.rejects(() => tools.appendToNote({ path: 'no.md', content: 'x' }), /no note exists/);
});

// --- delete ----------------------------------------------------------------

test('delete_note tombstones an existing note', async () => {
  const server = new FakeServer();
  server.seed('gone.md', 'bye', 1);
  const { tools } = setup(server);

  const res = await tools.deleteNote({ path: 'gone.md' });
  assert.equal(res.hash, null);
  const state = server.states.get('gone.md');
  assert.equal(state?.deleted, true);
  assert.equal(state?.hash, null);
});

test('delete_note rejects when the note is missing', async () => {
  const server = new FakeServer();
  const { tools } = setup(server);
  await assert.rejects(() => tools.deleteNote({ path: 'no.md' }), /no note exists/);
});

// --- conflict surfaced, not clobbered --------------------------------------

test('a conflict response is surfaced as a WriteConflictError, not a silent clobber', async () => {
  const server = new FakeServer();
  server.seed('hot.md', 'server version', 5);
  const { tools, client } = setup(server);

  // Simulate a concurrent edit between our read and push: after getFileState
  // returns revision 5, another writer bumps the server to revision 6.
  const realPush = client.push.bind(client);
  let pushed = false;
  client.push = async (vaultId, deviceId, ops) => {
    if (!pushed) {
      pushed = true;
      // Advance the server so our baseRevision (5) is now stale.
      server.revision = 6;
      server.states.set('hot.md', {
        path: 'hot.md',
        hash: hashOf('someone elses edit'),
        size: 1,
        mtime: 1,
        deleted: false,
        revision: 6,
      });
    }
    return realPush(vaultId, deviceId, ops);
  };

  await assert.rejects(
    () => tools.updateNote({ path: 'hot.md', content: 'my edit' }),
    (err: unknown) => {
      assert.ok(err instanceof WriteConflictError);
      assert.match(err.message, /CONTENT_CONFLICT/);
      assert.match(err.message, /NOT applied/);
      return true;
    },
  );
  // The concurrent edit survived — our write did not overwrite it.
  assert.equal(server.states.get('hot.md')?.hash, hashOf('someone elses edit'));
});

// --- writes disabled --------------------------------------------------------

test('write tools are disabled and error clearly when GRAPHVAULT_DEVICE_ID is unset', async () => {
  const server = new FakeServer();
  server.seed('note.md', 'body', 1);
  const { tools } = setup(server, { deviceId: undefined });

  assert.equal(tools.enabled, false);
  for (const call of [
    () => tools.createNote({ path: 'a.md', content: 'x' }),
    () => tools.updateNote({ path: 'note.md', content: 'x' }),
    () => tools.appendToNote({ path: 'note.md', content: 'x' }),
    () => tools.deleteNote({ path: 'note.md' }),
  ]) {
    await assert.rejects(call, (err: unknown) => {
      assert.ok(err instanceof WritesDisabledError);
      assert.match(err.message, /writes disabled: set GRAPHVAULT_DEVICE_ID/);
      return true;
    });
  }
  // Nothing was uploaded or pushed.
  assert.equal(server.states.get('note.md')?.hash, hashOf('body'));
});
