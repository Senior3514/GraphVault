/**
 * Minimal, typed HTTP client for the GraphVault sync server.
 *
 * It speaks only the read-only subset the MCP server needs:
 *   - `GET /v1/vaults`                       — list the caller's vaults.
 *   - `GET /v1/vaults/:id/changes?since&limit` — paginated file states.
 *   - `GET /v1/blobs/:hash`                  — raw content bytes.
 *
 * Every request carries `Authorization: Bearer <token>`. The token is held in
 * memory only and is NEVER included in thrown error messages or logged, so it
 * cannot leak through agent transcripts.
 */

import {
  apiErrorSchema,
  changesResponseSchema,
  type ChangesResponse,
  type FileState,
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

  /** `GET /v1/vaults` — the bearer token's vaults. */
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

  /** `GET /v1/blobs/:hash` — raw bytes for a content hash. */
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
