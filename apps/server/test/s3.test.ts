/**
 * S3-compatible storage proxy route tests (M18).
 *
 * We mock the outbound `fetch` calls (the ones the S3Service makes to S3)
 * via a monkey-patch on `globalThis.fetch`, so no real S3 server is needed.
 *
 * We also test the pure SigV4 signing function independently.
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
import { signS3Request, buildS3ObjectUrl } from '../src/services/s3.js';

let app: FastifyInstance;
let dataDir: string;

const PASSWORD = 'secure-password-for-s3-tests';
let token = '';

// ---------------------------------------------------------------------------
// Fake S3 responses
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;
let originalFetch: FetchFn;

/** In-memory S3 "bucket": stores object content keyed by URL. */
const fakeS3Store = new Map<string, Buffer>();

function makeFakeS3Fetch(): FetchFn {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET') {
      const content = fakeS3Store.get(url);
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
      const body = init?.body;
      let buf: Buffer;
      if (body instanceof Uint8Array) {
        buf = Buffer.from(body);
      } else if (typeof body === 'string') {
        buf = Buffer.from(body, 'utf8');
      } else {
        buf = Buffer.alloc(0);
      }
      fakeS3Store.set(url, buf);
      return new Response(null, { status: 200 });
    }

    if (method === 'DELETE') {
      fakeS3Store.delete(url);
      return new Response(null, { status: 204 });
    }

    return new Response('Method not allowed', { status: 405 });
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gv-s3-test-'));
  const config = loadConfig({
    GRAPHVAULT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    GRAPHVAULT_RATE_LIMIT_MAX: '100000',
    GRAPHVAULT_AUTH_RATE_LIMIT_MAX: '100000',
  });
  app = await buildApp(config, { storage: new InMemoryStorage() });
  await app.ready();

  // Register a test user.
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 's3test@example.com', password: PASSWORD, deviceName: 'test' },
  });
  assert.equal(res.statusCode, 201, res.body);
  token = res.json().accessToken;

  // Swap out the real fetch with our fake.
  originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeS3Fetch();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  fakeS3Store.clear();
});

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

const S3_OBJECT_URL = '/v1/storage/s3/object/graphvault-vault.json';

// ---------------------------------------------------------------------------
// SigV4 unit tests
// ---------------------------------------------------------------------------

test('signS3Request produces an Authorization header with AWS4-HMAC-SHA256', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const result = signS3Request(
    {
      method: 'PUT',
      url: 'https://s3.us-east-1.amazonaws.com/my-bucket/graphvault-vault.json',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      payload: Buffer.from('{"notes":[]}', 'utf8'),
      extraHeaders: { 'content-type': 'application/json' },
    },
    now,
  );

  assert.ok(result.headers['authorization'], 'should have authorization header');
  assert.ok(
    result.headers['authorization'].startsWith('AWS4-HMAC-SHA256 '),
    `authorization should use AWS4-HMAC-SHA256, got: ${result.headers['authorization'].slice(0, 60)}`,
  );
  assert.ok(result.headers['x-amz-date'], 'should have x-amz-date header');
  assert.equal(result.headers['x-amz-date'], '20260615T120000Z');
  assert.ok(result.headers['x-amz-content-sha256'], 'should have x-amz-content-sha256 header');
  // Authorization must contain Credential, SignedHeaders, Signature.
  assert.ok(result.headers['authorization'].includes('Credential='));
  assert.ok(result.headers['authorization'].includes('SignedHeaders='));
  assert.ok(result.headers['authorization'].includes('Signature='));
  // host should NOT appear in the returned headers (fetch sets it automatically).
  assert.ok(!('host' in result.headers), 'host must not be in returned headers');
});

test('signS3Request is deterministic for a fixed time', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const params = {
    method: 'GET',
    url: 'https://s3.us-east-1.amazonaws.com/my-bucket/graphvault-vault.json',
    region: 'us-east-1',
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    payload: Buffer.alloc(0),
  };
  const r1 = signS3Request(params, now);
  const r2 = signS3Request(params, now);
  assert.equal(r1.headers['authorization'], r2.headers['authorization']);
  assert.equal(r1.headers['x-amz-date'], r2.headers['x-amz-date']);
});

test('signS3Request includes content-type in signed headers when provided', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const result = signS3Request(
    {
      method: 'PUT',
      url: 'https://s3.eu-west-1.amazonaws.com/bucket/key.json',
      region: 'eu-west-1',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      payload: Buffer.from('{}'),
      extraHeaders: { 'content-type': 'application/json' },
    },
    now,
  );
  // SignedHeaders in the auth header should include content-type.
  assert.ok(
    result.headers['authorization'].includes('content-type'),
    'SignedHeaders should include content-type',
  );
});

