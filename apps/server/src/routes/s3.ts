/**
 * S3-compatible storage proxy routes (M18).
 *
 * All routes are under /v1/storage/s3 and require a valid bearer token.
 * The S3 credentials are stored server-side (encrypted at rest) and NEVER
 * returned to the client.
 *
 * Config endpoints:
 *   POST   /v1/storage/s3/config      — set/update S3 config
 *   GET    /v1/storage/s3/config      — read non-secret info
 *   DELETE /v1/storage/s3/config      — remove S3 config
 *
 * Object proxy endpoints (single well-known object):
 *   GET    /v1/storage/s3/object/graphvault-vault.json — download vault blob
 *   PUT    /v1/storage/s3/object/graphvault-vault.json — upload vault blob
 *   DELETE /v1/storage/s3/object/graphvault-vault.json — delete vault blob
 *
 * Only the single well-known vault file is proxied. This keeps the proxy
 * surface minimal and auditable — one PUT per save, one GET per load.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { s3ConfigRequestSchema } from '@graphvault/shared';
import { badRequest } from '../errors.js';
import type { AuthContext } from '../services/auth.js';
import type { Services } from '../services/index.js';

/** The only object key proxied through. Must match the client adapter. */
export const S3_VAULT_OBJECT_KEY = 'graphvault-vault.json';

export function registerS3Routes(app: FastifyInstance, services: Services): void {
  const auth = (request: FastifyRequest): Promise<AuthContext> =>
    services.auth.authenticate(request.headers.authorization);

  // ---- Config: store S3 credentials ----

  app.post('/v1/storage/s3/config', async (request, reply) => {
    const { user } = await auth(request);
    const parsed = s3ConfigRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid S3 configuration', parsed.error.flatten());
    }
    await services.s3.saveConfig(user.id, parsed.data);
    return reply.code(201).send({ ok: true });
  });

  // ---- Config: read non-secret info ----

  app.get('/v1/storage/s3/config', async (request, reply) => {
    const { user } = await auth(request);
    const info = await services.s3.getConfigInfo(user.id);
    if (!info) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'S3 is not configured' } });
    }
    return reply.send(info);
  });

  // ---- Config: delete ----

  app.delete('/v1/storage/s3/config', async (request, reply) => {
    const { user } = await auth(request);
    await services.s3.deleteConfig(user.id);
    return reply.code(204).send();
  });

  // ---- Object proxy: GET (download) ----

  app.get(`/v1/storage/s3/object/${S3_VAULT_OBJECT_KEY}`, async (request, reply) => {
    const { user } = await auth(request);
    const { content, contentType } = await services.s3.proxyGet(user.id, S3_VAULT_OBJECT_KEY);
    return reply.code(200).header('content-type', contentType).send(content);
  });

  // ---- Object proxy: PUT (upload) ----

  app.put(`/v1/storage/s3/object/${S3_VAULT_OBJECT_KEY}`, async (request, reply) => {
    const { user } = await auth(request);

    // Normalise body to Buffer regardless of how Fastify parsed it.
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
    const status = await services.s3.proxyPut(user.id, S3_VAULT_OBJECT_KEY, body, contentType);
    return reply.code(status >= 200 && status < 300 ? 200 : status).send();
  });

  // ---- Object proxy: DELETE ----

  app.delete(`/v1/storage/s3/object/${S3_VAULT_OBJECT_KEY}`, async (request, reply) => {
    const { user } = await auth(request);
    await services.s3.proxyDelete(user.id, S3_VAULT_OBJECT_KEY);
    return reply.code(204).send();
  });

  // ---- Reject requests for any other object keys ----

  app.get('/v1/storage/s3/object/*', async (_request, reply) => {
    return reply
      .code(400)
      .send({ error: { code: 'BAD_REQUEST', message: 'Only graphvault-vault.json is proxied' } });
  });

  app.put('/v1/storage/s3/object/*', async (_request, reply) => {
    return reply
      .code(400)
      .send({ error: { code: 'BAD_REQUEST', message: 'Only graphvault-vault.json is proxied' } });
  });

  app.delete('/v1/storage/s3/object/*', async (_request, reply) => {
    return reply
      .code(400)
      .send({ error: { code: 'BAD_REQUEST', message: 'Only graphvault-vault.json is proxied' } });
  });
}
