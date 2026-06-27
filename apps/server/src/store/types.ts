import type { FileState } from '@graphvault/shared';

/**
 * Persistence abstraction for the sync server.
 *
 * The interface is intentionally decoupled from Fastify and from any concrete
 * database so the service layer can be reused (e.g. by the desktop app's
 * embedded server) and unit-tested against {@link InMemoryStorage}. A
 * Prisma/PostgreSQL implementation lives behind a dynamic import so the default
 * in-memory path builds and runs without a live database.
 */

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string; // ISO-8601
}

export interface DeviceRecord {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  lastSeen: string;
}

export interface VaultRecord {
  id: string;
  userId: string;
  name: string;
  headRevision: number;
  createdAt: string;
}

/**
 * An opaque bearer token. Only the SHA-256 hash of the token is stored; the
 * raw token is returned to the client once at issue time.
 */
export interface TokenRecord {
  tokenHash: string;
  userId: string;
  deviceId: string;
  /** Unix epoch seconds. */
  expiresAt: number;
  createdAt: string;
}

/** Stored metadata for a content-addressed blob (the bytes live on disk). */
export interface BlobRecord {
  hash: string;
  size: number;
  createdAt: string;
}

/**
 * Persisted WebDAV configuration for a single user.
 *
 * The `password` field stores an AES-256-GCM ciphertext (base64). The raw
 * password is never written to the store; it exists only in the decrypted form
 * inside a running request. The `url` and `username` are stored in plaintext
 * because they are non-secret and displayed in the Settings UI.
 */
export interface WebDavConfigRecord {
  userId: string;
  url: string;
  username: string;
  /** AES-256-GCM encrypted password, base64-encoded (nonce||tag||ciphertext). */
  encryptedPassword: string;
  updatedAt: string; // ISO-8601
}

/**
 * Persisted S3-compatible storage configuration for a single user.
 *
 * The `secretAccessKey` field stores an AES-256-GCM ciphertext (base64). The
 * raw key is never written to the store; it exists only in decrypted form inside
 * a running request. All other fields are non-secret and displayed in Settings.
 */
export interface S3ConfigRecord {
  userId: string;
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  /** AES-256-GCM encrypted secretAccessKey, base64-encoded (nonce||tag||ciphertext). */
  encryptedSecretAccessKey: string;
  prefix?: string;
  updatedAt: string; // ISO-8601
}

/**
 * Persisted Azure Blob Storage configuration for a single user.
 *
 * The `accountKey` field stores an AES-256-GCM ciphertext (base64). The raw key
 * is never written to the store; it exists only in decrypted form inside a
 * running request. All other fields are non-secret and displayed in Settings.
 */
export interface AzureConfigRecord {
  userId: string;
  account: string;
  container: string;
  /** AES-256-GCM encrypted account key, base64-encoded (nonce||tag||ciphertext). */
  encryptedAccountKey: string;
  /** Optional endpoint override (e.g. Azurite). Omit for the public Azure host. */
  endpoint?: string;
  updatedAt: string; // ISO-8601
}

/**
 * Persisted Google Cloud Storage configuration for a single user.
 *
 * GCS is accessed via its S3-compatible XML API with HMAC interop credentials.
 * The `secret` field stores an AES-256-GCM ciphertext (base64). The raw secret
 * is never written to the store; it exists only in decrypted form inside a
 * running request. All other fields are non-secret and displayed in Settings.
 */
export interface GcsConfigRecord {
  userId: string;
  bucket: string;
  accessId: string;
  /** AES-256-GCM encrypted HMAC secret, base64-encoded (nonce||tag||ciphertext). */
  encryptedSecret: string;
  prefix?: string;
  updatedAt: string; // ISO-8601
}

/**
 * Persisted AI proxy configuration for a single user.
 *
 * The `apiKey` field stores an AES-256-GCM ciphertext (base64). The raw key is
 * never written to the store; it exists only in decrypted form during an outbound
 * AI call. All other fields are non-secret and may be shown in the Settings UI.
 *
 * gateway:
 *   - 'openrouter' (default): proxies to https://openrouter.ai/api/v1
 *   - 'custom': proxies to `baseUrl` (OpenAI-compatible endpoint)
 */
