/**
 * Public, opt-in graph-snapshot store (Wave 18).
 *
 * Lets the web client share a read-only graph via a SHORT url
 * (`/embed?id=<id>`) instead of a giant encoded blob in the URL. The payload is
 * an OPAQUE, already-encoded string the client produced; the server stores and
 * returns it verbatim and never parses or executes it beyond size validation.
 *
 * Off by default: when `config.snapshotsEnabled` is false, NONE of these routes
 * is registered, so every `/v1/snapshots*` request falls through to the 404
 * not-found handler — the feature is invisible.
 *
 * No auth (public share, no account). The routes still count against the global
 * rate limit, and `POST` carries a STRICTER per-window cap (like `/v1/auth/*`)
 * to deter abuse.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { badRequest, notFound } from '../errors.js';
import type { Services } from '../services/index.js';

const createSnapshotSchema = z.object({
  data: z.string().min(1),
});

const deleteSnapshotSchema = z.object({
  deleteToken: z.string().min(1),
});

export function registerSnapshotRoutes(
  app: FastifyInstance,
  services: Services,
  config: ServerConfig,
): void {
  // Off by default: register nothing so the feature is invisible (404).
  if (!config.snapshotsEnabled || !services.snapshot) return;
  const snapshot = services.snapshot;

  // Stricter per-window cap on the write endpoint, independent of (and below)
  // the global cap, to deter abusive bulk creation. Same shape as auth routes.
  const createRateLimit = {
    config: {
      rateLimit: {
        max: config.snapshotRateLimitMax,
        timeWindow: config.rateLimitWindowMs,
      },
    },
  };

  /**
   * POST /v1/snapshots
   * Body: { data: string }  (opaque, already-encoded snapshot payload)
   * 201 { id: string, deleteToken: string }
   * 400 empty/invalid body; 413 payload too large.
   */
  app.post('/v1/snapshots', createRateLimit, async (request, reply) => {
    const parsed = createSnapshotSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid snapshot request', parsed.error.flatten());
    }
    const created = await snapshot.create(parsed.data.data);
    return reply.code(201).send(created);
  });

  /**
   * GET /v1/snapshots/:id
   * 200 { id, data, createdAt } | 404 (unknown, expired, or malformed id).
   */
  app.get('/v1/snapshots/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const view = await snapshot.get(id);
    if (!view) throw notFound('Snapshot not found');
    return reply.code(200).send(view);
  });

  /**
   * DELETE /v1/snapshots/:id
   * Body: { deleteToken: string }  (the token returned from POST)
   * 204 on success; 403 wrong/missing token; 404 unknown id.
   *
   * Gating: since there is no account/owner, deletion is gated behind the
   * one-time delete token handed back at create time. A party who only knows
   * the public share id cannot delete (grief) the snapshot.
   */
  app.delete('/v1/snapshots/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = deleteSnapshotSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('A deleteToken is required to delete a snapshot', parsed.error.flatten());
    }
    await snapshot.delete(id, parsed.data.deleteToken);
    return reply.code(204).send();
  });
}
