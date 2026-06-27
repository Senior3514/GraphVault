/**
 * WebDAV-backed {@link StorageAdapter} - M18.
 *
 * Privacy model: the browser NEVER talks directly to a WebDAV server.
 * All operations are proxied through the user's self-hosted GraphVault server
 * (`/v1/storage/webdav/proxy/*`). This means:
 *   - CORS is a non-issue (the server talks server-to-server).
 *   - WebDAV credentials stay on the server, encrypted at rest.
 *   - The client only needs its GraphVault bearer token.
 *
 * Storage format: all notes are serialised as a single JSON document stored
 * at a well-known path on the WebDAV server (`graphvault-vault.json`). This
 * keeps the proxy surface minimal and auditable - one PUT per save, one GET
 * per load.
 *
 * Availability guard: the adapter is available only when the user is signed in
 * to a GraphVault server (a bearer token is present in sessionStorage) AND the
 * server has WebDAV configured for their account. `isAvailable()` is a
 * synchronous best-effort check based on the token presence; actual
 * availability (server config) is determined lazily on the first `load()`.
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

/** The single file path used to store the vault JSON on the WebDAV server. */
export const WEBDAV_VAULT_FILENAME = 'graphvault-vault.json';

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
// Serialisation
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
  // Support both a VaultDocument (version: 1) and a bare array (legacy).
  if (Array.isArray(doc)) {
    return (doc as unknown[]).filter(isNote);
  }
  if (!Array.isArray(doc.notes)) {
    throw new SyntaxError('Invalid vault document (missing notes array)');
  }
  return (doc.notes as unknown[]).filter(isNote);
}

// ---------------------------------------------------------------------------
// WebDavStorageAdapter
// ---------------------------------------------------------------------------

export class WebDavStorageAdapter implements StorageAdapter {
  readonly id = 'webdav';
  readonly label = 'WebDAV (via server proxy)';

  /**
   * Available when:
   *   1. We are in a browser (not SSR/Node).
   *   2. A bearer token is present in sessionStorage (user is signed in).
   *
   * The server-side WebDAV config is checked lazily - `isAvailable()` must be
   * synchronous and cannot make a network request.
   */
  isAvailable(): boolean {
    if (typeof sessionStorage === 'undefined') return false;
    return !!getToken();
  }

  /** Load notes from the WebDAV server via the GraphVault proxy. */
  async load(): Promise<Note[]> {
    const token = getToken();
    if (!token) {
      throw new Error(
        'WebDAV adapter: not signed in. Sign in to a GraphVault server in Settings.',
      );
    }
    const serverUrl = getServerUrl();
    const url = joinUrl(serverUrl, `/v1/storage/webdav/proxy/${WEBDAV_VAULT_FILENAME}`);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new Error(
        `WebDAV adapter: network error loading vault - ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 404 means the vault does not exist yet on WebDAV - treat as empty.
    if (res.status === 404) {
      return [];
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`WebDAV adapter: load failed (HTTP ${res.status}): ${body}`);
    }

    const text = await res.text();
    try {
      return deserialise(text);
    } catch (err) {
      throw new Error(
        `WebDAV adapter: vault document is corrupt - ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Save notes to the WebDAV server via the GraphVault proxy. */
  async save(notes: Note[]): Promise<void> {
    const token = getToken();
    if (!token) {
      throw new Error('WebDAV adapter: not signed in.');
    }
    const serverUrl = getServerUrl();
    const url = joinUrl(serverUrl, `/v1/storage/webdav/proxy/${WEBDAV_VAULT_FILENAME}`);
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
        `WebDAV adapter: network error saving vault - ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw new Error(`WebDAV adapter: save failed (HTTP ${res.status}): ${errorBody}`);
    }
  }

  /**
   * Clear the vault by deleting the document from WebDAV.
   *
   * This sends a DELETE to the proxy. If the file does not exist (404), the
   * operation is treated as a no-op (already cleared).
   */
  async clear(): Promise<void> {
    const token = getToken();
    if (!token) return; // Nothing to do if not signed in.
    const serverUrl = getServerUrl();
    const url = joinUrl(serverUrl, `/v1/storage/webdav/proxy/${WEBDAV_VAULT_FILENAME}`);

    try {
      await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      // Ignore the response - DELETE is best-effort in clear().
    } catch {
      // Network errors in clear() are silently ignored.
    }
  }
}

/**
 * Singleton adapter instance. Registered in the adapter registry by
 * `store.ts` so it is available to Settings and the vault provider.
 *
 * It does NOT auto-register itself here - registration happens in `store.ts`
 * so the module graph stays acyclic.
 */
export const webdavAdapter = new WebDavStorageAdapter();
