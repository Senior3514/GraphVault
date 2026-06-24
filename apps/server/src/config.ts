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
  /**
   * Max body size in bytes for JSON / non-blob routes. Much smaller than
   * `maxBlobBytes` so a giant JSON payload to an auth or push route can't
   * exhaust memory; the blob PUT route opts into the larger `maxBlobBytes` cap
   * explicitly. Default 1 MiB.
   */
  maxJsonBytes: number;
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
  /**
   * Per-user/day request cap for the AI proxy endpoint.
   * 0 = unlimited (discouraged in production without key-level billing controls).
   * Default: 200.
   */
  aiDailyCap: number;
  /**
   * Max time (ms) the server waits to fully receive a request before aborting it.
   * Caps slow-client / Slowloris-style sockets that trickle bytes. Default 30s.
   */
  requestTimeoutMs: number;
  /**
   * How long (ms) an idle keep-alive connection is held open before the server
   * closes it. Should exceed any fronting proxy's keep-alive to avoid races.
   * Default 72s.
   */
  keepAliveTimeoutMs: number;
  /**
   * Max time (ms) a socket may stay open without the headers being completed.
   * 0 disables Node's HTTP `connectionsCheckingInterval`/timeout. Default 60s.
   */
  connectionTimeoutMs: number;
  /**
   * Max length of a single URL path parameter (e.g. a `:hash`). Bounds router
   * work and rejects absurdly long params early. Default 256.
   */
  maxParamLength: number;
  /**
   * Opt-in public graph-snapshot store. When false (the default) every
   * `/v1/snapshots*` route returns 404 — the feature is invisible. Snapshots are
   * unauthenticated public read-only shares of an opaque, already-encoded graph
   * payload, so the feature is off unless an operator explicitly enables it.
   */
  snapshotsEnabled: boolean;
  /** Max size in bytes of a single snapshot payload (the encoded string). */
  snapshotMaxBytes: number;
  /**
   * Max number of stored snapshots. When exceeded, the oldest snapshots are
   * evicted (oldest-first) so disk can't grow unbounded.
   */
  snapshotMaxCount: number;
  /**
   * Snapshot time-to-live, in days. Expired snapshots are swept on read and
   * never returned. 0 = no expiry.
   */
  snapshotTtlDays: number;
  /** Stricter per-window cap for `POST /v1/snapshots` to deter abuse. */
  snapshotRateLimitMax: number;
  /**
   * "Connect anything" inbound webhook. When false, every `/v1/inbox*` route
   * returns 404 (the feature is invisible). Defaults to ON because the inbound
   * endpoint does nothing until an authenticated user explicitly mints a token.
   */
  inboxEnabled: boolean;
  /** Max size in bytes of a single inbound note's rendered Markdown (413 over). */
  inboxMaxBytes: number;
  /** Stricter per-window cap for `POST /v1/inbox/:token` to deter abuse. */
  inboxRateLimitMax: number;
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
    maxJsonBytes: num(env.GRAPHVAULT_MAX_JSON_BYTES, 1024 * 1024),
    rateLimitMax: num(env.GRAPHVAULT_RATE_LIMIT_MAX, 300),
    rateLimitWindowMs: num(env.GRAPHVAULT_RATE_LIMIT_WINDOW, 60_000),
    authRateLimitMax: num(env.GRAPHVAULT_AUTH_RATE_LIMIT_MAX, 10),
    trustProxy: bool(env.GRAPHVAULT_TRUST_PROXY, false),
    requireHttps: bool(env.GRAPHVAULT_REQUIRE_HTTPS, isProduction),
    encryptionKey: encryptionKey(env.GRAPHVAULT_ENCRYPTION_KEY),
    aiDailyCap: num(env.GRAPHVAULT_AI_DAILY_CAP, 200),
    requestTimeoutMs: num(env.GRAPHVAULT_REQUEST_TIMEOUT_MS, 30_000),
    keepAliveTimeoutMs: num(env.GRAPHVAULT_KEEP_ALIVE_TIMEOUT_MS, 72_000),
    connectionTimeoutMs: num(env.GRAPHVAULT_CONNECTION_TIMEOUT_MS, 60_000),
    maxParamLength: num(env.GRAPHVAULT_MAX_PARAM_LENGTH, 256),
    snapshotsEnabled: bool(env.GRAPHVAULT_SNAPSHOTS_ENABLED, false),
    snapshotMaxBytes: num(env.GRAPHVAULT_SNAPSHOT_MAX_BYTES, 400_000),
    snapshotMaxCount: num(env.GRAPHVAULT_SNAPSHOT_MAX_COUNT, 5000),
    snapshotTtlDays: num(env.GRAPHVAULT_SNAPSHOT_TTL_DAYS, 30),
    snapshotRateLimitMax: num(env.GRAPHVAULT_SNAPSHOT_RATE_LIMIT_MAX, 20),
    inboxEnabled: bool(env.GRAPHVAULT_INBOX_ENABLED, true),
    inboxMaxBytes: num(env.GRAPHVAULT_INBOX_MAX_BYTES, 1_000_000),
    inboxRateLimitMax: num(env.GRAPHVAULT_INBOX_RATE_LIMIT_MAX, 30),
  };
}
