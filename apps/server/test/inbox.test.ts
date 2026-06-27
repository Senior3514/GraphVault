/**
 * "Connect anything" inbound webhook tests (M22, Wave 19).
 *
 * Covers:
 *  - token CRUD requires auth; the raw token is returned ONCE at create and
 *    never appears in the list;
 *  - ownership is enforced - you cannot mint a token for a vault you don't own;
 *  - a public inbound POST creates a note that shows up via the vault's
 *    `/changes` feed;
 *  - an unknown token → 404 (no leak), an oversize body → 413;
 *  - repeated posts produce DISTINCT, non-clobbering paths;
 *  - the audit log records accepted submissions, is newest-first, and is
 *    auth-gated;
 *  - a revoked token → 404 (and is gone from the list).
 *
 * Runs against the in-memory storage; no disk needed beyond a temp data dir.
 */

import assert from 'node:assert/strict';
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

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gv-inbox-'));
  const config = loadConfig({
    GRAPHVAULT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    // Lift the global + inbound rate limits so the test can fire many requests.
    GRAPHVAULT_RATE_LIMIT_MAX: '100000',
    GRAPHVAULT_INBOX_RATE_LIMIT_MAX: '100000',
  });
  app = await buildApp(config, { storage: new InMemoryStorage() });
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const PASSWORD = 'correct horse battery';

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function register(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, deviceName: 'test-device' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().accessToken as string;
}

async function createVault(token: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/vaults',
    headers: authHeader(token),
    payload: { name },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().vaultId as string;
}

test('server-info reports inbox enabled by default', async () => {
  const info = (await app.inject({ method: 'GET', url: '/v1/server-info' })).json();
  assert.equal(info.inbox.enabled, true);
  assert.equal(typeof info.inbox.maxBytes, 'number');
});

test('token CRUD requires auth', async () => {
  const noAuthList = await app.inject({ method: 'GET', url: '/v1/inbox/tokens' });
  assert.equal(noAuthList.statusCode, 401, noAuthList.body);

  const noAuthCreate = await app.inject({
    method: 'POST',
    url: '/v1/inbox/tokens',
    payload: { vaultId: 'x', label: 'y' },
  });
  assert.equal(noAuthCreate.statusCode, 401, noAuthCreate.body);

  const noAuthLog = await app.inject({ method: 'GET', url: '/v1/inbox/log' });
  assert.equal(noAuthLog.statusCode, 401, noAuthLog.body);
});

