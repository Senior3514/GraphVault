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
}

export interface ChangesPage {
  changes: FileState[];
  hasMore: boolean;
}
