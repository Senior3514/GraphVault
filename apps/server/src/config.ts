/**
 * Server configuration, sourced exclusively from environment variables so the
 * same image can be deployed anywhere. No telemetry endpoints exist.
 */

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
}

function storageBackend(value: string | undefined): StorageBackend {
  return value === 'postgres' ? 'postgres' : 'memory';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.GRAPHVAULT_HOST ?? '127.0.0.1',
    port: num(env.GRAPHVAULT_PORT, 4000),
    corsOrigin: env.GRAPHVAULT_CORS_ORIGIN ?? '*',
    dataDir: env.GRAPHVAULT_DATA_DIR ?? './storage',
    nodeEnv: env.NODE_ENV ?? 'development',
    storage: storageBackend(env.GRAPHVAULT_STORAGE),
    databaseUrl: env.DATABASE_URL,
    maxBlobBytes: num(env.GRAPHVAULT_MAX_BLOB_BYTES, 64 * 1024 * 1024),
  };
}
