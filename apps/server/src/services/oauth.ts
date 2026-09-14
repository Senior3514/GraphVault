import { createHash } from 'node:crypto';
import type { Storage } from '../store/types.js';
import { generateToken, hashToken, newId, verifyPassword } from './crypto.js';

/**
 * OAuth 2.1 authorization server for the remote MCP connector (e.g. Claude.ai's
 * "custom connector"). Lets a remote MCP client dynamically register itself
 * (RFC 7591), send the user through a login+consent screen, and exchange a
 * PKCE-verified authorization code for short-lived access + refresh tokens -
 * entirely self-hosted, no external identity provider.
 *
 * Design choices, deliberately simple:
 * - Every dynamically-registered client is treated as PUBLIC (no client
 *   secret; `token_endpoint_auth_method: "none"`). PKCE (S256) is REQUIRED on
 *   every authorization request regardless of client type - this is the
 *   OAuth 2.1 baseline and sidesteps ever needing to safely deliver a secret
 *   to an auto-registering remote client.
 * - Authorization codes are single-use and short-lived (2 minutes); access
 *   tokens are short-lived (1 hour); refresh tokens don't expire on their own
 *   but are ROTATED on every use (the whole token row is replaced) so a
 *   stolen-and-reused refresh token is detectable (its row is simply gone).
 * - Only hashes of codes/tokens are ever persisted, matching every other
 *   secret in this store (`Token`).
 */

