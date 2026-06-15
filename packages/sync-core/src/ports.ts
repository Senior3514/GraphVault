/**
 * Host-provided ports for the sync engine.
 *
 * `@graphvault/sync-core` is environment-agnostic: it knows the sync *algorithm*
 * (spec §6-§7) but nothing about how the host stores files or talks to the
 * server. The host wires up these two small interfaces and the engine drives
 * them. The web client backs them with `VaultStore` + `GraphVaultClient`; the
 * desktop client will back them with a real filesystem + the same HTTP client.
 */

import type {
  ChangesResponse,
  FilePath,
  LocalFileEntry,
  PushRequest,
  PushResponse,
} from '@graphvault/shared';

/** A file as it exists in the host's local storage right now. */
export interface LocalEntry {
  /** Vault-relative POSIX path. */
  path: FilePath;
  /** `sha256:<hex>` of the current content, or null for a deletion/tombstone. */
  hash: string | null;
  /** Raw content bytes as a string. Absent for deletions. */
  content?: string;
  /** Epoch ms of last local modification. */
  mtime: number;
  /** True when the file has been locally deleted (tombstone). */
  deleted: boolean;
}

/**
 * The host's local vault: content storage plus the sync index
 * (path → `LocalFileEntry`). All methods may be async so a host can back them
 * with IndexedDB, the filesystem, or anything else.
 */
export interface LocalVault {
  /** Every live local file (deleted files are surfaced via the index, not here). */
  listEntries(): Promise<LocalEntry[]> | LocalEntry[];

  /** Read raw content for a path, or null if it does not exist locally. */
  readContent(path: FilePath): Promise<string | null> | string | null;

  /** Create or overwrite content for a path with the given mtime. */
  writeContent(path: FilePath, content: string, mtime: number): Promise<void> | void;

  /** Remove the content for a path (the tombstone lives in the index). */
  deleteContent(path: FilePath): Promise<void> | void;

  /** Read the entire local sync index (path → entry). */
  readIndex(): Promise<LocalFileEntry[]> | LocalFileEntry[];

  /** Persist the entire local sync index, replacing the previous contents. */
  writeIndex(entries: LocalFileEntry[]): Promise<void> | void;
}

/**
 * The subset of server calls the sync engine needs, typed with the shared wire
 * schemas. The host adapts these to HTTP (auth headers, base URL, retries).
 */
export interface RemoteApi {
  /** GET /v1/vaults/:id/changes — pull file states with `revision > since`. */
  getChanges(vaultId: string, since: number, limit?: number): Promise<ChangesResponse>;

  /** POST /v1/vaults/:id/push — push local ops, get applied/conflicts back. */
  push(vaultId: string, body: PushRequest): Promise<PushResponse>;

  /** HEAD /v1/blobs/:hash — true if the server already has this blob. */
  hasBlob(hash: string): Promise<boolean>;

  /** PUT /v1/blobs/:hash — upload content bytes for `hash`. */
  putBlob(hash: string, content: string): Promise<void>;

  /** GET /v1/blobs/:hash — download content bytes for `hash`. */
  getBlob(hash: string): Promise<string>;
}
