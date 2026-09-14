/**
 * Remote MCP connector: OAuth 2.1 authorization server routes.
 *
 * Surfaces (all self-hosted, no external identity provider):
 *  - `GET /.well-known/oauth-authorization-server` - RFC 8414 metadata, so a
 *    client (Claude.ai's "custom connector") can auto-discover every endpoint.
 *  - `POST /oauth/register` - RFC 7591 dynamic client registration. Always
 *    issues a PUBLIC client (no secret) - PKCE is mandatory on every request.
 *  - `GET /oauth/authorize` + `POST /oauth/authorize` - a minimal, dependency-
 *    free login+consent HTML page. GET renders the form; POST verifies the
 *    resource owner's GraphVault password and, on success, redirects to the
 *    client's `redirect_uri` with a single-use authorization code.
 *  - `POST /oauth/token` - exchanges a PKCE-verified code (or a refresh token)
 *    for an access+refresh token pair.
 *  - `POST /oauth/revoke` - RFC 7009 revocation.
 *
 * Every route here renders OAuth-spec-shaped errors (`{error, error_description}`)
 * directly, NOT this app's own `{error: {code, message}}` envelope - a spec-
 * compliant OAuth client parses the former, not the latter.
 *
 * Gating: when `config.mcpRemoteEnabled` is false, NONE of these routes is
 * registered, so every `/oauth/*` and the well-known path 404 - this is new
 * attack surface (a full authorization server) and stays invisible by default.
 *
 * Open-redirect guard: `redirect_uri` is checked against the client's
 * registered URIs (via `oauth.isRegisteredRedirectUri`) BEFORE it is ever used
 * in a redirect or shown on the consent page. If it isn't registered, the
 * response is an in-page error, never a redirect to the unverified URI.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { OAuthError } from '../services/oauth.js';
import type { Services } from '../services/index.js';

const registerSchema = z.object({
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.string().min(1)).min(1),
});

const authorizeQuerySchema = z.object({
  response_type: z.string(),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  state: z.string().max(2000).optional(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string(),
  scope: z.string().max(200).optional(),
});

const authorizeSubmitSchema = authorizeQuerySchema.extend({
  email: z.string().min(1),
  password: z.string().min(1),
});

const tokenSchema = z.union([
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1),
    redirect_uri: z.string().min(1),
    client_id: z.string().min(1),
    code_verifier: z.string().min(1),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1),
    client_id: z.string().min(1),
  }),
]);

const revokeSchema = z.object({
  token: z.string().min(1),
});

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Renders the login+consent page. All dynamic values are HTML-escaped - every
 *  one of them is attacker-influenceable (client_name from a self-registered
 *  client; the rest from query params an attacker could craft). */
function renderLoginPage(params: {
  clientName: string;
  errorMessage?: string;
  hidden: Record<string, string>;
}): string {
  const hiddenInputs = Object.entries(params.hidden)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('\n      ');
  const errorHtml = params.errorMessage
    ? `<p style="color:#f87171;margin:0 0 16px;">${escapeHtml(params.errorMessage)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${escapeHtml(params.clientName)} to GraphVault</title>
<style>
  body { background:#0a0a0a; color:#e5e5e5; font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;
         display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  form { width:100%; max-width:360px; padding:32px; }
  h1 { font-size:1.1rem; margin:0 0 8px; }
  p.sub { color:#a3a3a3; font-size:0.85rem; margin:0 0 24px; }
  label { display:block; font-size:0.8rem; color:#a3a3a3; margin:16px 0 4px; }
  input[type=email], input[type=password] {
    width:100%; box-sizing:border-box; padding:10px 12px; border-radius:6px;
    border:1px solid #404040; background:#171717; color:#e5e5e5; font-size:0.9rem;
  }
  button { width:100%; margin-top:24px; padding:10px 12px; border-radius:6px; border:none;
           background:#1fafc6; color:#fff; font-size:0.9rem; font-weight:600; cursor:pointer; }
  button:hover { background:#0e8fa3; }
</style>
</head>
<body>
  <form method="post" action="/oauth/authorize">
    <h1>Connect ${escapeHtml(params.clientName)}</h1>
    <p class="sub">Sign in with your GraphVault account to let ${escapeHtml(params.clientName)}
      read and (if it requests write access) edit this vault.</p>
    ${errorHtml}
    <label for="email">Email</label>
    <input type="email" id="email" name="email" required autofocus>
    <label for="password">Password</label>
    <input type="password" id="password" name="password" required>
    ${hiddenInputs}
    <button type="submit">Sign in &amp; connect</button>
  </form>
</body>
</html>`;
}

