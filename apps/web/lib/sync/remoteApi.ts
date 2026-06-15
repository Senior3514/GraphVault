/**
 * A {@link RemoteApi} adapter over the GraphVault sync server's HTTP endpoints.
 *
 * `GraphVaultClient` (lib/api/client.ts) implements health + auth; the sync
 * endpoints (changes/push/blobs) land with this milestone and are wired here so
 * the existing client stays focused on connection/auth. This adapter reuses the
 * same base URL + bearer token and validates responses with the shared zod
 * schemas, so client and server share one source of truth.
 */

import {
  changesResponseSchema,
  pushResponseSchema,
  type ChangesResponse,
  type PushRequest,
  type PushResponse,
} from '@graphvault/shared';
import type { RemoteApi } from '@graphvault/sync-core';

import { ApiClientError } from '../api/client';

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

export interface RemoteApiConfig {
  baseUrl: string;
  token?: string;
}

/** Create a {@link RemoteApi} bound to a server base URL + bearer token. */
export function createRemoteApi(config: RemoteApiConfig): RemoteApi {
  const { baseUrl, token } = config;

  const authHeaders = (json: boolean): Record<string, string> => {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  };

  const send = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetch(joinUrl(baseUrl, path), init);
    } catch (err) {
      throw new ApiClientError(
        err instanceof Error ? err.message : 'Network request failed',
        'NETWORK_ERROR',
        0,
      );
    }
  };

  const ensureOk = (res: Response): void => {
    if (!res.ok) {
      throw new ApiClientError(`Request failed (${res.status})`, 'HTTP_ERROR', res.status);
    }
  };

  return {
    async getChanges(vaultId, since, limit): Promise<ChangesResponse> {
      const params = new URLSearchParams({ since: String(since) });
      if (limit !== undefined) params.set('limit', String(limit));
      const res = await send(`/v1/vaults/${encodeURIComponent(vaultId)}/changes?${params}`, {
        method: 'GET',
        headers: authHeaders(false),
      });
      ensureOk(res);
      return changesResponseSchema.parse(await res.json());
    },

    async push(vaultId, body: PushRequest): Promise<PushResponse> {
      const res = await send(`/v1/vaults/${encodeURIComponent(vaultId)}/push`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(body),
      });
      ensureOk(res);
      return pushResponseSchema.parse(await res.json());
    },

    async hasBlob(hash): Promise<boolean> {
      const res = await send(`/v1/blobs/${encodeURIComponent(hash)}`, {
        method: 'HEAD',
        headers: authHeaders(false),
      });
      if (res.status === 404) return false;
      ensureOk(res);
      return true;
    },

    async putBlob(hash, content): Promise<void> {
      const res = await send(`/v1/blobs/${encodeURIComponent(hash)}`, {
        method: 'PUT',
        headers: { ...authHeaders(false), 'Content-Type': 'application/octet-stream' },
        body: content,
      });
      ensureOk(res);
    },

    async getBlob(hash): Promise<string> {
      const res = await send(`/v1/blobs/${encodeURIComponent(hash)}`, {
        method: 'GET',
        headers: authHeaders(false),
      });
      ensureOk(res);
      return res.text();
    },
  };
}
