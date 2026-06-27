/**
 * Minimal, typed HTTP client for the GraphVault sync server.
 *
 * It speaks only the read-only subset the MCP server needs:
 *   - `GET /v1/vaults`                       - list the caller's vaults.
 *   - `GET /v1/vaults/:id/changes?since&limit` - paginated file states.
 *   - `GET /v1/blobs/:hash`                  - raw content bytes.
 *
 * Every request carries `Authorization: Bearer <token>`. The token is held in
 * memory only and is NEVER included in thrown error messages or logged, so it
 * cannot leak through agent transcripts.
 */

import {
  apiErrorSchema,
  changesResponseSchema,
  pushResponseSchema,
  type ChangesResponse,
  type FileState,
  type PushOp,
  type PushResponse,
  type VaultRef,
} from '@graphvault/shared';
import type { McpConfig } from './config.js';

/**
 * Error raised for any non-2xx response or transport failure. Carries the HTTP
 * status (0 for transport-level errors) and the server error code when the
 * standard `{ error: { code, message } }` envelope was returned.
 */
export class GraphVaultApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'GraphVaultApiError';
  }
}

/** Options for {@link GraphVaultClient}; `fetch` is injectable for testing. */
export interface ClientOptions {
  /** Defaults to the global `fetch`. Override in tests with a stub. */
  fetchImpl?: typeof fetch;
}