export interface AiConfigRecord {
  userId: string;
  /** AES-256-GCM encrypted API key, base64-encoded (nonce||tag||ciphertext). */
  encryptedApiKey: string;
  gateway: 'openrouter' | 'custom';
  /** Only set when gateway === 'custom'. */
  baseUrl?: string;
  /** Default model string (e.g. "openai/gpt-4o-mini" for OpenRouter). */
  model?: string;
  /**
   * Per-user/day monetary cap in USD. Undefined / 0 = no monetary cap. Stored
   * (non-secret) so the cap survives restart and the config GET can surface it.
   */
  spendCapUsd?: number;
  /**
   * Per-user/day request cap. Undefined falls back to the server's
   * GRAPHVAULT_AI_DAILY_CAP. 0 = unlimited.
   */
  dailyRequestCap?: number;
  updatedAt: string; // ISO-8601
}

/**
 * Durable per-user/day AI spend window. Replaces the old in-process daily
 * request counter so caps survive a restart. One row per user; the active
 * window is identified by `windowDate` (UTC "YYYY-MM-DD"). When a commit lands
 * on a new day the counters reset to a fresh window. Both the monetary cap
 * (`spentUsd` vs the config's `spendCapUsd`) and the request cap (`requests` vs
 * `dailyRequestCap` / `GRAPHVAULT_AI_DAILY_CAP`) are enforced against this row.
 * See `docs/ai-bff.md` §4.
 */
export interface AiSpendWindowRecord {
  userId: string;
  /** "YYYY-MM-DD" UTC - the active window. */
  windowDate: string;
  /** Requests committed in this window. */
  requests: number;
  /** Provider-reported USD cost accrued in this window (0 when none reported). */
  spentUsd: number;
  updatedAt: string; // ISO-8601
}

/**
 * A minted inbox ("connect anything") token, bound to one vault. Only the
 * SHA-256 hash of the raw token is stored (like the auth {@link TokenRecord});
 * the raw token is returned to the caller exactly once at creation.
 */
export interface InboxTokenRecord {
  id: string;
  userId: string;
  vaultId: string;
  label: string;
  /** SHA-256 hex of the raw token (never the raw token itself). */
  tokenHash: string;
  createdAt: string; // ISO-8601
  lastUsedAt: string | null;
}

/** One audit-log entry for an inbound webhook attempt (accepted or rejected). */
export interface InboxAuditRecord {
  id: string;
  userId: string;
  tokenId: string;
  source: string;
  /** The note path created (or attempted), or null for early rejects. */
  path: string | null;
  bytes: number;
  status: 'accepted' | 'rejected';
  at: string; // ISO-8601
}

/**
 * The current state of one file within a vault, plus the version history needed
 * for conflict recovery. `state` is the canonical wire representation.
 */
export interface FileRecord {
  state: FileState;
}

/** A single accepted file change to commit as part of an atomic push. */
export interface FileChange {
  path: string;
  hash: string | null;
  size: number;
  mtime: number;
  deleted: boolean;
}

export interface Storage {
  // --- users ---
  createUser(input: { id: string; email: string; passwordHash: string }): Promise<UserRecord>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserById(id: string): Promise<UserRecord | null>;

  // --- devices ---
  createDevice(input: { id: string; userId: string; name: string }): Promise<DeviceRecord>;
  getDevice(id: string): Promise<DeviceRecord | null>;
  touchDevice(id: string): Promise<void>;

  // --- tokens ---
  createToken(record: TokenRecord): Promise<void>;
  getToken(tokenHash: string): Promise<TokenRecord | null>;

  // --- vaults ---
  createVault(input: { id: string; userId: string; name: string }): Promise<VaultRecord>;
  getVault(id: string): Promise<VaultRecord | null>;
  listVaults(userId: string): Promise<VaultRecord[]>;

