/**
 * @graphvault/sync-core
 *
 * A pure, environment-agnostic implementation of the GraphVault client sync
 * algorithm (see `docs/sync-protocol.md` §6-§7). It owns the SCAN → PULL →
 * PUSH → SETTLE cycle and deterministic conflict resolution, but knows nothing
 * about the filesystem, the browser, or HTTP: the host supplies a
 * {@link LocalVault} and a {@link RemoteApi} port and calls {@link runSync}.
 *
 * Like `@graphvault/engine`, nothing here imports React, the DOM, or
 * `node:fs` — only the shared wire types and a portable content hasher.
 */

export type { LocalEntry, LocalVault, RemoteApi } from './ports.js';
export type { ResolvedConflict, SyncOptions, SyncResult } from './types.js';
export { runSync } from './sync.js';
export { hashContent, byteLength } from './hash.js';
export { conflictCopyPath, conflictDate } from './conflict.js';
