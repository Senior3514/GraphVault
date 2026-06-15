/**
 * Server configuration, sourced exclusively from environment variables so the
 * same image can be deployed anywhere. No telemetry endpoints exist.
 */

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Decode and validate the optional at-rest encryption key. When set it must be
 * base64-encoded and decode to exactly 32 bytes (AES-256). A malformed key is a
 * fatal misconfiguration — fail fast rather than silently store plaintext.
 */
function encryptionKey(value: string | undefined): Buffer | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const raw = value.trim();
  // Buffer.from(..., 'base64') silently drops invalid characters rather than
  // throwing, so validate the alphabet explicitly and round-trip to be sure.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error('GRAPHVAULT_ENCRYPTION_KEY must be valid base64');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, '')) {
    throw new Error('GRAPHVAULT_ENCRYPTION_KEY must be valid base64');
  }
  if (key.length !== 32) {
    throw new Error(
      `GRAPHVAULT_ENCRYPTION_KEY must decode to 32 bytes (AES-256); got ${key.length}`,
    );
  }
  return key;
}

/** Which {@link Storage} backend to use. */
export type StorageBackend = 'memory' | 'postgres';

export interface ServerConfig {
  host: string;
  port: number;
  /** Comma-separated allowed origins for CORS, or '*' in development. */
  corsOrigin: string;
  /** Where file blobs and the database live on disk. */
  dataDir: string;
  nodeEnv: string;
  /** Persistence backend; defaults to in-memory for dev/test. */
  storage: StorageBackend;
  /** PostgreSQL connection string (required when storage === 'postgres'). */
  databaseUrl: string | undefined;
  /**
   * Max blob upload size in bytes. Caps request body size for blob PUTs so a
   * single upload can't exhaust memory. Default 64 MiB.
   */
  maxBlobBytes: number;
  /** Max requests per window per client for general routes (rate limiting). */
  rateLimitMax: number;
  /** Rate-limit window, in milliseconds. */
  rateLimitWindowMs: number;
  /** Stricter per-window cap for `/v1/auth/*` (credential-stuffing defense). */
  authRateLimitMax: number;
  /**
   * Trust `X-Forwarded-*` headers from a fronting reverse proxy. Required for
   * correct client IPs (rate limiting) and HTTPS detection behind a proxy.
   */
  trustProxy: boolean;
  /**
   * Require secure transport. When true, plaintext requests are rejected unless
   * `X-Forwarded-Proto: https` is present (TLS terminated at the proxy).
   * Defaults to on in production, off otherwise so local http dev still works.
   */
  requireHttps: boolean;
  /**
   * Optional 32-byte AES-256 key for transparent at-rest blob encryption.
   * Undefined means blobs are stored as plaintext (unchanged legacy behavior).
   */
  encryptionKey: Buffer | undefined;
}

function storageBackend(value: string | undefined): StorageBackend {
  return value === 'postgres' ? 'postgres' : 'memory';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  return {
    host: env.GRAPHVAULT_HOST ?? '127.0.0.1',
    port: num(env.GRAPHVAULT_PORT, 4000),
    corsOrigin: env.GRAPHVAULT_CORS_ORIGIN ?? '*',
    dataDir: env.GRAPHVAULT_DATA_DIR ?? './storage',
    nodeEnv,
    storage: storageBackend(env.GRAPHVAULT_STORAGE),
    databaseUrl: env.DATABASE_URL,
    maxBlobBytes: num(env.GRAPHVAULT_MAX_BLOB_BYTES, 64 * 1024 * 1024),
    rateLimitMax: num(env.GRAPHVAULT_RATE_LIMIT_MAX, 300),
    rateLimitWindowMs: num(env.GRAPHVAULT_RATE_LIMIT_WINDOW, 60_000),
    authRateLimitMax: num(env.GRAPHVAULT_AUTH_RATE_LIMIT_MAX, 10),
    trustProxy: bool(env.GRAPHVAULT_TRUST_PROXY, false),
    requireHttps: bool(env.GRAPHVAULT_REQUIRE_HTTPS, isProduction),
    encryptionKey: encryptionKey(env.GRAPHVAULT_ENCRYPTION_KEY),
  };
}