test('buildS3ObjectUrl uses AWS endpoint when no custom endpoint provided', () => {
  const url = buildS3ObjectUrl(undefined, 'us-east-1', 'my-bucket', 'graphvault-vault.json');
  assert.equal(url, 'https://s3.us-east-1.amazonaws.com/my-bucket/graphvault-vault.json');
});

test('buildS3ObjectUrl uses custom endpoint for S3-compatible providers', () => {
  const url = buildS3ObjectUrl(
    'https://abc123.r2.cloudflarestorage.com',
    'auto',
    'my-bucket',
    'graphvault-vault.json',
  );
  assert.equal(url, 'https://abc123.r2.cloudflarestorage.com/my-bucket/graphvault-vault.json');
});

test('buildS3ObjectUrl prepends prefix when provided', () => {
  const url = buildS3ObjectUrl(
    undefined,
    'us-east-1',
    'my-bucket',
    'graphvault-vault.json',
    'graphvault/',
  );
  assert.equal(
    url,
    'https://s3.us-east-1.amazonaws.com/my-bucket/graphvault/graphvault-vault.json',
  );
});

// ---------------------------------------------------------------------------
// Config endpoints
// ---------------------------------------------------------------------------

test('GET /v1/storage/s3/config returns 404 when not configured', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/s3/config',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('POST /v1/storage/s3/config stores config and returns 201', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/s3/config',
    headers: authHeader(),
    payload: {
      region: 'us-east-1',
      bucket: 'my-graphvault-bucket',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.ok(res.json().ok);
});

test('GET /v1/storage/s3/config returns non-secret info after config is set', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/s3/config',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.region, 'us-east-1');
  assert.equal(body.bucket, 'my-graphvault-bucket');
  assert.equal(body.accessKeyId, 'AKIAIOSFODNN7EXAMPLE');
  assert.ok(body.updatedAt, 'should have updatedAt timestamp');
  // Secret must NOT be returned.
  assert.ok(!('secretAccessKey' in body), 'secretAccessKey must not be in response');
  assert.ok(
    !('encryptedSecretAccessKey' in body),
    'encryptedSecretAccessKey must not be in response',
  );
});

test('POST /v1/storage/s3/config rejects invalid config (missing required fields)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/s3/config',
    headers: authHeader(),
    payload: {
      // Missing bucket and secretAccessKey
      region: 'us-east-1',
      accessKeyId: 'AKID',
    },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('POST /v1/storage/s3/config rejects invalid endpoint URL', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/s3/config',
    headers: authHeader(),
    payload: {
      endpoint: 'not-a-url',
      region: 'auto',
      bucket: 'bucket',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
    },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('POST /v1/storage/s3/config accepts optional endpoint and prefix', async () => {
  // Use a different user for this test to avoid state pollution.
  const regRes = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 's3test2@example.com', password: PASSWORD, deviceName: 'test2' },
  });
  const tok2 = regRes.json().accessToken;

  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/s3/config',
    headers: { authorization: `Bearer ${tok2}` },
    payload: {
      endpoint: 'https://abc.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'gv-bucket',
      accessKeyId: 'r2-key-id',
      secretAccessKey: 'r2-secret',
      prefix: 'notes/',
    },
  });
  assert.equal(res.statusCode, 201, res.body);

  // GET config — prefix should be returned (it's non-secret).
  const getRes = await app.inject({
    method: 'GET',
    url: '/v1/storage/s3/config',
    headers: { authorization: `Bearer ${tok2}` },
  });
  const body = getRes.json();
  assert.equal(body.endpoint, 'https://abc.r2.cloudflarestorage.com');
  assert.equal(body.prefix, 'notes/');
});

test('POST /v1/storage/s3/config requires auth', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/s3/config',
    payload: {
      region: 'us-east-1',
      bucket: 'bucket',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
    },
  });
  assert.equal(res.statusCode, 401);
});

// ---------------------------------------------------------------------------
// Object proxy endpoints
// ---------------------------------------------------------------------------

test('PUT /v1/storage/s3/object/graphvault-vault.json uploads to fake S3', async () => {
  const content = Buffer.from(JSON.stringify({ version: 1, notes: [] }), 'utf8');
  const res = await app.inject({
    method: 'PUT',
    url: S3_OBJECT_URL,
    headers: {
      ...authHeader(),
      'content-type': 'application/json',
    },
    payload: content,
  });
  assert.ok(
    [200, 201, 204].includes(res.statusCode),
    `unexpected status ${res.statusCode}: ${res.body}`,
  );
});

