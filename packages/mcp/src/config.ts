/**
 * Configuration for the GraphVault MCP server.
 *
 * All configuration comes from environment variables only (no hardcoded
 * secrets, no config files). Values are validated with zod and the server
 * fails fast with a clear, actionable message when something is missing or
 * malformed. The bearer token is never echoed back in error messages or logs.
 */

import { z } from 'zod';

/**
 * Raw environment schema. We keep the URL/token/id required and allow an
 * optional vault *name* that can resolve to an id at startup via
 * `GET /v1/vaults`.
 */
const envSchema = z.object({
  /** Base URL of the self-hosted GraphVault server, e.g. `https://vault.example.com`. */
  GRAPHVAULT_SERVER_URL: z
    .string()
    .min(1, 'GRAPHVAULT_SERVER_URL is required')
    .url('GRAPHVAULT_SERVER_URL must be a valid URL (e.g. https://vault.example.com)'),
  /** Bearer token issued by the GraphVault server. Never logged. */
  GRAPHVAULT_TOKEN: z.string().min(1, 'GRAPHVAULT_TOKEN is required'),
  /** The vault id to expose. Optional when GRAPHVAULT_VAULT_NAME is given. */
  GRAPHVAULT_VAULT_ID: z.string().min(1).optional(),
  /** Resolve the vault id by name via GET /v1/vaults when no id is supplied. */
  GRAPHVAULT_VAULT_NAME: z.string().min(1).optional(),
  /**
   * Index cache time-to-live in milliseconds. After this the index is
   * rebuilt on the next tool call so agents see recent edits. Default 30s.
   */
  GRAPHVAULT_INDEX_TTL_MS: z.coerce.number().int().positive().optional(),
});

/** Validated, normalized configuration consumed by the rest of the server. */
export interface McpConfig {
  serverUrl: string;
  token: string;
  vaultId: string | undefined;
  vaultName: string | undefined;
  indexTtlMs: number;
}

/** Default index cache TTL (30 seconds). */
export const DEFAULT_INDEX_TTL_MS = 30_000;

/**
 * Thrown when the environment is invalid. The message is safe to print: it
 * never includes the value of {@link McpConfig.token}.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse and validate configuration from a raw environment record.
 *
 * @throws {ConfigError} with a human-readable, secret-free message.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid GraphVault MCP configuration:\n${issues}`);
  }

  const data = parsed.data;
  if (data.GRAPHVAULT_VAULT_ID === undefined && data.GRAPHVAULT_VAULT_NAME === undefined) {
    throw new ConfigError(
      'Invalid GraphVault MCP configuration:\n' +
        '  - one of GRAPHVAULT_VAULT_ID or GRAPHVAULT_VAULT_NAME must be set',
    );
  }

  // Normalize the base URL by stripping any trailing slash so we can join
  // paths consistently.
  const serverUrl = data.GRAPHVAULT_SERVER_URL.replace(/\/+$/, '');

  return {
    serverUrl,
    token: data.GRAPHVAULT_TOKEN,
    vaultId: data.GRAPHVAULT_VAULT_ID,
    vaultName: data.GRAPHVAULT_VAULT_NAME,
    indexTtlMs: data.GRAPHVAULT_INDEX_TTL_MS ?? DEFAULT_INDEX_TTL_MS,
  };
}
