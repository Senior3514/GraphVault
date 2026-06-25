import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { preflightConfig } from '../src/preflight.js';
import { InMemoryStorage } from '../src/store/memory.js';

/**
 * Build a production-shaped config from env, defaulting to a SAFE production
 * setup so each test can override exactly the one field it is exercising.
 */
function prodConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'production',
    GRAPHVAULT_CORS_ORIGIN: 'https://notes.example.com',
    GRAPHVAULT_REQUIRE_HTTPS: 'true',
    GRAPHVAULT_TRUST_PROXY: 'true',
    GRAPHVAULT_HOST: '127.0.0.1',
    GRAPHVAULT_STORAGE: 'memory',
    GRAPHVAULT_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    ...overrides,
  });
}

test('preflight: a valid production config produces no errors or warnings', () => {
  const result = preflightConfig(prodConfig(), 'production');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('preflight: CORS "*" in production is an error', () => {
  const result = preflightConfig(prodConfig({ GRAPHVAULT_CORS_ORIGIN: '*' }), 'production');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /GRAPHVAULT_CORS_ORIGIN/);
});

test('preflight: REQUIRE_HTTPS=false in production is an error', () => {
  const result = preflightConfig(prodConfig({ GRAPHVAULT_REQUIRE_HTTPS: 'false' }), 'production');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /GRAPHVAULT_REQUIRE_HTTPS/);
});

test('preflight: postgres backend without DATABASE_URL is an error', () => {
  const result = preflightConfig(prodConfig({ GRAPHVAULT_STORAGE: 'postgres' }), 'production');
  assert.ok(
    result.errors.some((e) => /DATABASE_URL/.test(e)),
    JSON.stringify(result.errors),
  );
});

test('preflight: postgres backend WITH DATABASE_URL passes', () => {
  const result = preflightConfig(
    prodConfig({
      GRAPHVAULT_STORAGE: 'postgres',
      DATABASE_URL: 'postgresql://u:p@db:5432/graphvault',
    }),
    'production',
  );
  assert.deepEqual(result.errors, []);
});

test('preflight: binding 0.0.0.0 without trustProxy is a warning, not an error', () => {
  const result = preflightConfig(
    prodConfig({ GRAPHVAULT_HOST: '0.0.0.0', GRAPHVAULT_TRUST_PROXY: 'false' }),
    'production',
  );
  assert.deepEqual(result.errors, []);
  assert.ok(
    result.warnings.some((w) => /GRAPHVAULT_TRUST_PROXY/.test(w)),
    JSON.stringify(result.warnings),
  );
});

test('preflight: missing encryptionKey is a warning, not an error', () => {
  const result = preflightConfig(prodConfig({ GRAPHVAULT_ENCRYPTION_KEY: '' }), 'production');
  assert.deepEqual(result.errors, []);
  assert.ok(
    result.warnings.some((w) => /GRAPHVAULT_ENCRYPTION_KEY/.test(w)),
    JSON.stringify(result.warnings),
  );
});

test('preflight: multiple insecure settings accumulate multiple errors', () => {
  const result = preflightConfig(
    prodConfig({
      GRAPHVAULT_CORS_ORIGIN: '*',
      GRAPHVAULT_REQUIRE_HTTPS: 'false',
      GRAPHVAULT_STORAGE: 'postgres',
    }),
    'production',
  );
  assert.equal(result.errors.length, 3);
});

test('preflight: dev/test environments are never flagged (insecure config tolerated)', () => {
  // The most insecure possible config, but loopback-bound and not production
  // -> no findings, so local http development is unaffected.
  const insecure = loadConfig({
    NODE_ENV: 'development',
    GRAPHVAULT_CORS_ORIGIN: '*',
    GRAPHVAULT_REQUIRE_HTTPS: 'false',
    GRAPHVAULT_HOST: '127.0.0.1',
  });
  assert.deepEqual(preflightConfig(insecure, 'development'), { errors: [], warnings: [] });
  assert.deepEqual(preflightConfig(insecure, 'test'), { errors: [], warnings: [] });

  // Default host (unset) is loopback-equivalent and also clean.
  const defaultHost = loadConfig({
    NODE_ENV: 'development',
    GRAPHVAULT_CORS_ORIGIN: '*',
    GRAPHVAULT_REQUIRE_HTTPS: 'false',
  });
  assert.deepEqual(preflightConfig(defaultHost, 'development'), { errors: [], warnings: [] });
});

// --- NEW: fail-fast when exposed off-box even without NODE_ENV=production ---

