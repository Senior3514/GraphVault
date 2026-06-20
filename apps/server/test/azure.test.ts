/**
 * Azure Blob Storage proxy route + signing tests (Wave 16).
 *
 * We mock the outbound `fetch` calls (the ones AzureService makes to Azure) via
 * a monkey-patch on `globalThis.fetch`, so no real Azure account is needed. The
 * Shared Key signing is also tested independently against a fixed, known vector.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { InMemoryStorage } from '../src/store/memory.js';
import {
  signAzureRequest,
  buildAzureBlobUrl,
  azureDate,
  AZURE_API_VERSION,
} from '../src/services/azure.js';
import {
  __setResolverForTests,
  __setTransportForTests,
  type GuardedTransport,
  type ResolveAllFn,
} from '../src/services/ssrf.js';

let app: FastifyInstance;
let dataDir: string;

const PASSWORD = 'secure-password-for-azure-tests';
let token = '';

// ---------------------------------------------------------------------------
// Fake Azure Blob responses
// ---------------------------------------------------------------------------

let restoreTransport: (() => void) | undefined;
let restoreResolver: (() => void) | undefined;

/** In-memory Azure "container": object content keyed by URL. */
const fakeStore = new Map<string, Buffer>();

function makeFakeAzureFetch(): GuardedTransport {
  return async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();

    if (method === 'GET') {
      const content = fakeStore.get(url);
      if (!content) {
        return new Response('BlobNotFound', { status: 404 });
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
      return new Response(null, { status: 201 });
    }
    if (method === 'DELETE') {
      fakeStore.delete(url);
      return new Response(null, { status: 202 });
    }
    return new Response('Method not allowed', { status: 405 });
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gv-azure-test-'));
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
    payload: { email: 'azuretest@example.com', password: PASSWORD, deviceName: 'test' },
  });
  assert.equal(res.statusCode, 201, res.body);
  token = res.json().accessToken;

  restoreTransport = __setTransportForTests(makeFakeAzureFetch());
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

const AZURE_OBJECT_URL = '/v1/storage/azure/object/graphvault-vault.json';

// A fixed, valid base64 account key for deterministic signing tests.
const ACCOUNT_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

// ---------------------------------------------------------------------------
// Shared Key signing unit tests (deterministic, fixed date)
// ---------------------------------------------------------------------------

test('signAzureRequest builds the exact StringToSign per the Azure spec (GET)', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const url = buildAzureBlobUrl('devstoreaccount1', 'vault', 'graphvault-vault.json');
  const signed = signAzureRequest(
    {
      method: 'GET',
      url,
      account: 'devstoreaccount1',
      accountKey: ACCOUNT_KEY,
      payload: Buffer.alloc(0),
    },
    now,
  );

  const expectedStringToSign =
    'GET\n\n\n\n\n\n\n\n\n\n\n\n' +
    'x-ms-date:Mon, 15 Jun 2026 12:00:00 GMT\n' +
    `x-ms-version:${AZURE_API_VERSION}\n` +
    '/devstoreaccount1/vault/graphvault-vault.json';
  assert.equal(signed.stringToSign, expectedStringToSign);

  // Independently recompute the HMAC to confirm the Authorization header.
  const expectedSig = createHmac('sha256', Buffer.from(ACCOUNT_KEY, 'base64'))
    .update(expectedStringToSign, 'utf8')
    .digest('base64');
  assert.equal(signed.headers['authorization'], `SharedKey devstoreaccount1:${expectedSig}`);
  assert.equal(signed.headers['x-ms-date'], 'Mon, 15 Jun 2026 12:00:00 GMT');
  assert.equal(signed.headers['x-ms-version'], AZURE_API_VERSION);
  // host must NOT be in the returned headers (fetch sets it).
  assert.ok(!('host' in signed.headers), 'host must not be in returned headers');
});