/** Parse an `application/x-www-form-urlencoded` request body already decoded to a string by app.ts. */
function parseForm(body: unknown): Record<string, string> {
  const raw = typeof body === 'string' ? body : '';
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

export function registerOAuthRoutes(
  app: FastifyInstance,
  services: Services,
  config: ServerConfig,
): void {
  // Off => register nothing so the feature (an authorization server!) is invisible.
  if (!config.mcpRemoteEnabled || !services.oauth) return;
  const oauth = services.oauth;

  const oauthRateLimit = {
    config: {
      rateLimit: {
        max: config.oauthRateLimitMax,
        timeWindow: config.rateLimitWindowMs,
      },
    },
  };

  app.get('/.well-known/oauth-authorization-server', async () => oauth.getMetadata());
  // RFC 9728: some clients look for the resource-server metadata path too;
  // this server is both AS and RS, so it's the same document either way.
  app.get('/.well-known/oauth-protected-resource', async () => oauth.getMetadata());

  app.post('/oauth/register', oauthRateLimit, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_client_metadata',
        error_description: 'Invalid registration request',
      });
    }
    try {
      const client = await oauth.registerClient({
        clientName: parsed.data.client_name,
        redirectUris: parsed.data.redirect_uris,
      });
      return reply.code(201).send({
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
      });
    } catch (err) {
      if (err instanceof OAuthError) {
        return reply
          .code(err.statusCode)
          .send({ error: err.error, error_description: err.errorDescription });
      }
      throw err;
    }
  });

  /** Build the login form's hidden fields, dropping unset optionals (state/scope). */
  function authorizeHiddenFields(
    query: z.infer<typeof authorizeQuerySchema>,
  ): Record<string, string> {
    const fields: Record<string, string> = {
      response_type: query.response_type,
      client_id: query.client_id,
      redirect_uri: query.redirect_uri,
      code_challenge: query.code_challenge,
      code_challenge_method: query.code_challenge_method,
    };
    if (query.state !== undefined) fields.state = query.state;
    if (query.scope !== undefined) fields.scope = query.scope;
    return fields;
  }

  /** Shared authorize-request validation: client + redirect_uri + PKCE method. */
  async function validateAuthorizeRequest(
    query: z.infer<typeof authorizeQuerySchema>,
  ): Promise<{ ok: true; clientName: string } | { ok: false; status: number; message: string }> {
    if (query.response_type !== 'code') {
      return { ok: false, status: 400, message: 'Only response_type=code is supported' };
    }
    if (query.code_challenge_method !== 'S256') {
      return { ok: false, status: 400, message: 'Only code_challenge_method=S256 is supported' };
    }
    const client = await oauth.requireClient(query.client_id).catch(() => null);
    if (!client) return { ok: false, status: 400, message: 'Unknown client_id' };
    if (!oauth.isRegisteredRedirectUri(client, query.redirect_uri)) {
      return { ok: false, status: 400, message: 'redirect_uri is not registered for this client' };
    }
    return { ok: true, clientName: client.clientName };
  }

  app.get('/oauth/authorize', oauthRateLimit, async (request, reply) => {
    const parsed = authorizeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).type('text/plain').send('Invalid authorization request');
    }
    const validation = await validateAuthorizeRequest(parsed.data);
    if (!validation.ok) {
      // client_id/redirect_uri could not be verified - never redirect here.
      return reply.code(validation.status).type('text/plain').send(validation.message);
    }
    return reply.type('text/html').send(
      renderLoginPage({
        clientName: validation.clientName,
        hidden: authorizeHiddenFields(parsed.data),
      }),
    );
  });

  app.post('/oauth/authorize', oauthRateLimit, async (request, reply) => {
    const body = parseForm(request.body);
    const parsed = authorizeSubmitSchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).type('text/plain').send('Invalid authorization submission');
    }
    const validation = await validateAuthorizeRequest(parsed.data);
    if (!validation.ok) {
      return reply.code(validation.status).type('text/plain').send(validation.message);
    }

    const credentials = await oauth.verifyCredentials(parsed.data.email, parsed.data.password);
    if (!credentials) {
      return reply.type('text/html').send(
        renderLoginPage({
          clientName: validation.clientName,
          errorMessage: 'Incorrect email or password.',
          hidden: authorizeHiddenFields(parsed.data),
        }),
      );
    }

    const code = await oauth.issueAuthorizationCode({
      clientId: parsed.data.client_id,
      userId: credentials.userId,
      redirectUri: parsed.data.redirect_uri,
      codeChallenge: parsed.data.code_challenge,
      scope: parsed.data.scope ?? 'vault',
    });

    const redirectUrl = new URL(parsed.data.redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (parsed.data.state) redirectUrl.searchParams.set('state', parsed.data.state);
    return reply.redirect(redirectUrl.toString(), 303);
  });

  app.post('/oauth/token', oauthRateLimit, async (request, reply) => {
    const body = parseForm(request.body);
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', error_description: 'Invalid token request' });
    }
    try {
      const tokens =
        parsed.data.grant_type === 'authorization_code'
          ? await oauth.exchangeAuthorizationCode({
              clientId: parsed.data.client_id,
              code: parsed.data.code,
              redirectUri: parsed.data.redirect_uri,
              codeVerifier: parsed.data.code_verifier,
            })
          : await oauth.exchangeRefreshToken({
              clientId: parsed.data.client_id,
              refreshToken: parsed.data.refresh_token,
            });
      return reply.send({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scope,
      });
    } catch (err) {
      if (err instanceof OAuthError) {
        return reply
          .code(err.statusCode)
          .send({ error: err.error, error_description: err.errorDescription });
      }
      throw err;
    }
  });

  app.post('/oauth/revoke', oauthRateLimit, async (request, reply) => {
    const body = parseForm(request.body);
    const parsed = revokeSchema.safeParse(body);
    // RFC 7009 §2.2: always 200, even for a malformed/unknown token - never
    // leak whether a token existed.
    if (!parsed.success) return reply.send({});
    await oauth.revokeToken(parsed.data.token);
    return reply.send({});
  });
}

/** Exposed for the MCP-over-HTTP route's bearer-auth check. */
export function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1]?.trim() || null;
}