test('mint a token: returned once, never in the list; ownership enforced', async () => {
  const token = await register('owner@example.com');
  const vaultId = await createVault(token, 'My Vault');

  const created = await app.inject({
    method: 'POST',
    url: '/v1/inbox/tokens',
    headers: authHeader(token),
    payload: { vaultId, label: 'Zapier' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json();
  assert.equal(typeof body.token, 'string');
  assert.ok(body.token.length > 20);
  assert.equal(body.label, 'Zapier');
  assert.ok(typeof body.id === 'string');

  // List: the token + hash must NEVER be present.
  const list = await app.inject({
    method: 'GET',
    url: '/v1/inbox/tokens',
    headers: authHeader(token),
  });
  assert.equal(list.statusCode, 200, list.body);
  const items = list.json() as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, body.id);
  assert.equal(items[0].vaultId, vaultId);
  assert.equal(items[0].label, 'Zapier');
  assert.equal(items[0].lastUsedAt, null);
  assert.ok(!('token' in items[0]));
  assert.ok(!('tokenHash' in items[0]));
  assert.equal(JSON.stringify(items[0]).includes(body.token), false);

  // Ownership: a different user cannot mint a token for this vault → 403.
  const other = await register('intruder@example.com');
  const denied = await app.inject({
    method: 'POST',
    url: '/v1/inbox/tokens',
    headers: authHeader(other),
    payload: { vaultId, label: 'sneaky' },
  });
  assert.equal(denied.statusCode, 403, denied.body);
});

test('inbound POST creates a note that appears in /changes; lastUsedAt updates', async () => {
  const token = await register('inbound@example.com');
  const vaultId = await createVault(token, 'Inbound Vault');
  const created = (
    await app.inject({
      method: 'POST',
      url: '/v1/inbox/tokens',
      headers: authHeader(token),
      payload: { vaultId, label: 'email' },
    })
  ).json();
  const inboxToken = created.token as string;

  const post = await app.inject({
    method: 'POST',
    url: `/v1/inbox/${inboxToken}`,
    payload: {
      title: 'Hello from the web',
      markdown: 'This is **inbound** content.',
      tags: ['inbox', 'webhook'],
      source: 'My Connector!!',
    },
  });
  assert.equal(post.statusCode, 201, post.body);
  const path = post.json().path as string;
  // Path scheme: Inbox/<sanitized-source>-<short-id>.md
  assert.match(path, /^Inbox\/My-Connector-[A-Za-z0-9]+\.md$/);

  // The note shows up in the vault's changes feed.
  const changes = await app.inject({
    method: 'GET',
    url: `/v1/vaults/${vaultId}/changes?since=0`,
    headers: authHeader(token),
  });
  assert.equal(changes.statusCode, 200, changes.body);
  const cb = changes.json();
  const match = cb.changes.find((c: { path: string }) => c.path === path);
  assert.ok(match, 'created note should appear in /changes');
  assert.equal(match.deleted, false);
  assert.ok(typeof match.hash === 'string' && match.hash.startsWith('sha256:'));

  // lastUsedAt is now populated for this token.
  const list = (
    await app.inject({
      method: 'GET',
      url: '/v1/inbox/tokens',
      headers: authHeader(token),
    })
  ).json() as Array<{ id: string; lastUsedAt: string | null }>;
  const me = list.find((t) => t.id === created.id)!;
  assert.ok(me.lastUsedAt !== null, 'lastUsedAt should be set after a submission');
});

test('repeated posts produce distinct, non-clobbering paths', async () => {
  const token = await register('repeat@example.com');
  const vaultId = await createVault(token, 'Repeat Vault');
  const inboxToken = (
    await app.inject({
      method: 'POST',
      url: '/v1/inbox/tokens',
      headers: authHeader(token),
      payload: { vaultId, label: 'cron' },
    })
  ).json().token as string;

  const paths = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/inbox/${inboxToken}`,
      payload: { markdown: `note ${i}`, source: 'same' },
    });
    assert.equal(res.statusCode, 201, res.body);
    paths.add(res.json().path as string);
  }
  assert.equal(paths.size, 8, 'every inbound post must get a unique path');

  // All eight notes are present in the vault (none clobbered another).
  const cb = (
    await app.inject({
      method: 'GET',
      url: `/v1/vaults/${vaultId}/changes?since=0`,
      headers: authHeader(token),
    })
  ).json();
  const live = cb.changes.filter((c: { deleted: boolean }) => !c.deleted);
  assert.equal(live.length, 8);
});

test('unknown token → 404, oversize body → 413', async () => {
  const token = await register('limits@example.com');
  const vaultId = await createVault(token, 'Limits Vault');
  const inboxToken = (
    await app.inject({
      method: 'POST',
      url: '/v1/inbox/tokens',
      headers: authHeader(token),
      payload: { vaultId, label: 'limits' },
    })
  ).json().token as string;

  const unknown = await app.inject({
    method: 'POST',
    url: '/v1/inbox/this-is-not-a-real-token',
    payload: { markdown: 'hi' },
  });
  assert.equal(unknown.statusCode, 404, unknown.body);

  // Oversize: a markdown body above the inbox cap (default 1 MB) → 413.
  // (Stays under the global JSON bodyLimit which is also 1 MiB, so the service
  // cap is what fires; we keep it just over 1_000_000 bytes of content.)
  const big = 'x'.repeat(1_000_001);
  const oversize = await app.inject({
    method: 'POST',
    url: `/v1/inbox/${inboxToken}`,
    payload: { markdown: big },
  });
  assert.equal(oversize.statusCode, 413, `expected 413, got ${oversize.statusCode}`);
});

test('audit log records accepted submissions, newest-first, auth-gated', async () => {
  const token = await register('audit@example.com');
  const vaultId = await createVault(token, 'Audit Vault');
  const created = (
    await app.inject({
      method: 'POST',
      url: '/v1/inbox/tokens',
      headers: authHeader(token),
      payload: { vaultId, label: 'auditconn' },
    })
  ).json();
  const inboxToken = created.token as string;

  await app.inject({
    method: 'POST',
    url: `/v1/inbox/${inboxToken}`,
    payload: { markdown: 'first', source: 'a' },
  });
  await app.inject({
    method: 'POST',
    url: `/v1/inbox/${inboxToken}`,
    payload: { markdown: 'second', source: 'b' },
  });

  const log = await app.inject({
    method: 'GET',
    url: '/v1/inbox/log',
    headers: authHeader(token),
  });
  assert.equal(log.statusCode, 200, log.body);
  const entries = log.json() as Array<{
    tokenId: string;
    source: string;
    status: string;
    path: string | null;
    bytes: number;
  }>;
  assert.equal(entries.length, 2);
  // Newest first.
  assert.equal(entries[0].source, 'b');
  assert.equal(entries[1].source, 'a');
  for (const e of entries) {
    assert.equal(e.status, 'accepted');
    assert.equal(e.tokenId, created.id);
    assert.ok(typeof e.path === 'string' && e.path.startsWith('Inbox/'));
    assert.ok(e.bytes > 0);
  }

  // A different user does not see this user's audit entries.
  const other = await register('nosey@example.com');
  const otherLog = (
    await app.inject({
      method: 'GET',
      url: '/v1/inbox/log',
      headers: authHeader(other),
    })
  ).json();
  assert.equal(otherLog.length, 0);
});

test('revoked token → 404 and is gone from the list', async () => {
  const token = await register('revoke@example.com');
  const vaultId = await createVault(token, 'Revoke Vault');
  const created = (
    await app.inject({
      method: 'POST',
      url: '/v1/inbox/tokens',
      headers: authHeader(token),
      payload: { vaultId, label: 'temp' },
    })
  ).json();
  const inboxToken = created.token as string;

  // Works before revocation.
  const before = await app.inject({
    method: 'POST',
    url: `/v1/inbox/${inboxToken}`,
    payload: { markdown: 'still works' },
  });
  assert.equal(before.statusCode, 201, before.body);

  // Revoke.
  const del = await app.inject({
    method: 'DELETE',
    url: `/v1/inbox/tokens/${created.id}`,
    headers: authHeader(token),
  });
  assert.equal(del.statusCode, 204, del.body);

  // Gone from the list.
  const list = (
    await app.inject({
      method: 'GET',
      url: '/v1/inbox/tokens',
      headers: authHeader(token),
    })
  ).json() as Array<{ id: string }>;
  assert.ok(!list.some((t) => t.id === created.id));

  // The token no longer works → 404.
  const after = await app.inject({
    method: 'POST',
    url: `/v1/inbox/${inboxToken}`,
    payload: { markdown: 'should fail' },
  });
  assert.equal(after.statusCode, 404, after.body);

  // Revoking again (or someone else's) → 404.
  const reDel = await app.inject({
    method: 'DELETE',
    url: `/v1/inbox/tokens/${created.id}`,
    headers: authHeader(token),
  });
  assert.equal(reDel.statusCode, 404, reDel.body);
});
