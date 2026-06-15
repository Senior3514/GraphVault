import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { InMemoryStorage } from '../src/store/memory.js';

let app: FastifyInstance;
let dataDir: string;

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gv-test-'));
  const config = loadConfig({ GRAPHVAULT_DATA_DIR: dataDir, NODE_ENV: 'test' });
  app = await buildApp(config, { storage: new InMemoryStorage() });
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const PASSWORD = 'correct horse battery';

async function register(email: string): Promise<{ token: string; deviceId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, deviceName: 'test-device' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  return { token: body.accessToken, deviceId: body.deviceId };
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

test('health and root endpoints still work', async () => {
  const root = await app.inject({ method: 'GET', url: '/' });
  assert.equal(root.statusCode, 200);
  const health = await app.inject({ method: 'GET', url: '/v1/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().status, 'ok');
});

test('register, then login returns a token', async () => {
  const { token } = await register('alice@example.com');
  assert.ok(token.length > 10);

  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'alice@example.com', password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.ok(login.json().accessToken);
});

test('duplicate registration is rejected', async () => {
  await register('dup@example.com');
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'dup@example.com', password: PASSWORD },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'BAD_REQUEST');
});

test('login with wrong password is 401', async () => {
  await register('bob@example.com');
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'bob@example.com', password: 'wrong but long enough' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'UNAUTHORIZED');
});

test('vault routes require auth', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/vaults' });
  assert.equal(res.statusCode, 401);
});

test('full sync flow: create vault, blob round-trip, push, changes', async () => {
  const { token, deviceId } = await register('carol@example.com');

  // create a vault
  const createVault = await app.inject({
    method: 'POST',
    url: '/v1/vaults',
    headers: authHeader(token),
    payload: { name: 'My Vault' },
  });
  assert.equal(createVault.statusCode, 201, createVault.body);
  const vaultId = createVault.json().vaultId;
  assert.equal(createVault.json().revision, 0);

  // list vaults
  const list = await app.inject({ method: 'GET', url: '/v1/vaults', headers: authHeader(token) });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);

  // upload a blob
  const content = Buffer.from('# Hello\n\nFirst note.\n');
  const hash = sha256(content);

  const head404 = await app.inject({
    method: 'HEAD',
    url: `/v1/blobs/${hash}`,
    headers: authHeader(token),
  });
  assert.equal(head404.statusCode, 404);

  const put = await app.inject({
    method: 'PUT',
    url: `/v1/blobs/${hash}`,
    headers: { ...authHeader(token), 'content-type': 'application/octet-stream' },
    payload: content,
  });
  assert.equal(put.statusCode, 201, put.body);
  assert.equal(put.json().hash, hash);
  assert.equal(put.json().size, content.length);

  const head200 = await app.inject({
    method: 'HEAD',
    url: `/v1/blobs/${hash}`,
    headers: authHeader(token),
  });
  assert.equal(head200.statusCode, 200);

  const get = await app.inject({
    method: 'GET',
    url: `/v1/blobs/${hash}`,
    headers: authHeader(token),
  });
  assert.equal(get.statusCode, 200);
  assert.deepEqual(get.rawPayload, content);

  // push a create op
  const push = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/push`,
    headers: authHeader(token),
    payload: {
      deviceId,
      ops: [
        {
          path: 'notes/hello.md',
          hash,
          size: content.length,
          mtime: 1718000000000,
          deleted: false,
          baseRevision: 0,
        },
      ],
    },
  });
  assert.equal(push.statusCode, 200, push.body);
  assert.deepEqual(push.json().applied, ['notes/hello.md']);
  assert.deepEqual(push.json().conflicts, []);
  assert.equal(push.json().revision, 1);

  // pull changes from 0
  const changes = await app.inject({
    method: 'GET',
    url: `/v1/vaults/${vaultId}/changes?since=0`,
    headers: authHeader(token),
  });
  assert.equal(changes.statusCode, 200);
  const cb = changes.json();
  assert.equal(cb.revision, 1);
  assert.equal(cb.hasMore, false);
  assert.equal(cb.changes.length, 1);
  assert.equal(cb.changes[0].path, 'notes/hello.md');
  assert.equal(cb.changes[0].hash, hash);
  assert.equal(cb.changes[0].revision, 1);

  // since=1 returns nothing
  const empty = await app.inject({
    method: 'GET',
    url: `/v1/vaults/${vaultId}/changes?since=1`,
    headers: authHeader(token),
  });
  assert.equal(empty.json().changes.length, 0);
});

test('push referencing a missing blob is MISSING_BLOB', async () => {
  const { token, deviceId } = await register('dave@example.com');
  const vaultId = (
    await app.inject({
      method: 'POST',
      url: '/v1/vaults',
      headers: authHeader(token),
      payload: { name: 'V' },
    })
  ).json().vaultId;

  const fakeHash = `sha256:${'0'.repeat(64)}`;
  const push = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/push`,
    headers: authHeader(token),
    payload: {
      deviceId,
      ops: [{ path: 'a.md', hash: fakeHash, size: 3, mtime: 1, deleted: false, baseRevision: 0 }],
    },
  });
  assert.equal(push.statusCode, 200);
  assert.equal(push.json().applied.length, 0);
  assert.equal(push.json().conflicts.length, 1);
  assert.equal(push.json().conflicts[0].kind, 'MISSING_BLOB');
  assert.equal(push.json().revision, 0);
});