test('signAzureRequest signs Content-Type and x-ms-blob-type on PUT', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const url = buildAzureBlobUrl('devstoreaccount1', 'vault', 'graphvault-vault.json');
  const payload = Buffer.from('{"notes":[]}', 'utf8');
  const signed = signAzureRequest(
    {
      method: 'PUT',
      url,
      account: 'devstoreaccount1',
      accountKey: ACCOUNT_KEY,
      payload,
      contentType: 'application/json',
      msHeaders: { 'x-ms-blob-type': 'BlockBlob' },
    },
    now,
  );

  const expectedStringToSign =
    'PUT\n\n\n' +
    String(payload.length) +
    '\n\napplication/json\n\n\n\n\n\n\n' +
    'x-ms-blob-type:BlockBlob\n' +
    'x-ms-date:Mon, 15 Jun 2026 12:00:00 GMT\n' +
    `x-ms-version:${AZURE_API_VERSION}\n` +
    '/devstoreaccount1/vault/graphvault-vault.json';
  assert.equal(signed.stringToSign, expectedStringToSign);
  assert.equal(signed.headers['x-ms-blob-type'], 'BlockBlob');
  assert.equal(signed.headers['content-type'], 'application/json');
  assert.equal(signed.headers['content-length'], String(payload.length));
});

test('signAzureRequest is deterministic for a fixed time', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const params = {
    method: 'GET' as const,
    url: buildAzureBlobUrl('acct', 'c', 'graphvault-vault.json'),
    account: 'acct',
    accountKey: ACCOUNT_KEY,
    payload: Buffer.alloc(0),
  };
  const r1 = signAzureRequest(params, now);
  const r2 = signAzureRequest(params, now);
  assert.equal(r1.headers['authorization'], r2.headers['authorization']);
});

test('azureDate produces an RFC-1123 GMT string', () => {
  assert.equal(azureDate(new Date('2026-06-15T12:00:00Z')), 'Mon, 15 Jun 2026 12:00:00 GMT');
});

test('buildAzureBlobUrl defaults to the public Azure host', () => {
  assert.equal(
    buildAzureBlobUrl('acct', 'cont', 'graphvault-vault.json'),
    'https://acct.blob.core.windows.net/cont/graphvault-vault.json',
  );
});

test('buildAzureBlobUrl honors an endpoint override (Azurite)', () => {
  assert.equal(
    buildAzureBlobUrl(
      'devstoreaccount1',
      'cont',
      'graphvault-vault.json',
      'http://127.0.0.1:10000/devstoreaccount1',
    ),
    'http://127.0.0.1:10000/devstoreaccount1/cont/graphvault-vault.json',
  );
});

// ---------------------------------------------------------------------------
// Config endpoints
// ---------------------------------------------------------------------------

test('GET /v1/storage/azure/config returns 404 when not configured', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/azure/config',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('POST /v1/storage/azure/config stores config and returns 201', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/azure/config',
    headers: authHeader(),
    payload: {
      account: 'mygraphvault',
      container: 'vault',
      accountKey: ACCOUNT_KEY,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.ok(res.json().ok);
});

test('GET /v1/storage/azure/config returns non-secret info; secret is NEVER returned', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/storage/azure/config',
    headers: authHeader(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.account, 'mygraphvault');
  assert.equal(body.container, 'vault');
  assert.ok(body.updatedAt);
  // The account key must never leave the server in any form.
  assert.ok(!('accountKey' in body), 'accountKey must not be in response');
  assert.ok(!('encryptedAccountKey' in body), 'encryptedAccountKey must not be in response');
  assert.ok(!JSON.stringify(body).includes(ACCOUNT_KEY), 'plaintext key must not appear anywhere');
});

test('POST /v1/storage/azure/config rejects missing required fields', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/azure/config',
    headers: authHeader(),
    payload: { account: 'mygraphvault' }, // missing container + accountKey
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('POST /v1/storage/azure/config rejects a non-base64 account key', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/azure/config',
    headers: authHeader(),
    payload: { account: 'acct', container: 'vault', accountKey: '' },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('POST /v1/storage/azure/config accepts an optional endpoint override', async () => {
  const regRes = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'azuretest-ep@example.com', password: PASSWORD, deviceName: 'ep' },
  });
  const tok = regRes.json().accessToken;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/azure/config',
    headers: { authorization: `Bearer ${tok}` },
    payload: {
      account: 'devstoreaccount1',
      container: 'vault',
      accountKey: ACCOUNT_KEY,
      endpoint: 'http://127.0.0.1:10000/devstoreaccount1',
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const getRes = await app.inject({
    method: 'GET',
    url: '/v1/storage/azure/config',
    headers: { authorization: `Bearer ${tok}` },
  });
  assert.equal(getRes.json().endpoint, 'http://127.0.0.1:10000/devstoreaccount1');
});