test('GET /v1/storage/s3/object/graphvault-vault.json retrieves uploaded content', async () => {
  const expected = JSON.stringify({
    version: 1,
    notes: [{ path: 'hello.md', content: '# Hi', mtime: 1, ctime: 1 }],
  });
  // PUT first.
  await app.inject({
    method: 'PUT',
    url: S3_OBJECT_URL,
    headers: { ...authHeader(), 'content-type': 'application/json' },
    payload: Buffer.from(expected, 'utf8'),
  });

  // GET it back.
  const res = await app.inject({
    method: 'GET',
    url: S3_OBJECT_URL,
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.body, expected);
});

test('GET /v1/storage/s3/object/graphvault-vault.json returns 404 when not uploaded', async () => {
  // Register a fresh user with S3 config but no object stored yet.
  const regRes = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 's3test3@example.com', password: PASSWORD, deviceName: 'test3' },
  });
  const tok3 = regRes.json().accessToken;

  await app.inject({
    method: 'POST',
    url: '/v1/storage/s3/config',
    headers: { authorization: `Bearer ${tok3}` },
    payload: {
      region: 'us-east-1',
      bucket: 'my-bucket',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
    },
  });

  // S3 returns 404 for this key (fake store is empty for this user's bucket key).
  const res = await app.inject({
    method: 'GET',
    url: S3_OBJECT_URL,
    headers: { authorization: `Bearer ${tok3}` },
  });
  // The fake S3 returns 404 for any URL not in the map.
  assert.equal(res.statusCode, 404, res.body);
});

test('DELETE /v1/storage/s3/object/graphvault-vault.json removes object', async () => {
  // PUT first.
  await app.inject({
    method: 'PUT',
    url: S3_OBJECT_URL,
    headers: { ...authHeader(), 'content-type': 'application/json' },
    payload: Buffer.from('{"notes":[]}', 'utf8'),
  });

  const del = await app.inject({
    method: 'DELETE',
    url: S3_OBJECT_URL,
    headers: authHeader(),
  });
  assert.equal(del.statusCode, 204, del.body);
});

test('proxy routes require auth', async () => {
  const get = await app.inject({ method: 'GET', url: S3_OBJECT_URL });
  assert.equal(get.statusCode, 401);

  const put = await app.inject({
    method: 'PUT',
    url: S3_OBJECT_URL,
    payload: Buffer.from('{}'),
  });
  assert.equal(put.statusCode, 401);
});

test('proxy rejects arbitrary object keys (only graphvault-vault.json is allowed)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/s3/object/../../etc/passwd',
    headers: authHeader(),
  });
  // Either 400 (rejected by our wildcard catch) or 404 (route not found) is acceptable.
  assert.ok([400, 404].includes(res.statusCode), `expected 400 or 404, got ${res.statusCode}`);
});

test('GET /v1/storage/s3/object/* for unknown key returns 400', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/s3/object/some-other-file.json',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 400, res.body);
});

// ---------------------------------------------------------------------------
// Credential isolation between users
// ---------------------------------------------------------------------------

test('user B cannot read user A S3 config', async () => {
  // Register user A and configure S3.
  const regA = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'userA-s3@example.com', password: PASSWORD, deviceName: 'a' },
  });
  const tokenA = regA.json().accessToken;

  await app.inject({
    method: 'POST',
    url: '/v1/storage/s3/config',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      region: 'us-east-1',
      bucket: 'userA-bucket',
      accessKeyId: 'AKID-A',
      secretAccessKey: 'SECRET-A',
    },
  });

  // Register user B (no S3 config).
  const regB = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'userB-s3@example.com', password: PASSWORD, deviceName: 'b' },
  });
  const tokenB = regB.json().accessToken;

  // User B reading config should get 404 (not A's config).
  const configB = await app.inject({
    method: 'GET',
    url: '/v1/storage/s3/config',
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(configB.statusCode, 404, 'user B should not see user A config');
});

// ---------------------------------------------------------------------------
// DELETE config
// ---------------------------------------------------------------------------

test('DELETE /v1/storage/s3/config removes the config', async () => {
  const del = await app.inject({
    method: 'DELETE',
    url: '/v1/storage/s3/config',
    headers: authHeader(),
  });
  assert.equal(del.statusCode, 204, del.body);

  // Config should be gone.
  const get = await app.inject({
    method: 'GET',
    url: '/v1/storage/s3/config',
    headers: authHeader(),
  });
  assert.equal(get.statusCode, 404);
});

test('proxy GET returns 404 (not configured) after config is deleted', async () => {
  const res = await app.inject({
    method: 'GET',
    url: S3_OBJECT_URL,
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 404, res.body);
});