export class GraphVaultClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Pick<McpConfig, 'serverUrl' | 'token'>, options: ClientOptions = {}) {
    this.baseUrl = config.serverUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Authorization header. Kept in one place so the token never spreads around. */
  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  /**
   * Perform a request and, on a non-2xx, throw a {@link GraphVaultApiError}
   * with the server's error code/message when the JSON envelope is present.
   * The token is never included in the thrown message.
   */
  private async request(path: string, accept: string): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { ...this.authHeaders(), accept },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new GraphVaultApiError(`Network error contacting GraphVault server: ${reason}`, 0);
    }

    if (!res.ok) {
      throw await this.toApiError(res);
    }
    return res;
  }

  /** Build a {@link GraphVaultApiError} from a non-2xx response. */
  private async toApiError(res: Response): Promise<GraphVaultApiError> {
    let code: string | undefined;
    let message = `GraphVault server returned ${res.status} ${res.statusText}`.trim();
    try {
      const body: unknown = await res.json();
      const parsed = apiErrorSchema.safeParse(body);
      if (parsed.success) {
        code = parsed.data.error.code;
        message = `${parsed.data.error.code}: ${parsed.data.error.message}`;
      }
    } catch {
      // Non-JSON or empty body; keep the status-line message.
    }
    if (res.status === 401 || res.status === 403) {
      message = `Authentication failed (${res.status}). Check GRAPHVAULT_TOKEN. ${message}`;
    }
    return new GraphVaultApiError(message, res.status, code);
  }

  /** `GET /v1/vaults` - the bearer token's vaults. */
  async listVaults(): Promise<VaultRef[]> {
    const res = await this.request('/v1/vaults', 'application/json');
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      throw new GraphVaultApiError('Malformed /v1/vaults response (expected an array)', res.status);
    }
    // The server returns VaultRef[]; trust the shape but guard the essentials.
    return body.map((entry, i) => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { id?: unknown }).id !== 'string' ||
        typeof (entry as { name?: unknown }).name !== 'string'
      ) {
        throw new GraphVaultApiError(`Malformed vault entry at index ${i}`, res.status);
      }
      const e = entry as { id: string; name: string };
      return { id: e.id, name: e.name };
    });
  }

  /** One page of `GET /v1/vaults/:id/changes`. */
  async getChangesPage(vaultId: string, since: number, limit: number): Promise<ChangesResponse> {
    const qs = new URLSearchParams({ since: String(since), limit: String(limit) });
    const res = await this.request(
      `/v1/vaults/${encodeURIComponent(vaultId)}/changes?${qs.toString()}`,
      'application/json',
    );
    const body: unknown = await res.json();
    const parsed = changesResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new GraphVaultApiError('Malformed /changes response', res.status);
    }
    return parsed.data;
  }

  /**
   * Fetch every file state for a vault by paging through `/changes` until
   * `hasMore` is false. Pages are keyed by the highest `revision` seen so far.
   */
  async listAllFileStates(vaultId: string, pageSize = 1000): Promise<FileState[]> {
    const states: FileState[] = [];
    let since = 0;
    // Hard ceiling to avoid an unbounded loop if a buggy server always reports
    // hasMore without advancing the revision cursor.
    for (let page = 0; page < 100_000; page++) {
      const resp = await this.getChangesPage(vaultId, since, pageSize);
      for (const state of resp.changes) {
        states.push(state);
      }
      if (!resp.hasMore || resp.changes.length === 0) break;
      const maxRevision = resp.changes.reduce(
        (max, s) => (s.revision > max ? s.revision : max),
        since,
      );
      if (maxRevision <= since) break; // no forward progress; stop to avoid a loop.
      since = maxRevision;
    }
    return states;
  }

  /**
   * Fetch the server's CURRENT authoritative {@link FileState} for a single
   * path, or `null` when the server has no state for it. The returned state
   * carries the `revision` used as `baseRevision` for a conflict-safe push.
   *
   * This pages through `/changes` and keeps the entry with the highest
   * `revision` for `path` (including tombstones), so a caller can tell whether
   * a note exists, is deleted, or is absent.
   */
  async getFileState(vaultId: string, path: string, pageSize = 1000): Promise<FileState | null> {
    let latest: FileState | null = null;
    let since = 0;
    for (let page = 0; page < 100_000; page++) {
      const resp = await this.getChangesPage(vaultId, since, pageSize);
      for (const state of resp.changes) {
        if (state.path !== path) continue;
        if (latest === null || state.revision >= latest.revision) {
          latest = state;
        }
      }
      if (!resp.hasMore || resp.changes.length === 0) break;
      const maxRevision = resp.changes.reduce(
        (max, s) => (s.revision > max ? s.revision : max),
        since,
      );
      if (maxRevision <= since) break; // no forward progress; stop to avoid a loop.
      since = maxRevision;
    }
    return latest;
  }

  /**
   * `PUT /v1/blobs/:hash` - upload raw content bytes. The server recomputes and
   * verifies the SHA-256, so a mismatched hash is rejected. Idempotent: an
   * existing blob is accepted unchanged.
   */
  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    await this.writeRequest(`/v1/blobs/${encodeURIComponent(hash)}`, {
      method: 'PUT',
      body: bytes,
      contentType: 'application/octet-stream',
    });
  }

  /**
   * `POST /v1/vaults/:id/push` - submit ops. The server only fast-forward
   * accepts ops whose `baseRevision` matches the current server revision;
   * otherwise it returns a conflict and does NOT clobber. The caller MUST
   * inspect `conflicts` before treating a push as successful.
   */
  async push(vaultId: string, deviceId: string, ops: PushOp[]): Promise<PushResponse> {
    const res = await this.writeRequest(`/v1/vaults/${encodeURIComponent(vaultId)}/push`, {
      method: 'POST',
      body: JSON.stringify({ deviceId, ops }),
      contentType: 'application/json',
    });
    const body: unknown = await res.json();
    const parsed = pushResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new GraphVaultApiError('Malformed /push response', res.status);
    }
    return parsed.data;
  }

  /**
   * Perform a write (PUT/POST) request and throw a {@link GraphVaultApiError}
   * on any non-2xx response or transport failure. The token is never included
   * in the thrown message.
   */
  private async writeRequest(
    path: string,
    opts: { method: 'PUT' | 'POST'; body: Uint8Array | string; contentType: string },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method,
        headers: { ...this.authHeaders(), 'content-type': opts.contentType },
        body: opts.body,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new GraphVaultApiError(`Network error contacting GraphVault server: ${reason}`, 0);
    }
    if (!res.ok) {
      throw await this.toApiError(res);
    }
    return res;
  }

  /** `GET /v1/blobs/:hash` - raw bytes for a content hash. */
  async getBlob(hash: string): Promise<Uint8Array> {
    const res = await this.request(
      `/v1/blobs/${encodeURIComponent(hash)}`,
      'application/octet-stream',
    );
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  /** Convenience: fetch a blob and decode it as UTF-8 text. */
  async getBlobText(hash: string): Promise<string> {
    const bytes = await this.getBlob(hash);
    return new TextDecoder('utf-8').decode(bytes);
  }
}
