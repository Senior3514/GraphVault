/**
 * Storage-layer tests for the inbox ("connect anything") token + audit methods.
 *
 * These exercise {@link InMemoryStorage} directly (the reference impl the
 * Prisma backend mirrors) to lock in the behavior the durability fix depends on:
 *  - token create / get-by-hash / list-by-user (oldest-first) / touch / delete;
 *  - audit append is per-user, newest-first on read, and capped with
 *    oldest-first eviction once the cap is exceeded.
 *
 * The inbox state now lives in the Storage layer (not on the service), so it
 * survives a restart on the durable backend; these tests pin that contract.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryStorage } from '../src/store/memory.js';
import type { InboxAuditRecord, InboxTokenRecord } from '../src/store/types.js';

function tokenRecord(over: Partial<InboxTokenRecord> = {}): InboxTokenRecord {
  return {
    id: over.id ?? 'tok-1',
    userId: over.userId ?? 'user-1',
    vaultId: over.vaultId ?? 'vault-1',
    label: over.label ?? 'Zapier',
    tokenHash: over.tokenHash ?? 'hash-1',
    createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
    lastUsedAt: over.lastUsedAt ?? null,
  };
}

function auditRecord(over: Partial<InboxAuditRecord> = {}): InboxAuditRecord {
  return {
    id: over.id ?? 'aud-1',
    userId: over.userId ?? 'user-1',
    tokenId: over.tokenId ?? 'tok-1',
    source: over.source ?? 'webhook',
    path: over.path ?? 'Inbox/webhook-abc.md',
    bytes: over.bytes ?? 42,
    status: over.status ?? 'accepted',
    at: over.at ?? '2026-01-01T00:00:00.000Z',
  };
}

test('inbox token: create, get-by-hash, list (oldest-first), touch, delete', async () => {
  const storage = new InMemoryStorage();

  await storage.createInboxToken(tokenRecord({ id: 'a', tokenHash: 'h-a', createdAt: '1' }));
  await storage.createInboxToken(tokenRecord({ id: 'b', tokenHash: 'h-b', createdAt: '2' }));
  // A token for a different user must not leak into user-1's list.
  await storage.createInboxToken(
    tokenRecord({ id: 'c', tokenHash: 'h-c', createdAt: '3', userId: 'user-2' }),
  );

  // get-by-hash resolves the inbound lookup key.
  const byHash = await storage.getInboxTokenByHash('h-b');
  assert.ok(byHash);
  assert.equal(byHash.id, 'b');
  assert.equal(await storage.getInboxTokenByHash('nope'), null);

  // list-by-user is oldest-first and scoped to the user.
  const list = await storage.listInboxTokens('user-1');
  assert.deepEqual(
    list.map((t) => t.id),
    ['a', 'b'],
  );

  // touch updates lastUsedAt without disturbing other fields.
  await storage.touchInboxToken('h-a', '2026-06-15T00:00:00.000Z');
  assert.equal((await storage.getInboxTokenByHash('h-a'))!.lastUsedAt, '2026-06-15T00:00:00.000Z');
  // Touching an unknown hash is a no-op (does not throw).
  await storage.touchInboxToken('missing', '2026-06-15T00:00:00.000Z');

  // delete is owner-scoped and reports whether a row went away.
  assert.equal(await storage.deleteInboxToken('user-2', 'a'), false, 'not the owner');
  assert.equal(await storage.deleteInboxToken('user-1', 'a'), true);
  assert.equal(await storage.deleteInboxToken('user-1', 'a'), false, 'already gone');
  assert.equal(await storage.getInboxTokenByHash('h-a'), null, 'token removed by hash too');
  assert.deepEqual(
    (await storage.listInboxTokens('user-1')).map((t) => t.id),
    ['b'],
  );
});

test('inbox token: get-by-hash returns a copy (no external mutation)', async () => {
  const storage = new InMemoryStorage();
  await storage.createInboxToken(tokenRecord({ tokenHash: 'h' }));
  const got = await storage.getInboxTokenByHash('h');
  assert.ok(got);
  got.label = 'mutated';
  assert.equal((await storage.getInboxTokenByHash('h'))!.label, 'Zapier');
});

test('inbox audit: per-user, newest-first on read', async () => {
  const storage = new InMemoryStorage();
  await storage.appendInboxAudit(auditRecord({ id: 'a1', source: 'first', at: '1' }), 500);
  await storage.appendInboxAudit(auditRecord({ id: 'a2', source: 'second', at: '2' }), 500);
  await storage.appendInboxAudit(
    auditRecord({ id: 'b1', userId: 'user-2', source: 'other', at: '3' }),
    500,
  );

  const entries = await storage.listInboxAudit('user-1');
  // Newest-first.
  assert.deepEqual(
    entries.map((e) => e.source),
    ['second', 'first'],
  );
  // Scoped per user.
  assert.equal((await storage.listInboxAudit('user-2')).length, 1);
  assert.equal((await storage.listInboxAudit('nobody')).length, 0);
});

test('inbox audit: enforces the cap with oldest-first eviction', async () => {
  const storage = new InMemoryStorage();
  const cap = 5;
  for (let i = 0; i < 12; i++) {
    await storage.appendInboxAudit(
      auditRecord({ id: `e${i}`, source: `s${i}`, at: String(i).padStart(3, '0') }),
      cap,
    );
  }
  const entries = await storage.listInboxAudit('user-1');
  // Only the newest `cap` are retained, newest-first.
  assert.equal(entries.length, cap);
  assert.deepEqual(
    entries.map((e) => e.source),
    ['s11', 's10', 's9', 's8', 's7'],
  );
});