test('POST /v1/storage/azure/config requires auth', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/storage/azure/config',
    payload: { account: 'a', container: 'c', accountKey: ACCOUNT_KEY },
  });
  assert.equal(res.statusCode, 401);
});

// ---------------------------------------------------------------------------
// Object proxy endpoints
// ---------------------------------------------------------------------------

test('PUT then GET round-trips the vault blob through the Azure proxy', async () => {
  const content = JSON.stringify({ version: 1, notes: [{ path: 'a.md', content: '# A' }] });
  const put = await app.inject({
    method: 'PUT',
    url: AZURE_OBJECT_URL,
    headers: { ...authHeader(), 'content-type': 'application/json' },
    payload: Buffer.from(content, 'utf8'),
  });
  assert.ok(
    [200, 201, 204].includes(put.statusCode),
    `unexpected status ${put.statusCode}: ${put.body}`,
  );

  const get = await app.inject({ method: 'GET', url: AZURE_OBJECT_URL, headers: authHeader() });
  assert.equal(get.statusCode, 200, get.body);
  assert.equal(get.body, content);
});

test('GET returns 404 when the blob has not been uploaded', async () => {
  const regRes = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'azuretest-empty@example.com', password: PASSWORD, deviceName: 'e' },
  });
  const tok = regRes.json().accessToken;
  await app.inject({
    method: 'POST',
    url: '/v1/storage/azure/config',
    headers: { authorization: `Bearer ${tok}` },
    payload: { account: 'emptyacct', container: 'vault', accountKey: ACCOUNT_KEY },
  });
  const res = await app.inject({
    method: 'GET',
    url: AZURE_OBJECT_URL,
    headers: { authorization: `Bearer ${tok}` },
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('DELETE removes the vault blob', async () => {
  await app.inject({
    method: 'PUT',
    url: AZURE_OBJECT_URL,
    headers: { ...authHeader(), 'content-type': 'application/json' },
    payload: Buffer.from('{"notes":[]}', 'utf8'),
  });
  const del = await app.inject({ method: 'DELETE', url: AZURE_OBJECT_URL, headers: authHeader() });
  assert.equal(del.statusCode, 204, del.body);
});

test('proxy routes require auth', async () => {
  assert.equal((await app.inject({ method: 'GET', url: AZURE_OBJECT_URL })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: 'PUT', url: AZURE_OBJECT_URL, payload: Buffer.from('{}') }))
      .statusCode,
    401,
  );
});

test('proxy rejects any object key other than graphvault-vault.json (single-object restriction)', async () => {
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const res = await app.inject({
      method,
      url: '/v1/storage/azure/object/some-other-file.json',
      headers: authHeader(),
      ...(method === 'PUT' ? { payload: Buffer.from('{}') } : {}),
    });
    assert.equal(res.statusCode, 400, `${method} other key should be 400, got ${res.statusCode}`);
  }
});

// ---------------------------------------------------------------------------
// Credential isolation + DELETE config
// ---------------------------------------------------------------------------

test('user B cannot read user A Azure config', async () => {
  const regA = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'azureA@example.com', password: PASSWORD, deviceName: 'a' },
  });
  const tokenA = regA.json().accessToken;
  await app.inject({
    method: 'POST',
    url: '/v1/storage/azure/config',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { account: 'acctA', container: 'vault', accountKey: ACCOUNT_KEY },
  });

  const regB = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'azureB@example.com', password: PASSWORD, deviceName: 'b' },
  });
  const tokenB = regB.json().accessToken;
  const configB = await app.inject({
    method: 'GET',
    url: '/v1/storage/azure/config',
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(configB.statusCode, 404, 'user B should not see user A config');
});

test('DELETE /v1/storage/azure/config removes the config and proxy 404s afterward', async () => {
  const del = await app.inject({
    method: 'DELETE',
    url: '/v1/storage/azure/config',
    headers: authHeader(),
  });
  assert.equal(del.statusCode, 204, del.body);
  const get = await app.inject({
    method: 'GET',
    url: '/v1/storage/azure/config',
    headers: authHeader(),
  });
  assert.equal(get.statusCode, 404);
  const proxy = await app.inject({ method: 'GET', url: AZURE_OBJECT_URL, headers: authHeader() });
  assert.equal(proxy.statusCode, 404, proxy.body);
});
