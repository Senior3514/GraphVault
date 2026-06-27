/**
 * Google Cloud Storage proxy routes (Wave 16).
 *
 * All routes are under /v1/storage/gcs and require a valid bearer token. The
 * GCS HMAC interop secret is stored server-side (encrypted at rest) and NEVER
 * returned to the client.
 *
 * Config endpoints:
 *   POST   /v1/storage/gcs/config      - set/update GCS config
 *   GET    /v1/storage/gcs/config      - read non-secret info
 *   DELETE /v1/storage/gcs/config      - remove GCS config
 *
 * Object proxy endpoints (single well-known object):
 *   GET    /v1/storage/gcs/object/graphvault-vault.json - download vault blob
 *   PUT    /v1/storage/gcs/object/graphvault-vault.json - upload vault blob
 *   DELETE /v1/storage/gcs/object/graphvault-vault.json - delete vault blob
 *
 * Only the single well-known vault file is proxied - same minimal, auditable
 * surface as the S3 adapter (one PUT per save, one GET per load).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { badRequest } from '../errors.js';
import type { AuthContext } from '../services/auth.js';
import type { Services } from '../services/index.js';

/** The only object key proxied through. Must match the client adapter. */
export const GCS_VAULT_OBJECT_KEY = 'graphvault-vault.json';

/**
 * Validate the GCS config payload. Defined locally (the shared package is not
 * editable in this wave); mirrors the s3ConfigRequestSchema shape and limits.
 */
const gcsConfigRequestSchema = z.object({
  /** GCS bucket name. */
  bucket: z.string().min(1).max(222),
  /** HMAC interop access ID. */
  accessId: z.string().min(1).max(256),
  /** HMAC interop secret. The secret - encrypted at rest, never returned. */
  secret: z.string().min(1).max(1024),
  /** Optional object-key prefix; must be empty or end with "/". */
  prefix: z
    .string()
    .max(512)
    .refine((p) => p === '' || p.endsWith('/'), 'prefix must be empty or end with "/"')
    .optional(),
});

export function registerGcsRoutes(
  app: FastifyInstance,
  services: Services,
  config: ServerConfig,
): void {
  const auth = (request: FastifyRequest): Promise<AuthContext> =>
    services.auth.authenticate(request.headers.authorization);

  // ---- Config: store GCS credentials ----

  app.post('/v1/storage/gcs/config', async (request, reply) => {
    const { user } = await auth(request);
    const parsed = gcsConfigRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid GCS configuration', parsed.error.flatten());
    }
    await services.gcs.saveConfig(user.id, parsed.data);
    return reply.code(201).send({ ok: true });
  });

  // ---- Config: read non-secret info ----

  app.get('/v1/storage/gcs/config', async (request, reply) => {
    const { user } = await auth(request);
    const info = await services.gcs.getConfigInfo(user.id);
    if (!info) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'GCS is not configured' } });
    }
    return reply.send(info);
  });

  // ---- Config: delete ----

  app.delete('/v1/storage/gcs/config', async (request, reply) => {
    const { user } = await auth(request);
    await services.gcs.deleteConfig(user.id);
    return reply.code(204).send();
  });

  // ---- Object proxy: GET (download) ----

  app.get(`/v1/storage/gcs/object/${GCS_VAULT_OBJECT_KEY}`, async (request, reply) => {
    const { user } = await auth(request);
    const { content, contentType } = await services.gcs.proxyGet(user.id, GCS_VAULT_OBJECT_KEY);
    return reply.code(200).header('content-type', contentType).send(content);
  });

  // ---- Object proxy: PUT (upload) ----

  // The vault object can be large, so this proxy PUT opts into the blob-sized cap.
  app.put(
    `/v1/storage/gcs/object/${GCS_VAULT_OBJECT_KEY}`,
    { bodyLimit: config.maxBlobBytes },
    async (request, reply) => {
      const { user } = await auth(request);

      const rawBody = request.body;
      let body: Buffer;
      if (Buffer.isBuffer(rawBody)) {
        body = rawBody;
      } else if (typeof rawBody === 'string') {
        body = Buffer.from(rawBody, 'utf8');
      } else if (rawBody !== null && rawBody !== undefined) {
        body = Buffer.from(JSON.stringify(rawBody), 'utf8');
      } else {
        body = Buffer.alloc(0);
      }

      const contentType =
        (request.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
      const status = await services.gcs.proxyPut(user.id, GCS_VAULT_OBJECT_KEY, body, contentType);
      return reply.code(status >= 200 && status < 300 ? 200 : status).send();
    },
  );

  // ---- Object proxy: DELETE ----

  app.delete(`/v1/storage/gcs/object/${GCS_VAULT_OBJECT_KEY}`, async (request, reply) => {
    const { user } = await auth(request);
    await services.gcs.proxyDelete(user.id, GCS_VAULT_OBJECT_KEY);
    return reply.code(204).send();
  });

  // ---- Reject requests for any other object keys ----

  const rejectOther = (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(400)
      .send({ error: { code: 'BAD_REQUEST', message: 'Only graphvault-vault.json is proxied' } });

  app.get('/v1/storage/gcs/object/*', rejectOther);
  app.put('/v1/storage/gcs/object/*', rejectOther);
  app.delete('/v1/storage/gcs/object/*', rejectOther);
}
