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
  updatedAt: string; // ISO-8601
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

/**
 * A dynamically-registered OAuth client (RFC 7591) - e.g. a remote MCP
 * connector like Claude.ai's "custom connector" self-registering against
 * this server. `clientSecretHash` is null for a public client (PKCE-only,
 * no secret); when present, only the SHA-256 hash is stored, same as every
 * other secret in this store.
 */
export interface OAuthClientRecord {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string[];
  createdAt: string; // ISO-8601
}

/**
 * A short-lived, single-use authorization code (RFC 6749 §4.1 + PKCE, RFC
 * 7636). Only the SHA-256 hash of the raw code is stored; `codeChallenge` is
 * the PKCE S256 challenge supplied at `/oauth/authorize` time, verified
 * against the client's `code_verifier` at token-exchange time.
 */
export interface OAuthAuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number; // unix epoch seconds
  createdAt: string; // ISO-8601
}

/**
 * One issued access+refresh token pair. Only hashes are stored. A refresh
 * exchange rotates the entire row (the old one is deleted, a new one
 * created) rather than reusing the access-token slot, so a stolen and
 * already-used refresh token is detectable (its row is simply gone).
 */
export interface OAuthTokenRecord {
  accessTokenHash: string;
  refreshTokenHash: string;
  clientId: string;
  userId: string;
  scope: string;
  accessExpiresAt: number; // unix epoch seconds
  createdAt: string; // ISO-8601
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

  // --- OAuth (remote MCP connector authorization server) ---
  createOAuthClient(record: OAuthClientRecord): Promise<void>;
  getOAuthClientById(clientId: string): Promise<OAuthClientRecord | null>;

  createOAuthAuthorizationCode(record: OAuthAuthorizationCodeRecord): Promise<void>;
  /**
   * Atomically fetch-and-delete a code by its hash (single-use). Returns
   * null if it doesn't exist (already consumed, or never issued) - the
   * caller is responsible for separately checking `expiresAt`.
   */
  consumeOAuthAuthorizationCode(codeHash: string): Promise<OAuthAuthorizationCodeRecord | null>;

  createOAuthToken(record: OAuthTokenRecord): Promise<void>;
  getOAuthTokenByAccessHash(accessTokenHash: string): Promise<OAuthTokenRecord | null>;
  getOAuthTokenByRefreshHash(refreshTokenHash: string): Promise<OAuthTokenRecord | null>;
  /** Delete a token row by its access-token hash (revocation, or superseded by rotation). */
  deleteOAuthTokenByAccessHash(accessTokenHash: string): Promise<void>;
}

export interface ChangesPage {
  changes: FileState[];
  hasMore: boolean;
}
