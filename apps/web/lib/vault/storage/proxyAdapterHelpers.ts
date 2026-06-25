/**
 * Shared helpers for server-proxy {@link StorageAdapter}s — M18.
 *
 * The WebDAV, S3, Azure Blob, and GCS adapters all share the exact same
 * mechanics: read the GraphVault bearer token + server URL from sessionStorage,
 * serialise the full note list into a single `graphvault-vault.json` document,
 * and proxy load/save/clear through the user's self-hosted server. Only the
 * proxy URL path differs per provider.
 *
 * This module factors out that common machinery so each concrete adapter stays
 * a thin, declarative wrapper (id/label + the proxy path) with no duplicated
 * token/serialisation logic. It is intentionally apps/web-local (no new
 * dependency) and SSR-safe (every sessionStorage access is guarded).
 */

import { AUTH_TOKEN_STORAGE_KEY, SERVER_URL_STORAGE_KEY } from '../../api/storageKeys';
import type { Note } from '../types';

/** Fallback server URL (matches the client default). */
const DEFAULT_SERVER_URL = 'http://127.0.0.1:4000';

/**
 * Read the GraphVault bearer token from sessionStorage (the SAME tier + key
 * `useAuth` writes). Returns `null` during SSR (no `sessionStorage`) or when the
 * user is not signed in.
 */
export function getToken(): string | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Read the configured server URL from localStorage (the SAME tier + key
 * `useServerSettings` writes), falling back to the client default.
 */
export function getServerUrl(): string {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_SERVER_URL;
    return localStorage.getItem(SERVER_URL_STORAGE_KEY) ?? DEFAULT_SERVER_URL;
  } catch {
    return DEFAULT_SERVER_URL;
  }
}

/** Join a base URL and an absolute path, collapsing any trailing slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** Narrow-cast guard: ensures a value has the shape of a {@link Note}. */
export function isNote(value: unknown): value is Note {
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
// Serialisation (same format across all storage adapters for portability)
// ---------------------------------------------------------------------------

interface VaultDocument {
  version: 1;
  savedAt: string;
  notes: Note[];
}

/** Serialise a full note list into the canonical vault JSON document. */
export function serialise(notes: Note[]): string {
  const doc: VaultDocument = {
    version: 1,
    savedAt: new Date().toISOString(),
    notes,
  };
  return JSON.stringify(doc);
}

/**
 * Parse a vault JSON document back into a note list. Accepts both a
 * {@link VaultDocument} (version: 1) and a bare array (legacy). Throws a
 * `SyntaxError` on malformed input.
 */
export function deserialise(json: string): Note[] {
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
// Proxy load/save/clear
// ---------------------------------------------------------------------------

/**
 * Load notes from a server-proxy object endpoint.
 *
 * @param providerLabel  Human-readable provider name used in error messages
 *                       (e.g. `"Azure"`).
 * @param objectPath     Absolute proxy path, e.g.
 *                       `/v1/storage/azure/object/graphvault-vault.json`.
 *
 * A 404 means the vault object does not exist yet — treated as an empty vault.
 */
export async function proxyLoad(providerLabel: string, objectPath: string): Promise<Note[]> {
  const token = getToken();
  if (!token) {
    throw new Error(
      `${providerLabel} adapter: not signed in. Sign in to a GraphVault server in Settings.`,
    );
  }
  const url = joinUrl(getServerUrl(), objectPath);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new Error(
      `${providerLabel} adapter: network error loading vault — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 404 means the vault object does not exist yet — treat as empty.
  if (res.status === 404) {
    return [];
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${providerLabel} adapter: load failed (HTTP ${res.status}): ${body}`);
  }

  const text = await res.text();
  try {
    return deserialise(text);
  } catch (err) {
    throw new Error(
      `${providerLabel} adapter: vault document is corrupt — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Save notes to a server-proxy object endpoint (single PUT). */
export async function proxySave(
  providerLabel: string,
  objectPath: string,
  notes: Note[],
): Promise<void> {
  const token = getToken();
  if (!token) {
    throw new Error(`${providerLabel} adapter: not signed in.`);
  }
  const url = joinUrl(getServerUrl(), objectPath);
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
      `${providerLabel} adapter: network error saving vault — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`${providerLabel} adapter: save failed (HTTP ${res.status}): ${errorBody}`);
  }
}

/**
 * Clear the vault by deleting the object via the server proxy.
 *
 * Best-effort: returns silently when not signed in, and swallows network
 * errors (matches the S3/WebDAV `clear()` semantics).
 */
export async function proxyClear(objectPath: string): Promise<void> {
  const token = getToken();
  if (!token) return; // Nothing to do if not signed in.
  const url = joinUrl(getServerUrl(), objectPath);

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

/**
 * Synchronous availability check shared by every server-proxy adapter:
 * available iff we are in a browser (sessionStorage exists) and a bearer token
 * is present. Server-side config is verified lazily on the first load.
 */
export function proxyIsAvailable(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  return !!getToken();
}
