/**
 * Azure Blob Storage {@link StorageAdapter} — M18 (web client for Wave 16 server).
 *
 * Privacy model: the browser NEVER talks directly to Azure.
 * All operations are proxied through the user's self-hosted GraphVault server
 * (`/v1/storage/azure/object/graphvault-vault.json`). This means:
 *   - CORS is a non-issue (the server talks server-to-server).
 *   - The Azure account key stays on the server, encrypted at rest.
 *   - SharedKey request signing happens server-side (the browser never handles it).
 *   - The client only needs its GraphVault bearer token.
 *
 * Storage format: all notes are serialised as a single JSON document stored as
 * a single blob at a well-known key (`graphvault-vault.json`). This keeps the
 * proxy surface minimal and auditable — one PUT per save, one GET per load.
 *
 * Migration: switching to this adapter uses the same copy-verify-switch
 * pattern as other adapter migrations (see `migrationHelper.ts`).
 */

import type { Note } from '../types';
import type { StorageAdapter } from './index';
import { proxyClear, proxyIsAvailable, proxyLoad, proxySave } from './proxyAdapterHelpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The object key for the vault JSON in Azure Blob Storage. */
export const AZURE_VAULT_OBJECT_KEY = 'graphvault-vault.json';

/** Absolute proxy path for the single well-known vault object. */
const AZURE_OBJECT_PATH = `/v1/storage/azure/object/${AZURE_VAULT_OBJECT_KEY}`;

// ---------------------------------------------------------------------------
// AzureStorageAdapter
// ---------------------------------------------------------------------------

export class AzureStorageAdapter implements StorageAdapter {
  readonly id = 'azure';
  readonly label = 'Azure Blob Storage';

  /**
   * Available when:
   *   1. We are in a browser (not SSR/Node).
   *   2. A bearer token is present in sessionStorage (user is signed in).
   *
   * The server-side Azure config is checked lazily — `isAvailable()` must be
   * synchronous and cannot make a network request.
   */
  isAvailable(): boolean {
    return proxyIsAvailable();
  }

  /** Load notes from Azure via the GraphVault server proxy. */
  async load(): Promise<Note[]> {
    return proxyLoad('Azure', AZURE_OBJECT_PATH);
  }

  /** Save notes to Azure via the GraphVault server proxy. */
  async save(notes: Note[]): Promise<void> {
    return proxySave('Azure', AZURE_OBJECT_PATH, notes);
  }

  /**
   * Clear the vault by deleting the blob from Azure.
   *
   * If the blob does not exist (404), the operation is a no-op.
   */
  async clear(): Promise<void> {
    return proxyClear(AZURE_OBJECT_PATH);
  }
}

/**
 * Singleton adapter instance. Registered in the adapter registry by
 * `store.ts` so it is available to Settings and the vault provider.
 */
export const azureAdapter = new AzureStorageAdapter();