  // --- files / sync ---
  /** Current state of a single file in a vault, or null if never created. */
  getFile(vaultId: string, path: string): Promise<FileRecord | null>;
  /**
   * File states with `revision > since`, ordered ascending, capped at `limit`.
   * Returns one extra row's worth of awareness via {@link ChangesPage.hasMore}.
   */
  listChangesSince(vaultId: string, since: number, limit: number): Promise<ChangesPage>;
  /**
   * Commit a set of file changes atomically. Each change advances the vault
   * head by one and stamps that revision onto the file state. Returns the new
   * head revision. Implementations MUST apply all-or-nothing.
   */
  commitChanges(vaultId: string, changes: FileChange[]): Promise<number>;

  // --- blobs (metadata only; bytes are on disk) ---
  hasBlob(hash: string): Promise<boolean>;
  putBlob(record: BlobRecord): Promise<void>;

  // --- WebDAV configuration ---
  getWebDavConfig(userId: string): Promise<WebDavConfigRecord | null>;
  upsertWebDavConfig(record: WebDavConfigRecord): Promise<void>;
  deleteWebDavConfig(userId: string): Promise<void>;

  // --- S3 configuration ---
  getS3Config(userId: string): Promise<S3ConfigRecord | null>;
  upsertS3Config(record: S3ConfigRecord): Promise<void>;
  deleteS3Config(userId: string): Promise<void>;

  // --- Azure Blob Storage configuration ---
  getAzureConfig(userId: string): Promise<AzureConfigRecord | null>;
  upsertAzureConfig(record: AzureConfigRecord): Promise<void>;
  deleteAzureConfig(userId: string): Promise<void>;

  // --- Google Cloud Storage configuration ---
  getGcsConfig(userId: string): Promise<GcsConfigRecord | null>;
  upsertGcsConfig(record: GcsConfigRecord): Promise<void>;
  deleteGcsConfig(userId: string): Promise<void>;

  // --- AI proxy configuration ---
  getAiConfig(userId: string): Promise<AiConfigRecord | null>;
  upsertAiConfig(record: AiConfigRecord): Promise<void>;
  deleteAiConfig(userId: string): Promise<void>;

  // --- AI durable spend/request window ---
  /**
   * The user's current spend window, or null if none has been committed yet.
   * Callers must treat a window whose `windowDate !== today` as empty (lazy
   * reset) - the stored row is only rolled over on the next {@link commitAiSpend}.
   */
  getAiSpendWindow(userId: string): Promise<AiSpendWindowRecord | null>;
  /**
   * Atomically add `addUsd` and `addRequests` to the user's window for `today`
   * (UTC "YYYY-MM-DD"). When the stored window predates `today` it is reset to a
   * fresh window before adding. Returns the post-commit record.
   */
  commitAiSpend(
    userId: string,
    addUsd: number,
    addRequests: number,
    today: string,
  ): Promise<AiSpendWindowRecord>;

  // --- inbox ("connect anything") tokens ---
  createInboxToken(record: InboxTokenRecord): Promise<void>;
  /** Resolve an inbox token by its SHA-256 hash (the inbound lookup key). */
  getInboxTokenByHash(tokenHash: string): Promise<InboxTokenRecord | null>;
  /** A user's tokens, oldest-first. */
  listInboxTokens(userId: string): Promise<InboxTokenRecord[]>;
  /** Stamp lastUsedAt onto a token (by hash). No-op if it no longer exists. */
  touchInboxToken(tokenHash: string, lastUsedAt: string): Promise<void>;
  /**
   * Delete the user's token with the given id. Returns true if a row was
   * removed, false if it didn't exist or isn't the caller's (→ 404 upstream).
   */
  deleteInboxToken(userId: string, tokenId: string): Promise<boolean>;

  // --- inbox audit log (capped per user, oldest evicted) ---
  /**
   * Append an audit entry, then enforce the per-user cap by evicting the
   * oldest entries beyond `cap`.
   */
  appendInboxAudit(record: InboxAuditRecord, cap: number): Promise<void>;
  /** A user's audit entries, newest-first. */
  listInboxAudit(userId: string): Promise<InboxAuditRecord[]>;
}

export interface ChangesPage {
  changes: FileState[];
  hasMore: boolean;
}
