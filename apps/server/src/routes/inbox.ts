/**
 * "Connect anything" inbound webhook routes (M22, Wave 19).
 *
 * Two surfaces:
 *  - authenticated token management + audit log (the vault owner mints/lists/
 *    revokes per-connector tokens and reviews what each connector did);
 *  - a single PUBLIC inbound endpoint `POST /v1/inbox/:token` where the token IS
 *    the credential — external services POST Markdown and it lands as a note.
 *
 * The inbound endpoint carries a STRICTER per-window rate limit (like
 * `/v1/auth/*` and `/v1/snapshots`) and a size cap (413), since it is
 * unauthenticated by design. An unknown token returns 404 so we never leak
 * which tokens exist.
 *
 * Gating: when `config.inboxEnabled` is false, NONE of these routes is
 * registered, so every `/v1/inbox*` request falls through to the 404 handler.
 * It defaults to ON because a token must be explicitly minted by an
 * authenticated user before the inbound endpoint can do anything.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { AppError, badRequest } from '../errors.js';
import type { AuthContext } from '../services/auth.js';
import type { Services } from '../services/index.js';

const createTokenSchema = z.object({
  vaultId: z.string().min(1),
  label: z.string().min(1).max(200),
});

const submissionSchema = z.object({
  title: z.string().max(500).optional(),
  markdown: z.string().min(1).max(2_000_000),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  source: z.string().max(200).optional(),
});

export function registerInboxRoutes(
  app: FastifyInstance,
  services: Services,
  config: ServerConfig,
): void {
  // Off => register nothing so the feature is invisible (404).
  if (!config.inboxEnabled || !services.inbox) return;
  const inbox = services.inbox;

  const auth = (request: FastifyRequest): Promise<AuthContext> =>
    services.auth.authenticate(request.headers.authorization);

  // Stricter per-window cap on the public inbound endpoint, independent of (and
  // below) the global cap, to deter abuse. Same shape as auth/snapshot routes.
  const inboundRateLimit = {
    config: {
      rateLimit: {
        max: config.inboxRateLimitMax,
        timeWindow: config.rateLimitWindowMs,
      },
    },
  };

  // --- token management (authenticated) -----------------------------------

  /**
   * POST /v1/inbox/tokens
   * Body: { vaultId, label }
   * 201 { id, token, label }  (token shown ONCE; only its hash is stored)
   */
  app.post('/v1/inbox/tokens', async (request, reply) => {
    const { user } = await auth(request);
    const parsed = createTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid inbox token request', parsed.error.flatten());
    }
    const created = await inbox.createToken(user.id, parsed.data.vaultId, parsed.data.label);
    return reply.code(201).send(created);
  });

  /**
   * GET /v1/inbox/tokens
   * 200 [{ id, vaultId, label, createdAt, lastUsedAt }]  (never the token/hash)
   */
  app.get('/v1/inbox/tokens', async (request) => {
    const { user } = await auth(request);
    return inbox.listTokens(user.id);
  });

  /**
   * DELETE /v1/inbox/tokens/:id
   * 204 on success; 404 if it doesn't exist or isn't the caller's.
   */
  app.delete('/v1/inbox/tokens/:id', async (request, reply) => {
    const { user } = await auth(request);
    const { id } = request.params as { id: string };
    inbox.revokeToken(user.id, id);
    return reply.code(204).send();
  });

  /**
   * GET /v1/inbox/log
   * 200 [{ id, tokenId, source, path, bytes, status, at }]  (newest first)
   */
  app.get('/v1/inbox/log', async (request) => {
    const { user } = await auth(request);
    return inbox.listAudit(user.id);
  });

  // --- public inbound (NO auth; the token IS the credential) --------------

  /**
   * POST /v1/inbox/:token
   * Body: { title?, markdown, tags?, source? }
   * 201 { path }  on success.
   * 404 unknown/revoked token; 413 oversize; 409 (should-never) path collision.
   */
  app.post('/v1/inbox/:token', inboundRateLimit, async (request, reply) => {
    const { token } = request.params as { token: string };
    if (typeof token !== 'string' || token.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Inbox token not found');
    }
    const parsed = submissionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid inbox submission', parsed.error.flatten());
    }
    const result = await inbox.submit(token, parsed.data);
    return reply.code(201).send(result);
  });
}
