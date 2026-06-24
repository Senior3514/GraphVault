/**
 * Server-backed SHORT graph share links (Wave 18).
 *
 * The graph "Share" button always produces a giant self-contained
 * `/embed?s=<encoded>` URL (see `snapshot.ts`). This module adds an OPTIONAL,
 * shorter `/embed?id=<id>&srv=<serverOrigin>` link backed by the server's
 * opt-in snapshot store. The long `s=` link remains the always-available
 * fallback; this is pure progressive enhancement.
 *
 * Server contract (apps/server/src/routes/snapshots.ts + services/snapshot.ts):
 *   - GET    /v1/server-info           → includes `snapshots: { enabled, maxBytes }`
 *   - POST   /v1/snapshots {data}      → 201 { id, deleteToken } | 400 | 413
 *   - GET    /v1/snapshots/:id         → 200 { id, data, createdAt } | 404
 *
 * The `data` we upload is the SAME opaque, already-encoded snapshot string the
 * long-link path produces (`encodeSnapshot`) — titles + topology only, never
 * note content. The server treats it as opaque text.
 *
 * Security note (SSRF / junk guard): the embed page reads the `srv` origin from
 * an attacker-controllable URL the recipient clicked. `normalizeServerOrigin`
 * validates it is a well-formed http(s) URL before any fetch is made, rejecting
 * anything else (file:, javascript:, data:, garbage). Only the origin is kept —
 * any path/query/hash a crafted link carried is discarded.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The `snapshots` posture block from `GET /v1/server-info`. */
export interface ServerSnapshotConfig {
  enabled: boolean;
  maxBytes: number;
}

/** What `POST /v1/snapshots` returns. */
export interface UploadedSnapshot {
  id: string;
  deleteToken: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the encoded snapshot exceeds the server's short-link size cap
 * (HTTP 413). The long `s=` link is still available as a fallback.
 */
export class ShareLinkTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareLinkTooLargeError';
  }
}