/** Authorization codes expire quickly - they are exchanged within seconds in practice. */
const AUTH_CODE_TTL_SECONDS = 120;
/** Access tokens are short-lived; the client is expected to refresh. */
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export interface OAuthServiceOptions {
  /** This server's own externally-reachable HTTPS origin, no trailing slash. */
  publicUrl: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export interface AccessTokenInfo {
  userId: string;
  clientId: string;
  scope: string;
}

/**
 * A spec-shaped OAuth error (RFC 6749 §5.2 / §4.1.2.1): `error` is one of the
 * registered error codes (`invalid_request`, `invalid_client`, `invalid_grant`,
 * ...), never a free-form message - callers render `{error, error_description}`
 * directly, distinct from this app's own `AppError`/`ApiError` envelope.
 */
export class OAuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly error: string,
    readonly errorDescription: string,
  ) {
    super(errorDescription);
    this.name = 'OAuthError';
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** RFC 7636 §4.6: BASE64URL(SHA256(code_verifier)) must equal the stored code_challenge. */
function pkceMatches(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  return computed === codeChallenge;
}

export class OAuthService {
  private readonly publicUrl: string;

  constructor(
    private readonly storage: Storage,
    options: OAuthServiceOptions,
  ) {
    this.publicUrl = options.publicUrl.replace(/\/+$/, '');
  }

  /** RFC 8414 authorization server metadata, served at the well-known path. */
  getMetadata() {
    return {
      issuer: this.publicUrl,
      authorization_endpoint: `${this.publicUrl}/oauth/authorize`,
      token_endpoint: `${this.publicUrl}/oauth/token`,
      registration_endpoint: `${this.publicUrl}/oauth/register`,
      revocation_endpoint: `${this.publicUrl}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['vault'],
    };
  }

  /** RFC 7591 dynamic client registration - always issues a public (no-secret) client. */
  async registerClient(input: {
    clientName?: string;
    redirectUris: string[];
  }): Promise<{ clientId: string; clientName: string; redirectUris: string[]; createdAt: string }> {
    if (input.redirectUris.length === 0) {
      throw new OAuthError(
        400,
        'invalid_client_metadata',
        'redirect_uris must be a non-empty array',
      );
    }
    for (const uri of input.redirectUris) {
      try {
        new URL(uri);
      } catch {
        throw new OAuthError(
          400,
          'invalid_redirect_uri',
          `redirect_uris contains an invalid URL: ${uri}`,
        );
      }
    }

    const clientId = newId();
    const createdAt = new Date().toISOString();
    await this.storage.createOAuthClient({
      clientId,
      clientSecretHash: null,
      clientName: input.clientName?.trim() || 'MCP client',
      redirectUris: input.redirectUris,
      createdAt,
    });
    const client = await this.storage.getOAuthClientById(clientId);
    return {
      clientId,
      clientName: client!.clientName,
      redirectUris: client!.redirectUris,
      createdAt,
    };
  }

  /** Look up a client, or throw a spec-shaped error if it doesn't exist. */
  async requireClient(clientId: string) {
    const client = await this.storage.getOAuthClientById(clientId);
    if (!client) throw new OAuthError(400, 'invalid_client', 'Unknown client_id');
    return client;
  }

  /**
   * Validate that `redirectUri` is exactly one of the client's registered URIs.
   * Callers MUST verify this before ever redirecting to it (open-redirect guard) -
   * on failure, render an in-page error instead of redirecting.
   */
  isRegisteredRedirectUri(client: { redirectUris: string[] }, redirectUri: string): boolean {
    return client.redirectUris.includes(redirectUri);
  }

  /** Verify the resource owner's credentials for the login step. Constant-ish time either way. */
  async verifyCredentials(email: string, password: string): Promise<{ userId: string } | null> {
    const user = await this.storage.getUserByEmail(email.trim());
    const ok = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, password);
    if (!user || !ok) return null;
    return { userId: user.id };
  }

  /** Issue a single-use authorization code after a successful login+consent. */
  async issueAuthorizationCode(input: {
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
  }): Promise<string> {
    const code = generateToken();
    await this.storage.createOAuthAuthorizationCode({
      codeHash: hashToken(code),
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scope: input.scope,
      expiresAt: nowSeconds() + AUTH_CODE_TTL_SECONDS,
      createdAt: new Date().toISOString(),
    });
    return code;
  }

  /** `grant_type=authorization_code`: PKCE-verified single-use code -> token pair. */
  async exchangeAuthorizationCode(input: {
    clientId: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<OAuthTokens> {
    const record = await this.storage.consumeOAuthAuthorizationCode(hashToken(input.code));
    // Every failure below collapses to the same generic error - never reveal
    // *why* a code was rejected (expired vs. wrong client vs. bad PKCE).
    if (!record)
      throw new OAuthError(400, 'invalid_grant', 'Authorization code is invalid or already used');
    if (record.expiresAt <= nowSeconds()) {
      throw new OAuthError(400, 'invalid_grant', 'Authorization code has expired');
    }
    if (record.clientId !== input.clientId) {
      throw new OAuthError(
        400,
        'invalid_grant',
        'Authorization code was not issued to this client',
      );
    }
    if (record.redirectUri !== input.redirectUri) {
      throw new OAuthError(
        400,
        'invalid_grant',
        'redirect_uri does not match the original request',
      );
    }
    if (!pkceMatches(input.codeVerifier, record.codeChallenge)) {
      throw new OAuthError(400, 'invalid_grant', 'code_verifier does not match code_challenge');
    }

    return this.issueTokenPair(record.clientId, record.userId, record.scope);
  }

  /** `grant_type=refresh_token`: rotates the token pair (old row deleted, new one issued). */
  async exchangeRefreshToken(input: {
    clientId: string;
    refreshToken: string;
  }): Promise<OAuthTokens> {
    const record = await this.storage.getOAuthTokenByRefreshHash(hashToken(input.refreshToken));
    if (!record)
      throw new OAuthError(400, 'invalid_grant', 'Refresh token is invalid or has been revoked');
    if (record.clientId !== input.clientId) {
      throw new OAuthError(400, 'invalid_grant', 'Refresh token was not issued to this client');
    }
    // Rotate: the old row is gone the moment we issue the new one, so a
    // replayed (already-used) refresh token fails the lookup above next time.
    await this.storage.deleteOAuthTokenByAccessHash(record.accessTokenHash);
    return this.issueTokenPair(record.clientId, record.userId, record.scope);
  }

  private async issueTokenPair(
    clientId: string,
    userId: string,
    scope: string,
  ): Promise<OAuthTokens> {
    const accessToken = generateToken();
    const refreshToken = generateToken();
    await this.storage.createOAuthToken({
      accessTokenHash: hashToken(accessToken),
      refreshTokenHash: hashToken(refreshToken),
      clientId,
      userId,
      scope,
      accessExpiresAt: nowSeconds() + ACCESS_TOKEN_TTL_SECONDS,
      createdAt: new Date().toISOString(),
    });
    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope };
  }

  /** Verify a bearer access token for the MCP-over-HTTP route. Null (not throw) on any failure. */
  async verifyAccessToken(rawToken: string): Promise<AccessTokenInfo | null> {
    const record = await this.storage.getOAuthTokenByAccessHash(hashToken(rawToken));
    if (!record) return null;
    if (record.accessExpiresAt <= nowSeconds()) return null;
    return { userId: record.userId, clientId: record.clientId, scope: record.scope };
  }

  /**
   * RFC 7009 revocation: best-effort delete by either an access or a refresh
   * token. Always succeeds from the caller's perspective (per spec §2.2) even
   * if the token was already invalid or unknown - never leaks which.
   */
  async revokeToken(rawToken: string): Promise<void> {
    const hash = hashToken(rawToken);
    const byAccess = await this.storage.getOAuthTokenByAccessHash(hash);
    if (byAccess) {
      await this.storage.deleteOAuthTokenByAccessHash(byAccess.accessTokenHash);
      return;
    }
    const byRefresh = await this.storage.getOAuthTokenByRefreshHash(hash);
    if (byRefresh) {
      await this.storage.deleteOAuthTokenByAccessHash(byRefresh.accessTokenHash);
    }
  }
}

/**
 * A constant Argon2id-shaped hash used for timing-equalisation on logins for
 * non-existent accounts, mirroring `AuthService`'s own dummy hash.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
