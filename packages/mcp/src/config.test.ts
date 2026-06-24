/**
 * Config validation tests. Configuration comes from env only and must fail
 * fast with a clear, secret-free message.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, DEFAULT_INDEX_TTL_MS, loadConfig } from './config.js';

const BASE_ENV = {
  GRAPHVAULT_SERVER_URL: 'https://vault.example.com/',
  GRAPHVAULT_TOKEN: 'secret',
  GRAPHVAULT_VAULT_ID: 'v1',
};

test('loadConfig parses a valid env and strips a trailing slash', () => {
  const cfg = loadConfig({ ...BASE_ENV } as NodeJS.ProcessEnv);
  assert.equal(cfg.serverUrl, 'https://vault.example.com');
  assert.equal(cfg.token, 'secret');
  assert.equal(cfg.vaultId, 'v1');
  assert.equal(cfg.indexTtlMs, DEFAULT_INDEX_TTL_MS);
});

test('loadConfig accepts a vault name instead of an id', () => {
  const cfg = loadConfig({
    GRAPHVAULT_SERVER_URL: 'https://vault.example.com',
    GRAPHVAULT_TOKEN: 'secret',
    GRAPHVAULT_VAULT_NAME: 'Personal',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.vaultId, undefined);
  assert.equal(cfg.vaultName, 'Personal');
});

test('loadConfig requires either a vault id or name', () => {
  assert.throws(
    () =>
      loadConfig({
        GRAPHVAULT_SERVER_URL: 'https://vault.example.com',
        GRAPHVAULT_TOKEN: 'secret',
      } as NodeJS.ProcessEnv),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /GRAPHVAULT_VAULT_ID or GRAPHVAULT_VAULT_NAME/);
      return true;
    },
  );
});

test('loadConfig rejects a missing token and never echoes secrets', () => {
  assert.throws(
    () =>
      loadConfig({
        GRAPHVAULT_SERVER_URL: 'https://vault.example.com',
        GRAPHVAULT_VAULT_ID: 'v1',
      } as NodeJS.ProcessEnv),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /GRAPHVAULT_TOKEN/);
      // The secret-free message must not contain any token value.
      assert.ok(!err.message.includes('secret'));
      return true;
    },
  );
});

test('loadConfig rejects a malformed server URL', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, GRAPHVAULT_SERVER_URL: 'not-a-url' } as NodeJS.ProcessEnv),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /must be a valid URL/);
      return true;
    },
  );
});

test('loadConfig coerces a custom index TTL', () => {
  const cfg = loadConfig({ ...BASE_ENV, GRAPHVAULT_INDEX_TTL_MS: '5000' } as NodeJS.ProcessEnv);
  assert.equal(cfg.indexTtlMs, 5000);
});

test('loadConfig leaves deviceId undefined when GRAPHVAULT_DEVICE_ID is unset (writes off)', () => {
  const cfg = loadConfig({ ...BASE_ENV } as NodeJS.ProcessEnv);
  assert.equal(cfg.deviceId, undefined);
});

test('loadConfig reads GRAPHVAULT_DEVICE_ID for writes', () => {
  const cfg = loadConfig({ ...BASE_ENV, GRAPHVAULT_DEVICE_ID: 'device-1' } as NodeJS.ProcessEnv);
  assert.equal(cfg.deviceId, 'device-1');
});