test('preflight: CORS "*" on a non-loopback host is an error even in dev', () => {
  // A self-hoster on a VPS with NODE_ENV unset, binding 0.0.0.0, with the
  // leftover open-CORS default. This must fail fast.
  const config = loadConfig({
    NODE_ENV: 'development',
    GRAPHVAULT_CORS_ORIGIN: '*',
    GRAPHVAULT_REQUIRE_HTTPS: 'true',
    GRAPHVAULT_HOST: '0.0.0.0',
  });
  const result = preflightConfig(config, 'development');
  assert.ok(
    result.errors.some((e) => /GRAPHVAULT_CORS_ORIGIN/.test(e)),
    JSON.stringify(result.errors),
  );
  // The error explains it is the public bind, not NODE_ENV, that triggered it.
  assert.ok(
    result.errors.some((e) => /non-loopback/.test(e)),
    JSON.stringify(result.errors),
  );
});

test('preflight: REQUIRE_HTTPS=false on a non-loopback host is an error even in dev', () => {
  const config = loadConfig({
    NODE_ENV: 'development',
    GRAPHVAULT_CORS_ORIGIN: 'https://notes.example.com',
    GRAPHVAULT_REQUIRE_HTTPS: 'false',
    GRAPHVAULT_HOST: '0.0.0.0',
  });
  const result = preflightConfig(config, 'development');
  assert.ok(
    result.errors.some((e) => /GRAPHVAULT_REQUIRE_HTTPS/.test(e)),
    JSON.stringify(result.errors),
  );
});

test('preflight: a concrete public IP host (not 0.0.0.0) also triggers exposure checks', () => {
  const config = loadConfig({
    NODE_ENV: 'development',
    GRAPHVAULT_CORS_ORIGIN: '*',
    GRAPHVAULT_REQUIRE_HTTPS: 'false',
    GRAPHVAULT_HOST: '203.0.113.10',
  });
  const result = preflightConfig(config, 'development');
  assert.equal(result.errors.length, 2, JSON.stringify(result.errors));
});

test('preflight: a SAFE config on a non-loopback host in dev produces no errors', () => {
  // Exposed off-box but with an explicit allowlist + HTTPS enforced: clean.
  const config = loadConfig({
    NODE_ENV: 'development',
    GRAPHVAULT_CORS_ORIGIN: 'https://notes.example.com',
    GRAPHVAULT_REQUIRE_HTTPS: 'true',
    GRAPHVAULT_HOST: '0.0.0.0',
    GRAPHVAULT_TRUST_PROXY: 'true',
  });
  const result = preflightConfig(config, 'development');
  assert.deepEqual(result.errors, []);
});

// --- new connection-hardening / body-limit config parsing ---

test('config: connection hardening fields have safe defaults', () => {
  const config = loadConfig({});
  assert.equal(config.requestTimeoutMs, 30_000);
  assert.equal(config.keepAliveTimeoutMs, 72_000);
  assert.equal(config.connectionTimeoutMs, 60_000);
  assert.equal(config.maxParamLength, 256);
  assert.equal(config.maxJsonBytes, 1024 * 1024);
});

test('config: connection hardening fields are env-overridable', () => {
  const config = loadConfig({
    GRAPHVAULT_REQUEST_TIMEOUT_MS: '5000',
    GRAPHVAULT_KEEP_ALIVE_TIMEOUT_MS: '6000',
    GRAPHVAULT_CONNECTION_TIMEOUT_MS: '7000',
    GRAPHVAULT_MAX_PARAM_LENGTH: '64',
    GRAPHVAULT_MAX_JSON_BYTES: '2048',
  });
  assert.equal(config.requestTimeoutMs, 5000);
  assert.equal(config.keepAliveTimeoutMs, 6000);
  assert.equal(config.connectionTimeoutMs, 7000);
  assert.equal(config.maxParamLength, 64);
  assert.equal(config.maxJsonBytes, 2048);
});

// --- runtime smoke: a prod-like app still serves /v1/health 200 ---

test('smoke: a production-shaped app boots and serves /v1/health 200', async () => {
  let app: FastifyInstance | undefined;
  const dir = await mkdtemp(join(tmpdir(), 'gv-preflight-'));
  try {
    const config = loadConfig({
      GRAPHVAULT_DATA_DIR: dir,
      NODE_ENV: 'production',
      GRAPHVAULT_CORS_ORIGIN: 'https://notes.example.com',
      GRAPHVAULT_REQUIRE_HTTPS: 'true',
      GRAPHVAULT_TRUST_PROXY: 'true',
    });
    // The config is clean per the preflight.
    assert.deepEqual(preflightConfig(config, 'production').errors, []);

    app = await buildApp(config, { storage: new InMemoryStorage() });
    await app.ready();

    // With REQUIRE_HTTPS, a plaintext probe with the proxy header set passes.
    const health = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(health.statusCode, 200, health.body);
    assert.equal(health.json().status, 'ok');

    // server-info reports the new JSON limit alongside the blob cap.
    const info = await app.inject({
      method: 'GET',
      url: '/v1/server-info',
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(info.statusCode, 200);
    assert.equal(info.json().maxJsonBytes, config.maxJsonBytes);
    assert.equal(info.json().requireHttps, true);
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