test('content conflict: second device edits from a stale base', async () => {
  const { token, deviceId } = await register('eve@example.com');
  const vaultId = (
    await app.inject({
      method: 'POST',
      url: '/v1/vaults',
      headers: authHeader(token),
      payload: { name: 'V' },
    })
  ).json().vaultId;

  const v1 = Buffer.from('version one');
  const v2 = Buffer.from('version two, different');
  const h1 = sha256(v1);
  const h2 = sha256(v2);

  for (const [content, hash] of [
    [v1, h1],
    [v2, h2],
  ] as const) {
    await app.inject({
      method: 'PUT',
      url: `/v1/blobs/${hash}`,
      headers: { ...authHeader(token), 'content-type': 'application/octet-stream' },
      payload: content,
    });
  }

  // first push creates the file at revision 1
  const first = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/push`,
    headers: authHeader(token),
    payload: {
      deviceId,
      ops: [
        { path: 'doc.md', hash: h1, size: v1.length, mtime: 1, deleted: false, baseRevision: 0 },
      ],
    },
  });
  assert.equal(first.json().revision, 1);

  // second push edits from baseRevision 0 (stale) with different content
  const second = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/push`,
    headers: authHeader(token),
    payload: {
      deviceId,
      ops: [
        { path: 'doc.md', hash: h2, size: v2.length, mtime: 2, deleted: false, baseRevision: 0 },
      ],
    },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().applied.length, 0);
  assert.equal(second.json().conflicts.length, 1);
  assert.equal(second.json().conflicts[0].kind, 'CONTENT_CONFLICT');
  assert.equal(second.json().conflicts[0].server.hash, h1);
  assert.equal(second.json().revision, 1);
});

test('no-op push (same content) is accepted idempotently without bumping head', async () => {
  const { token, deviceId } = await register('frank@example.com');
  const vaultId = (
    await app.inject({
      method: 'POST',
      url: '/v1/vaults',
      headers: authHeader(token),
      payload: { name: 'V' },
    })
  ).json().vaultId;

  const content = Buffer.from('same');
  const hash = sha256(content);
  await app.inject({
    method: 'PUT',
    url: `/v1/blobs/${hash}`,
    headers: { ...authHeader(token), 'content-type': 'application/octet-stream' },
    payload: content,
  });

  await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/push`,
    headers: authHeader(token),
    payload: {
      deviceId,
      ops: [{ path: 'x.md', hash, size: 4, mtime: 1, deleted: false, baseRevision: 0 }],
    },
  });

  // re-push identical result from a stale base; should be a no-op accept
  const again = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/push`,
    headers: authHeader(token),
    payload: {
      deviceId,
      ops: [{ path: 'x.md', hash, size: 4, mtime: 1, deleted: false, baseRevision: 0 }],
    },
  });
  assert.deepEqual(again.json().applied, ['x.md']);
  assert.equal(again.json().conflicts.length, 0);
  assert.equal(again.json().revision, 1, 'head should not advance for a no-op');
});

test('blob upload with mismatched hash is rejected', async () => {
  const { token } = await register('grace@example.com');
  const claimed = `sha256:${'a'.repeat(64)}`;
  const res = await app.inject({
    method: 'PUT',
    url: `/v1/blobs/${claimed}`,
    headers: { ...authHeader(token), 'content-type': 'application/octet-stream' },
    payload: Buffer.from('these bytes do not match'),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'BAD_REQUEST');
});

test('cannot access a vault owned by another user', async () => {
  const a = await register('owner@example.com');
  const b = await register('intruder@example.com');
  const vaultId = (
    await app.inject({
      method: 'POST',
      url: '/v1/vaults',
      headers: authHeader(a.token),
      payload: { name: 'Private' },
    })
  ).json().vaultId;

  const res = await app.inject({
    method: 'GET',
    url: `/v1/vaults/${vaultId}/changes?since=0`,
    headers: authHeader(b.token),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'FORBIDDEN');
});

test('delete vs edit yields DELETE_EDIT_CONFLICT', async () => {
  const { token, deviceId } = await register('heidi@example.com');
  const vaultId = (
    await app.inject({
      method: 'POST',
      url: '/v1/vaults',
      headers: authHeader(token),
      payload: { name: 'V' },
    })
  ).json().vaultId;

  const content = Buffer.from('a doc');
  const hash = sha256(content);
  await app.inject({
    method: 'PUT',
    url: `/v1/blobs/${hash}`,
    headers: { ...authHeader(token), 'content-type': 'application/octet-stream' },
    payload: content,
  });
  await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/push`,
    headers: authHeader(token),
    payload: {
      deviceId,
      ops: [
        { path: 'd.md', hash, size: content.length, mtime: 1, deleted: false, baseRevision: 0 },
      ],
    },
  });

  // delete from stale base 0 while server is at revision 1 with content
  const del = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/push`,
    headers: authHeader(token),
    payload: {
      deviceId,
      ops: [{ path: 'd.md', hash: null, size: 0, mtime: 2, deleted: true, baseRevision: 0 }],
    },
  });
  assert.equal(del.json().conflicts[0].kind, 'DELETE_EDIT_CONFLICT');
});
