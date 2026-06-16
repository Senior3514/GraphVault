/**
 * Production safety preflight.
 *
 * A pure, side-effect-free audit of a {@link ServerConfig} that catches insecure
 * or incoherent production setups *before* the server binds a socket. The goal is
 * fail-fast: a VPS deployment with `corsOrigin === '*'` or HTTPS disabled should
 * never come up, rather than silently serving over an open, plaintext API.
 *
 * Kept separate from `index.ts` so it can be unit-tested without booting Fastify
 * or touching the network. `index.ts` wires it into startup: in production, any
 * `errors` entry aborts the boot with a non-zero exit; `warnings` are printed but
 * do not block. In dev/test the checks are skipped entirely (see
 * {@link runPreflight}) so local http development is unaffected.
 */

import type { ServerConfig } from './config.js';

export interface PreflightResult {
  /** Misconfigurations that MUST block a production boot. */
  errors: string[];
  /** Risky-but-tolerable settings worth surfacing in logs. */
  warnings: string[];
}

/**
 * Audit a config for production safety. Pure: returns the findings, prints
 * nothing, exits nothing. The caller decides what to do with the result.
 *
 * Only meaningful when `nodeEnv === 'production'`; for any other environment it
 * returns no findings so dev/test behavior is unchanged.
 */
export function preflightConfig(config: ServerConfig, nodeEnv: string): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (nodeEnv !== 'production') {
    return { errors, warnings };
  }

  // CORS '*' in production lets any origin call the API with credentials and is
  // almost always a leftover dev default. Require an explicit allowlist.
  if (config.corsOrigin === '*') {
    errors.push(
      "GRAPHVAULT_CORS_ORIGIN is '*' in production. Set it to an explicit, " +
        'comma-separated allowlist of your web origins (e.g. https://notes.example.com).',
    );
  }

  // Disabling HTTPS enforcement in production means bearer tokens and note
  // content can travel in cleartext. The proxy terminates TLS and sets
  // X-Forwarded-Proto; keep enforcement on.
  if (config.requireHttps === false) {
    errors.push(
      'GRAPHVAULT_REQUIRE_HTTPS is false in production. Plaintext requests would ' +
        'be accepted; tokens and note content could travel in cleartext. Set ' +
        'GRAPHVAULT_REQUIRE_HTTPS=true and terminate TLS at your reverse proxy.',
    );
  }

  // Postgres backend without a DSN cannot connect; this is a hard misconfig.
  if (config.storage === 'postgres' && (config.databaseUrl ?? '').trim() === '') {
    errors.push(
      'GRAPHVAULT_STORAGE=postgres but DATABASE_URL is unset. Provide a PostgreSQL ' +
        'connection string for the postgres backend.',
    );
  }

  // Binding all interfaces without trusting the proxy means rate limiting keys on
  // the proxy IP and X-Forwarded-Proto is ignored — degraded, not unsafe.
  if ((config.host === '0.0.0.0' || config.host === '::') && config.trustProxy === false) {
    warnings.push(
      `GRAPHVAULT_HOST binds all interfaces (${config.host}) but ` +
        'GRAPHVAULT_TRUST_PROXY is false. Behind a reverse proxy, set ' +
        'GRAPHVAULT_TRUST_PROXY=true so client IPs (rate limiting) and ' +
        'X-Forwarded-Proto (HTTPS detection) are read correctly.',
    );
  }

  // No at-rest key means blob bytes sit as plaintext on disk; tolerable but
  // worth flagging on a shared/cloud VPS where the volume may be snapshotted.
  if (config.encryptionKey === undefined) {
    warnings.push(
      'GRAPHVAULT_ENCRYPTION_KEY is unset: blob bytes are stored as plaintext on ' +
        'disk. For at-rest encryption, generate a key with ' +
        '`openssl rand -base64 32` and back it up separately from the data.',
    );
  }

  return { errors, warnings };
}
