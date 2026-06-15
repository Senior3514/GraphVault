/**
 * Typed client for the GraphVault sync server.
 *
 * Uses the wire types and zod schemas from `@graphvault/shared` so the client
 * and server share one source of truth. The base URL comes from
 * `NEXT_PUBLIC_GRAPHVAULT_SERVER_URL` (see `.env.example`) but can be overridden
 * at runtime from Settings.
 *
 * Endpoints implemented:
 *   - GET  /v1/health
 *   - POST /v1/auth/register
 *   - POST /v1/auth/login
 *   - GET  /v1/vaults          (list vaults for the authenticated user)
 *   - POST /v1/vaults          (register a new vault)
 *
 * Sync endpoints (changes, push, blobs) are implemented in lib/sync/remoteApi.ts
 * because they are consumed by the sync engine adapter rather than the UI layer.
 */

import {
  apiErrorSchema,
  authTokenSchema,
  registerVaultResponseSchema,
  webdavConfigRequestSchema,
  webdavConfigInfoSchema,
  type AuthToken,
  type LoginRequest,
  type RegisterRequest,
  type RegisterVaultResponse,
  type VaultRef,
  type WebDavConfigRequest,
  type WebDavConfigInfo,
} from '@graphvault/shared';

export const DEFAULT_SERVER_URL =
  process.env.NEXT_PUBLIC_GRAPHVAULT_SERVER_URL ?? 'http://127.0.0.1:4000';

export interface HealthInfo {
  status: string;
  apiVersion: string;
  syncProtocolVersion: number;
  time: string;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

export class GraphVaultClient {
  constructor(
    private baseUrl: string = DEFAULT_SERVER_URL,
    private token?: string,
  ) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  private headers(json = true): HeadersInit {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(joinUrl(this.baseUrl, path), init);
    } catch (err) {
      throw new ApiClientError(
        err instanceof Error ? err.message : 'Network request failed',
        'NETWORK_ERROR',
        0,
      );
    }

    const text = await res.text();
    const data: unknown = text ? safeJson(text) : undefined;

    if (!res.ok) {
      const parsed = apiErrorSchema.safeParse(data);
      if (parsed.success) {
        throw new ApiClientError(parsed.data.error.message, parsed.data.error.code, res.status);
      }
      throw new ApiClientError(`Request failed (${res.status})`, 'HTTP_ERROR', res.status);
    }

    return data as T;
  }

  /** GET /v1/health — confirms the server is reachable and reports versions. */
  async health(): Promise<HealthInfo> {
    return this.request<HealthInfo>('/v1/health', {
      method: 'GET',
      headers: this.headers(false),
    });
  }

  /** POST /v1/auth/register */
  async register(body: RegisterRequest): Promise<AuthToken> {
    const data = await this.request<unknown>('/v1/auth/register', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return authTokenSchema.parse(data);
  }

  /** POST /v1/auth/login */
  async login(body: LoginRequest): Promise<AuthToken> {
    const data = await this.request<unknown>('/v1/auth/login', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return authTokenSchema.parse(data);
  }

  /** GET /v1/vaults — list all vaults owned by the authenticated user. */
  async listVaults(): Promise<VaultRef[]> {
    return this.request<VaultRef[]>('/v1/vaults', {
      method: 'GET',
      headers: this.headers(false),
    });
  }

  /** POST /v1/vaults — register a new vault for the authenticated user. */
  async registerVault(name: string): Promise<RegisterVaultResponse> {
    const data = await this.request<unknown>('/v1/vaults', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name }),
    });
    return registerVaultResponseSchema.parse(data);
  }

  // ---------------------------------------------------------------------------
  // WebDAV proxy config (M18)
  // ---------------------------------------------------------------------------

  /**
   * POST /v1/storage/webdav/config
   * Save WebDAV credentials on the server (encrypted at rest).
   * The client sends the plaintext once over TLS; it is never returned.
   */
  async saveWebDavConfig(config: WebDavConfigRequest): Promise<void> {
    webdavConfigRequestSchema.parse(config); // validate before sending
    await this.request<unknown>('/v1/storage/webdav/config', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(config),
    });
  }

  /**
   * GET /v1/storage/webdav/config
   * Fetch non-secret config info (URL, username, updatedAt — no password).
   * Returns null if WebDAV is not configured.
   */
  async getWebDavConfig(): Promise<WebDavConfigInfo | null> {
    try {
      const data = await this.request<unknown>('/v1/storage/webdav/config', {
        method: 'GET',
        headers: this.headers(false),
      });
      return webdavConfigInfoSchema.parse(data);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * DELETE /v1/storage/webdav/config
   * Remove the WebDAV configuration for the current user.
   */
  async deleteWebDavConfig(): Promise<void> {
    await this.request<unknown>('/v1/storage/webdav/config', {
      method: 'DELETE',
      headers: this.headers(false),
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
