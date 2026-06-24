/**
 * Google Cloud Storage {@link StorageAdapter} — M18 (web client for Wave 16 server).
 *
 * Privacy model: the browser NEVER talks directly to GCS.
 * All operations are proxied through the user's self-hosted GraphVault server
 * (`/v1/storage/gcs/object/graphvault-vault.json`). This means:
 *   - CORS is a non-issue (the server talks server-to-server).
 *   - The GCS HMAC interop secret stays on the server, encrypted at rest.
 *   - Request signing happens server-side (the browser never handles it).
 *   - The client only needs its GraphVault bearer token.
 *
 * Storage format: all notes are serialised as a single JSON document stored as
 * a single object at a well-known key (`graphvault-vault.json`). This keeps the
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

/** The object key for the vault JSON in Google Cloud Storage. */
export const GCS_VAULT_OBJECT_KEY = 'graphvault-vault.json';

/** Absolute proxy path for the single well-known vault object. */
const GCS_OBJECT_PATH = `/v1/storage/gcs/object/${GCS_VAULT_OBJECT_KEY}`;

// ---------------------------------------------------------------------------
// GcsStorageAdapter
// ---------------------------------------------------------------------------

export class GcsStorageAdapter implements StorageAdapter {
  readonly id = 'gcs';
  readonly label = 'Google Cloud Storage';

  /**
   * Available when:
   *   1. We are in a browser (not SSR/Node).
   *   2. A bearer token is present in sessionStorage (user is signed in).
   *
   * The server-side GCS config is checked lazily — `isAvailable()` must be
   * synchronous and cannot make a network request.
   */
  isAvailable(): boolean {
    return proxyIsAvailable();
  }

  /** Load notes from GCS via the GraphVault server proxy. */
  async load(): Promise<Note[]> {
    return proxyLoad('GCS', GCS_OBJECT_PATH);
  }

  /** Save notes to GCS via the GraphVault server proxy. */
  async save(notes: Note[]): Promise<void> {
    return proxySave('GCS', GCS_OBJECT_PATH, notes);
  }

  /**
   * Clear the vault by deleting the object from GCS.
   *
   * If the object does not exist (404), the operation is a no-op.
   */
  async clear(): Promise<void> {
    return proxyClear(GCS_OBJECT_PATH);
  }
}

/**
 * Singleton adapter instance. Registered in the adapter registry by
 * `store.ts` so it is available to Settings and the vault provider.
 */
export const gcsAdapter = new GcsStorageAdapter();