/** Thrown for any other short-link operation failure (network, 4xx/5xx, 404). */
export class ShareLinkError extends Error {
  constructor(
    message: string,
    readonly status: number = 0,
  ) {
    super(message);
    this.name = 'ShareLinkError';
  }
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Join a base URL and an absolute path, collapsing any trailing slashes on the
 * base. Mirrors `proxyAdapterHelpers.joinUrl` / `client.joinUrl`.
 */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * Validate and normalise an untrusted server URL to a bare http(s) ORIGIN.
 *
 * Returns the origin (scheme + host + optional port, no trailing slash) when the
 * input parses as an `http:` or `https:` URL; returns `null` for anything else
 * (other schemes, malformed input, empty string). This is the SSRF/junk guard
 * the embed page relies on before fetching a snapshot from a link-carried `srv`.
 */
export function normalizeServerOrigin(serverUrl: string | null | undefined): string | null {
  if (typeof serverUrl !== 'string' || serverUrl.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.origin;
}

/**
 * Build the SHORT embed URL: `${appOrigin}/embed?id=<id>&srv=<serverOrigin>`.
 *
 * The `srv` origin is normalised + URL-encoded. Throws if either origin is not a
 * valid http(s) URL (a programming error — both come from trusted local state at
 * build time) so we never emit a link the embed page would reject on read.
 */
export function buildShortEmbedUrl(appOrigin: string, serverUrl: string, id: string): string {
  const app = normalizeServerOrigin(appOrigin);
  if (!app) {
    throw new ShareLinkError(`Invalid app origin: ${appOrigin}`);
  }
  const srv = normalizeServerOrigin(serverUrl);
  if (!srv) {
    throw new ShareLinkError(`Invalid server origin: ${serverUrl}`);
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new ShareLinkError('A snapshot id is required to build a short link.');
  }
  return `${app}/embed?id=${encodeURIComponent(id)}&srv=${encodeURIComponent(srv)}`;
}

// ---------------------------------------------------------------------------
// Server calls
// ---------------------------------------------------------------------------

/**
 * GET `/v1/server-info` and return the `snapshots` posture block, or `null` on
 * any failure (network error, non-OK status, missing/malformed field). Callers
 * treat `null` exactly like "disabled" — the short-link affordance simply does
 * not appear and the long link is used.
 */
export async function getServerSnapshotConfig(
  serverUrl: string,
): Promise<ServerSnapshotConfig | null> {
  const origin = normalizeServerOrigin(serverUrl);
  if (!origin) return null;
  let res: Response;
  try {
    res = await fetch(joinUrl(origin, '/v1/server-info'), { method: 'GET' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const snapshots = (body as Record<string, unknown>)['snapshots'];
  if (typeof snapshots !== 'object' || snapshots === null) return null;
  const s = snapshots as Record<string, unknown>;
  if (typeof s['enabled'] !== 'boolean' || typeof s['maxBytes'] !== 'number') return null;
  return { enabled: s['enabled'], maxBytes: s['maxBytes'] };
}

/**
 * POST `/v1/snapshots` with the opaque, already-encoded snapshot `data`.
 *
 * On success returns `{ id, deleteToken }`. A 413 surfaces as a
 * {@link ShareLinkTooLargeError} ("too large for short link") so the caller can
 * cleanly fall back to the long `s=` link; any other failure throws a
 * {@link ShareLinkError}.
 */
export async function uploadSnapshot(
  serverUrl: string,
  encoded: string,
): Promise<UploadedSnapshot> {
  const origin = normalizeServerOrigin(serverUrl);
  if (!origin) {
    throw new ShareLinkError(`Invalid server URL: ${serverUrl}`);
  }
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new ShareLinkError('Cannot create a short link for an empty snapshot.');
  }

  let res: Response;
  try {
    res = await fetch(joinUrl(origin, '/v1/snapshots'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: encoded }),
    });
  } catch (err) {
    throw new ShareLinkError(
      `Network error creating short link — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 413) {
    throw new ShareLinkTooLargeError(
      'This graph is too large for a short link. Use the direct link instead, or apply filters to share fewer nodes.',
    );
  }
  if (!res.ok) {
    throw new ShareLinkError(`Failed to create short link (HTTP ${res.status}).`, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ShareLinkError('Short-link server returned a malformed response.', res.status);
  }
  if (typeof body !== 'object' || body === null) {
    throw new ShareLinkError('Short-link server returned a malformed response.', res.status);
  }
  const b = body as Record<string, unknown>;
  if (typeof b['id'] !== 'string' || typeof b['deleteToken'] !== 'string') {
    throw new ShareLinkError('Short-link server returned a malformed response.', res.status);
  }
  return { id: b['id'], deleteToken: b['deleteToken'] };
}

/**
 * GET `/v1/snapshots/:id` and return the stored opaque `data` string (which the
 * embed page passes straight to `decodeSnapshot`).
 *
 * Validates `serverUrl` as an http(s) origin first (SSRF guard). A 404 (unknown,
 * expired, or malformed id) throws a {@link ShareLinkError} with status 404;
 * other failures throw a {@link ShareLinkError} too.
 */
export async function fetchSnapshot(serverUrl: string, id: string): Promise<string> {
  const origin = normalizeServerOrigin(serverUrl);
  if (!origin) {
    throw new ShareLinkError(`Invalid or untrusted server URL: ${serverUrl}`);
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new ShareLinkError('A snapshot id is required.', 404);
  }

  let res: Response;
  try {
    res = await fetch(joinUrl(origin, `/v1/snapshots/${encodeURIComponent(id)}`), {
      method: 'GET',
    });
  } catch (err) {
    throw new ShareLinkError(
      `Network error loading shared graph — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 404) {
    throw new ShareLinkError('This shared graph was not found (it may have expired).', 404);
  }
  if (!res.ok) {
    throw new ShareLinkError(`Failed to load shared graph (HTTP ${res.status}).`, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ShareLinkError('Shared-graph server returned a malformed response.', res.status);
  }
  if (typeof body !== 'object' || body === null) {
    throw new ShareLinkError('Shared-graph server returned a malformed response.', res.status);
  }
  const data = (body as Record<string, unknown>)['data'];
  if (typeof data !== 'string' || data.length === 0) {
    throw new ShareLinkError('Shared-graph server returned an empty snapshot.', res.status);
  }
  return data;
}
