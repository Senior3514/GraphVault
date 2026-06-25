/**
 * S3-compatible storage {@link StorageAdapter} — M18.
 *
 * Privacy model: the browser NEVER talks directly to an S3 server.
 * All operations are proxied through the user's self-hosted GraphVault server
 * (`/v1/storage/s3/object/graphvault-vault.json`). This means:
 *   - CORS is a non-issue (the server talks server-to-server).
 *   - S3 credentials stay on the server, encrypted at rest.
 *   - AWS SigV4 signing happens server-side (the browser never handles it).
 *   - The client only needs its GraphVault bearer token.
 *
 * Works with AWS S3, MinIO, Cloudflare R2, Backblaze B2, and any
 * S3-compatible provider (the server handles the provider-specific signing).
 *
 * Storage format: all notes are serialised as a single JSON document stored
 * as a single S3 object at a well-known key (`graphvault-vault.json`). This
 * keeps the proxy surface minimal and auditable — one PUT per save, one GET
 * per load.
 *
 * Migration: switching to this adapter uses the same copy-verify-switch
 * pattern as other adapter migrations (see `migrationHelper.ts`).
 */

import { AUTH_TOKEN_STORAGE_KEY, SERVER_URL_STORAGE_KEY } from '../../api/storageKeys';
import type { Note } from '../types';
import type { StorageAdapter } from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The object key for the vault JSON in S3. */
export const S3_VAULT_OBJECT_KEY = 'graphvault-vault.json';

/** Fallback server URL (matches the client default). */
const DEFAULT_SERVER_URL = 'http://127.0.0.1:4000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the bearer token from sessionStorage (the key `useAuth` writes). */
function getToken(): string | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Read the server URL from localStorage (the key `useServerSettings` writes). */
function getServerUrl(): string {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_SERVER_URL;
    return localStorage.getItem(SERVER_URL_STORAGE_KEY) ?? DEFAULT_SERVER_URL;
  } catch {
    return DEFAULT_SERVER_URL;
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** Narrow-cast guard: ensures a value has the shape of a {@link Note}. */
function isNote(value: unknown): value is Note {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === 'string' &&
    typeof v.content === 'string' &&
    typeof v.mtime === 'number' &&
    typeof v.ctime === 'number'
  );
}

// ---------------------------------------------------------------------------
// Serialisation (same format as WebDAV adapter for portability)
// ---------------------------------------------------------------------------

interface VaultDocument {
  version: 1;
  savedAt: string;
  notes: Note[];
}

function serialise(notes: Note[]): string {
  const doc: VaultDocument = {
    version: 1,
    savedAt: new Date().toISOString(),
    notes,
  };
  return JSON.stringify(doc);
}

function deserialise(json: string): Note[] {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SyntaxError('Invalid vault document (not an object)');
  }
  const doc = parsed as Record<string, unknown>;
  if (Array.isArray(doc)) {
    return (doc as unknown[]).filter(isNote);
  }
  if (!Array.isArray(doc.notes)) {
    throw new SyntaxError('Invalid vault document (missing notes array)');
  }
  return (doc.notes as unknown[]).filter(isNote);
}

// ---------------------------------------------------------------------------
// S3StorageAdapter
// ---------------------------------------------------------------------------

export class S3StorageAdapter implements StorageAdapter {
  readonly id = 's3';
  readonly label = 'S3-compatible storage (via server proxy)';

  /**
   * Available when:
   *   1. We are in a browser (not SSR/Node).
   *   2. A bearer token is present in sessionStorage (user is signed in).
   *
   * The server-side S3 config is checked lazily — `isAvailable()` must be
   * synchronous and cannot make a network request.
   */
  isAvailable(): boolean {
    if (typeof sessionStorage === 'undefined') return false;
    return !!getToken();
  }

  /** Load notes from S3 via the GraphVault server proxy. */
  async load(): Promise<Note[]> {
    const token = getToken();
    if (!token) {
      throw new Error(
        'S3 adapter: not signed in. Sign in to a GraphVault server in Settings.',
      );
    }
    const serverUrl = getServerUrl();
    const url = joinUrl(serverUrl, `/v1/storage/s3/object/${S3_VAULT_OBJECT_KEY}`);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new Error(
        `S3 adapter: network error loading vault — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 404 means the vault object does not exist yet in S3 — treat as empty.
    if (res.status === 404) {
      return [];
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`S3 adapter: load failed (HTTP ${res.status}): ${body}`);
    }

    const text = await res.text();
    try {
      return deserialise(text);
    } catch (err) {
      throw new Error(
        `S3 adapter: vault document is corrupt — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Save notes to S3 via the GraphVault server proxy. */
  async save(notes: Note[]): Promise<void> {
    const token = getToken();
    if (!token) {
      throw new Error('S3 adapter: not signed in.');
    }
    const serverUrl = getServerUrl();
    const url = joinUrl(serverUrl, `/v1/storage/s3/object/${S3_VAULT_OBJECT_KEY}`);
    const body = serialise(notes);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      throw new Error(
        `S3 adapter: network error saving vault — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw new Error(`S3 adapter: save failed (HTTP ${res.status}): ${errorBody}`);
    }
  }

  /**
   * Clear the vault by deleting the object from S3.
   *
   * If the object does not exist (404), the operation is a no-op.
   */
  async clear(): Promise<void> {
    const token = getToken();
    if (!token) return; // Nothing to do if not signed in.
    const serverUrl = getServerUrl();
    const url = joinUrl(serverUrl, `/v1/storage/s3/object/${S3_VAULT_OBJECT_KEY}`);

    try {
      await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      // Ignore the response — DELETE is best-effort in clear().
    } catch {
      // Network errors in clear() are silently ignored.
    }
  }
}

/**
 * Singleton adapter instance. Registered in the adapter registry by
 * `store.ts` so it is available to Settings and the vault provider.
 */
export const s3Adapter = new S3StorageAdapter();
