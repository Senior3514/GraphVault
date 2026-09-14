/**
 * Public, opt-in graph-snapshot store tests (Wave 18).
 *
 * Covers:
 *  - disabled by default → every /v1/snapshots* route 404s (feature invisible);
 *  - enabled → POST returns an id, GET round-trips the opaque payload;
 *  - GET unknown id → 404;
 *  - GET with a malformed / path-traversal id → 404 (id-format guard);
 *  - oversize payload → 413, empty payload → 400;
 *  - TTL expiry via an injected clock;
 *  - max-count oldest-first eviction;
 *  - DELETE gated behind the delete token (wrong/missing → 403, right → 204).
 *
 * Runs against the injected in-memory snapshot store; no disk needed.
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
import { InMemorySnapshotStore } from '../src/store/snapshot-store.js';

// ---------------------------------------------------------------------------
// Disabled by default
// ---------------------------------------------------------------------------

test('snapshots disabled by default: all routes 404 and server-info reports off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gv-snap-off-'));
  const config = loadConfig({
    GRAPHVAULT_DATA_DIR: dir,
    NODE_ENV: 'test',
    GRAPHVAULT_RATE_LIMIT_MAX: '100000',
  });
  const app = await buildApp(config, { storage: new InMemoryStorage() });
  await app.ready();
  try {
    const post = await app.inject({
      method: 'POST',
      url: '/v1/snapshots',
      payload: { data: 'abc' },
    });
    assert.equal(post.statusCode, 404, post.body);

    const get = await app.inject({ method: 'GET', url: '/v1/snapshots/aaaaaaaaaaaaaaaa' });
    assert.equal(get.statusCode, 404, get.body);

    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/snapshots/aaaaaaaaaaaaaaaa',
      payload: { deleteToken: 'x' },
    });
    assert.equal(del.statusCode, 404, del.body);

    const info = (await app.inject({ method: 'GET', url: '/v1/server-info' })).json();
    assert.equal(info.snapshots.enabled, false);
    assert.equal(typeof info.snapshots.maxBytes, 'number');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Enabled: shared app for the happy-path + guards
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let dataDir: string;
const clock = Date.UTC(2026, 0, 1);

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gv-snap-'));
  const config = loadConfig({
    GRAPHVAULT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    GRAPHVAULT_SNAPSHOTS_ENABLED: 'true',
    GRAPHVAULT_SNAPSHOT_MAX_BYTES: '64',
    GRAPHVAULT_SNAPSHOT_MAX_COUNT: '3',
    GRAPHVAULT_SNAPSHOT_TTL_DAYS: '30',
    GRAPHVAULT_RATE_LIMIT_MAX: '100000',
    GRAPHVAULT_SNAPSHOT_RATE_LIMIT_MAX: '100000',
  });
  app = await buildApp(config, {
    storage: new InMemoryStorage(),
    snapshotStore: new InMemorySnapshotStore(),
    snapshotNow: () => clock,
  });
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('server-info reports snapshots enabled with maxBytes', async () => {
  const info = (await app.inject({ method: 'GET', url: '/v1/server-info' })).json();
  assert.equal(info.snapshots.enabled, true);
  assert.equal(info.snapshots.maxBytes, 64);
});

test('POST returns an id + deleteToken, GET round-trips the opaque payload', async () => {
  const data = 'gzipped-base64url-graph-payload';
  const post = await app.inject({ method: 'POST', url: '/v1/snapshots', payload: { data } });
  assert.equal(post.statusCode, 201, post.body);
  const { id, deleteToken } = post.json();
  assert.match(id, /^[A-Za-z0-9_-]{16,32}$/);
  assert.ok(typeof deleteToken === 'string' && deleteToken.length > 0);

  const get = await app.inject({ method: 'GET', url: `/v1/snapshots/${id}` });
  assert.equal(get.statusCode, 200, get.body);
  const body = get.json();
  assert.equal(body.id, id);
  assert.equal(body.data, data);
  assert.ok(typeof body.createdAt === 'string');
  // The opaque delete token must never be exposed on read.
  assert.equal(body.deleteToken, undefined);
});

test('GET unknown id → 404', async () => {
  const get = await app.inject({ method: 'GET', url: '/v1/snapshots/doesnotexist0000000' });
  assert.equal(get.statusCode, 404, get.body);
});

test('GET malformed / path-traversal id → 404 (id-format guard)', async () => {
  for (const bad of ['short', '../../etc/passwd', 'has space here aaa', 'a'.repeat(40)]) {
    const get = await app.inject({
      method: 'GET',
      url: `/v1/snapshots/${encodeURIComponent(bad)}`,
    });
    assert.equal(get.statusCode, 404, `GET ${bad} -> ${get.statusCode}`);
  }
});

test('empty payload → 400', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/snapshots', payload: { data: '' } });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'BAD_REQUEST');
});

test('missing data field → 400', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/snapshots', payload: {} });
  assert.equal(res.statusCode, 400, res.body);
});

test('oversize payload → 413', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/snapshots',
    payload: { data: 'x'.repeat(65) }, // limit is 64 bytes
  });
  assert.equal(res.statusCode, 413, res.body);
  assert.equal(res.json().error.code, 'PAYLOAD_TOO_LARGE');
});

// ---------------------------------------------------------------------------
// DELETE gating (delete token)
// ---------------------------------------------------------------------------

test('DELETE requires the correct delete token (403 wrong, 204 right, gone after)', async () => {
  const post = await app.inject({
    method: 'POST',
    url: '/v1/snapshots',
    payload: { data: 'to-be-deleted' },
  });
  const { id, deleteToken } = post.json();

  // Missing token → 400 (body validation).
  const noBody = await app.inject({ method: 'DELETE', url: `/v1/snapshots/${id}` });
  assert.equal(noBody.statusCode, 400, noBody.body);

  // Wrong token → 403.
  const wrong = await app.inject({
    method: 'DELETE',
    url: `/v1/snapshots/${id}`,
    payload: { deleteToken: 'not-the-real-token' },
  });
  assert.equal(wrong.statusCode, 403, wrong.body);
  // Still readable.
  assert.equal((await app.inject({ method: 'GET', url: `/v1/snapshots/${id}` })).statusCode, 200);

  // Correct token → 204, then gone.
  const ok = await app.inject({
    method: 'DELETE',
    url: `/v1/snapshots/${id}`,
    payload: { deleteToken },
  });
  assert.equal(ok.statusCode, 204, ok.body);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/snapshots/${id}` })).statusCode, 404);
});

test('DELETE unknown id → 404', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: '/v1/snapshots/unknownunknown00000',
    payload: { deleteToken: 'whatever' },
  });
  assert.equal(res.statusCode, 404, res.body);
});

// ---------------------------------------------------------------------------
// TTL expiry (injected clock) - dedicated app so eviction tests don't interfere
// ---------------------------------------------------------------------------

test('TTL: a snapshot past its TTL is swept on read → 404', async () => {
  let now = Date.UTC(2026, 5, 1);
  const config = loadConfig({
    GRAPHVAULT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    GRAPHVAULT_SNAPSHOTS_ENABLED: 'true',
    GRAPHVAULT_SNAPSHOT_TTL_DAYS: '7',
    GRAPHVAULT_RATE_LIMIT_MAX: '100000',
    GRAPHVAULT_SNAPSHOT_RATE_LIMIT_MAX: '100000',
  });
  const ttlApp = await buildApp(config, {
    storage: new InMemoryStorage(),
    snapshotStore: new InMemorySnapshotStore(),
    snapshotNow: () => now,
  });
  await ttlApp.ready();
  try {
    const { id } = (
      await ttlApp.inject({ method: 'POST', url: '/v1/snapshots', payload: { data: 'aging' } })
    ).json();
    // Within TTL: still there.
    now += 6 * 24 * 60 * 60 * 1000;
    assert.equal(
      (await ttlApp.inject({ method: 'GET', url: `/v1/snapshots/${id}` })).statusCode,
      200,
    );
    // Past TTL: swept → 404.
    now += 2 * 24 * 60 * 60 * 1000;
    assert.equal(
      (await ttlApp.inject({ method: 'GET', url: `/v1/snapshots/${id}` })).statusCode,
      404,
    );
  } finally {
    await ttlApp.close();
  }
});

// ---------------------------------------------------------------------------
// Max-count oldest-first eviction
// ---------------------------------------------------------------------------

test('max-count: oldest snapshots are evicted oldest-first', async () => {
  let now = Date.UTC(2026, 2, 1);
  const config = loadConfig({
    GRAPHVAULT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    GRAPHVAULT_SNAPSHOTS_ENABLED: 'true',
    GRAPHVAULT_SNAPSHOT_MAX_COUNT: '3',
    GRAPHVAULT_SNAPSHOT_TTL_DAYS: '0', // no expiry, isolate eviction
    GRAPHVAULT_RATE_LIMIT_MAX: '100000',
    GRAPHVAULT_SNAPSHOT_RATE_LIMIT_MAX: '100000',
  });
  const evApp = await buildApp(config, {
    storage: new InMemoryStorage(),
    snapshotStore: new InMemorySnapshotStore(),
    snapshotNow: () => now,
  });
  await evApp.ready();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      now += 1000; // ensure strictly increasing createdAt
      const res = await evApp.inject({
        method: 'POST',
        url: '/v1/snapshots',
        payload: { data: `snap-${i}` },
      });
      assert.equal(res.statusCode, 201, res.body);
      ids.push(res.json().id);
    }
    // Cap is 3, so the OLDEST (ids[0]) must have been evicted.
    assert.equal(
      (await evApp.inject({ method: 'GET', url: `/v1/snapshots/${ids[0]}` })).statusCode,
      404,
    );
    // The 3 newest remain.
    for (const id of ids.slice(1)) {
      assert.equal(
        (await evApp.inject({ method: 'GET', url: `/v1/snapshots/${id}` })).statusCode,
        200,
        `expected ${id} to survive`,
      );
    }
  } finally {
    await evApp.close();
  }
});
