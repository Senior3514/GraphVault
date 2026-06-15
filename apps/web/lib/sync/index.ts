/**
 * Web sync wiring: adapters that back `@graphvault/sync-core`'s ports with the
 * browser vault + the GraphVault HTTP client, plus the `useSync` hook the
 * `/sync-status` page consumes.
 */

export { createLocalVault, SYNC_INDEX_KEY, type VaultMutator } from './localVault';
export { createRemoteApi, type RemoteApiConfig } from './remoteApi';
export { loadSyncMeta, saveSyncMeta, SYNC_META_KEY, type SyncMeta } from './syncMeta';
export { useSync, type UseSync, type UseSyncOptions, type SyncStatus } from './useSync';
