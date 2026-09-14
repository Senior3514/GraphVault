/**
 * Google Cloud Storage proxy route + signing tests (Wave 16).
 *
 * GCS is accessed via its S3-compatible XML API with AWS SigV4 (the exact signer
 * from s3.ts, reused). We mock the outbound `fetch` calls via a monkey-patch on
 * `globalThis.fetch`, so no real GCS bucket is needed. SigV4 signing is asserted
 * deterministically against a fixed date and the known signer behavior.
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
import { signS3Request } from '../src/services/s3.js';
import { buildGcsObjectUrl, GCS_HOST, GCS_REGION } from '../src/services/gcs.js';
import {
  __setResolverForTests,
  __setTransportForTests,
  type GuardedTransport,
  type ResolveAllFn,
} from '../src/services/ssrf.js';

let app: FastifyInstance;
let dataDir: string;

const PASSWORD = 'secure-password-for-gcs-tests';
let token = '';

// ---------------------------------------------------------------------------
// Fake GCS responses
// ---------------------------------------------------------------------------

let restoreTransport: (() => void) | undefined;
let restoreResolver: (() => void) | undefined;

const fakeStore = new Map<string, Buffer>();

function makeFakeGcsFetch(): GuardedTransport {
  return async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();

    if (method === 'GET') {
      const content = fakeStore.get(url);
      if (!content) {
        return new Response('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>', {
          status: 404,
          headers: { 'content-type': 'application/xml' },
        });
      }
      return new Response(content, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'PUT') {
      const body = init.body;
      let buf: Buffer;
      if (body instanceof Uint8Array) buf = Buffer.from(body);
      else if (typeof body === 'string') buf = Buffer.from(body, 'utf8');
      else buf = Buffer.alloc(0);
      fakeStore.set(url, buf);
      return new Response(null, { status: 200 });
    }
    if (method === 'DELETE') {
      fakeStore.delete(url);
      return new Response(null, { status: 204 });
    }
    return new Response('Method not allowed', { status: 405 });
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gv-gcs-test-'));
  const config = loadConfig({
    GRAPHVAULT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    GRAPHVAULT_RATE_LIMIT_MAX: '100000',
    GRAPHVAULT_AUTH_RATE_LIMIT_MAX: '100000',
  });
  app = await buildApp(config, { storage: new InMemoryStorage() });
  await app.ready();

  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'gcstest@example.com', password: PASSWORD, deviceName: 'test' },
  });
  assert.equal(res.statusCode, 201, res.body);
  token = res.json().accessToken;

  restoreTransport = __setTransportForTests(makeFakeGcsFetch());
  restoreResolver = __setResolverForTests((async () => ['93.184.216.34']) as ResolveAllFn);
});

after(async () => {
  restoreTransport?.();
  restoreResolver?.();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  fakeStore.clear();
});

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

const GCS_OBJECT_URL = '/v1/storage/gcs/object/graphvault-vault.json';

// ---------------------------------------------------------------------------
// SigV4 wiring tests (GCS reuses the s3.ts signer with host=storage.googleapis.com)
// ---------------------------------------------------------------------------

test('buildGcsObjectUrl targets the GCS XML API host', () => {
  assert.equal(
    buildGcsObjectUrl('my-bucket', 'graphvault-vault.json'),
    'https://storage.googleapis.com/my-bucket/graphvault-vault.json',
  );
  assert.equal(GCS_HOST, 'storage.googleapis.com');
  assert.equal(GCS_REGION, 'auto');
});

test('buildGcsObjectUrl prepends an optional prefix', () => {
  assert.equal(
    buildGcsObjectUrl('my-bucket', 'graphvault-vault.json', 'graphvault/'),
    'https://storage.googleapis.com/my-bucket/graphvault/graphvault-vault.json',
  );
});

test('GCS SigV4 signing is deterministic, scoped to /auto/s3/, and omits the host header', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const url = buildGcsObjectUrl('my-bucket', 'graphvault-vault.json');
  const params = {
    method: 'GET',
    url,
    region: GCS_REGION,
    accessKeyId: 'GOOG1EXAMPLEACCESSID',
    secretAccessKey: 'EXAMPLEHMACSECRET',
    payload: Buffer.alloc(0),
  };
  const r1 = signS3Request(params, now);
  const r2 = signS3Request(params, now);
  assert.equal(r1.headers['authorization'], r2.headers['authorization']);

  const auth = r1.headers['authorization'];
  assert.ok(auth.startsWith('AWS4-HMAC-SHA256 '), `expected SigV4 auth, got ${auth.slice(0, 40)}`);
  // Credential scope must use the GCS region "auto" + service "s3".
  assert.ok(auth.includes('/auto/s3/aws4_request'), `scope should be /auto/s3/, got ${auth}`);
  assert.equal(r1.headers['x-amz-date'], '20260615T120000Z');
  // host is signed but stripped from the returned headers (fetch sets it).
  assert.ok(!('host' in r1.headers), 'host must not be in returned headers');
});

// ---------------------------------------------------------------------------
// Config endpoints
// ---------------------------------------------------------------------------

test('GET /v1/storage/gcs/config returns 404 when not configured', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/gcs/config',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('POST /v1/storage/gcs/config stores config and returns 201', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/gcs/config',
    headers: authHeader(),
    payload: {
      bucket: 'my-graphvault-bucket',
      accessId: 'GOOG1EXAMPLEACCESSID',
      secret: 'EXAMPLEHMACSECRET',
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.ok(res.json().ok);
});

test('GET /v1/storage/gcs/config returns non-secret info; secret is NEVER returned', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/gcs/config',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.bucket, 'my-graphvault-bucket');
  assert.equal(body.accessId, 'GOOG1EXAMPLEACCESSID');
  assert.ok(body.updatedAt);
  assert.ok(!('secret' in body), 'secret must not be in response');
  assert.ok(!('encryptedSecret' in body), 'encryptedSecret must not be in response');
  assert.ok(
    !JSON.stringify(body).includes('EXAMPLEHMACSECRET'),
    'plaintext secret must not appear anywhere',
  );
});

test('POST /v1/storage/gcs/config rejects missing required fields', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/gcs/config',
    headers: authHeader(),
    payload: { bucket: 'b' }, // missing accessId + secret
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('POST /v1/storage/gcs/config rejects a prefix not ending in "/"', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/gcs/config',
    headers: authHeader(),
    payload: { bucket: 'b', accessId: 'id', secret: 'sec', prefix: 'nope' },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('POST /v1/storage/gcs/config accepts an optional prefix', async () => {
  const regRes = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'gcstest-prefix@example.com', password: PASSWORD, deviceName: 'p' },
  });
  const tok = regRes.json().accessToken;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/gcs/config',
    headers: { authorization: `Bearer ${tok}` },
    payload: { bucket: 'gv', accessId: 'id', secret: 'sec', prefix: 'notes/' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const getRes = await app.inject({
    method: 'GET',
    url: '/v1/storage/gcs/config',
    headers: { authorization: `Bearer ${tok}` },
  });
  assert.equal(getRes.json().prefix, 'notes/');
});

test('POST /v1/storage/gcs/config requires auth', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/gcs/config',
    payload: { bucket: 'b', accessId: 'id', secret: 'sec' },
  });
  assert.equal(res.statusCode, 401);
});

// ---------------------------------------------------------------------------
// Object proxy endpoints
// ---------------------------------------------------------------------------

test('PUT then GET round-trips the vault object through the GCS proxy', async () => {
  const content = JSON.stringify({ version: 1, notes: [{ path: 'a.md', content: '# A' }] });
  const put = await app.inject({
    method: 'PUT',
    url: GCS_OBJECT_URL,
    headers: { ...authHeader(), 'content-type': 'application/json' },
    payload: Buffer.from(content, 'utf8'),
  });
  assert.ok(
    [200, 201, 204].includes(put.statusCode),
    `unexpected status ${put.statusCode}: ${put.body}`,
  );

  const get = await app.inject({ method: 'GET', url: GCS_OBJECT_URL, headers: authHeader() });
  assert.equal(get.statusCode, 200, get.body);
  assert.equal(get.body, content);
});

test('GET returns 404 when the object has not been uploaded', async () => {
  const regRes = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'gcstest-empty@example.com', password: PASSWORD, deviceName: 'e' },
  });
  const tok = regRes.json().accessToken;
  await app.inject({
    method: 'POST',
    url: '/v1/storage/gcs/config',
    headers: { authorization: `Bearer ${tok}` },
    payload: { bucket: 'empty-bucket', accessId: 'id', secret: 'sec' },
  });
  const res = await app.inject({
    method: 'GET',
    url: GCS_OBJECT_URL,
    headers: { authorization: `Bearer ${tok}` },
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('DELETE removes the vault object', async () => {
  await app.inject({
    method: 'PUT',
    url: GCS_OBJECT_URL,
    headers: { ...authHeader(), 'content-type': 'application/json' },
    payload: Buffer.from('{"notes":[]}', 'utf8'),
  });
  const del = await app.inject({ method: 'DELETE', url: GCS_OBJECT_URL, headers: authHeader() });
  assert.equal(del.statusCode, 204, del.body);
});

test('proxy routes require auth', async () => {
  assert.equal((await app.inject({ method: 'GET', url: GCS_OBJECT_URL })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: 'PUT', url: GCS_OBJECT_URL, payload: Buffer.from('{}') }))
      .statusCode,
    401,
  );
});

test('proxy rejects any object key other than graphvault-vault.json (single-object restriction)', async () => {
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const res = await app.inject({
      method,
      url: '/v1/storage/gcs/object/some-other-file.json',
      headers: authHeader(),
      ...(method === 'PUT' ? { payload: Buffer.from('{}') } : {}),
    });
    assert.equal(res.statusCode, 400, `${method} other key should be 400, got ${res.statusCode}`);
  }
});

// ---------------------------------------------------------------------------
// Credential isolation + DELETE config
// ---------------------------------------------------------------------------

test('user B cannot read user A GCS config', async () => {
  const regA = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'gcsA@example.com', password: PASSWORD, deviceName: 'a' },
  });
  const tokenA = regA.json().accessToken;
  await app.inject({
    method: 'POST',
    url: '/v1/storage/gcs/config',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { bucket: 'bucketA', accessId: 'idA', secret: 'secA' },
  });

  const regB = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'gcsB@example.com', password: PASSWORD, deviceName: 'b' },
  });
  const tokenB = regB.json().accessToken;
  const configB = await app.inject({
    method: 'GET',
    url: '/v1/storage/gcs/config',
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(configB.statusCode, 404, 'user B should not see user A config');
});

test('DELETE /v1/storage/gcs/config removes the config and proxy 404s afterward', async () => {
  const del = await app.inject({
    method: 'DELETE',
    url: '/v1/storage/gcs/config',
    headers: authHeader(),
  });
  assert.equal(del.statusCode, 204, del.body);
  const get = await app.inject({
    method: 'GET',
    url: '/v1/storage/gcs/config',
    headers: authHeader(),
  });
  assert.equal(get.statusCode, 404);
  const proxy = await app.inject({ method: 'GET', url: GCS_OBJECT_URL, headers: authHeader() });
  assert.equal(proxy.statusCode, 404, proxy.body);
});
