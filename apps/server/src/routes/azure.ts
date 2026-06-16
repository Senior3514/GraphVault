/**
 * Azure Blob Storage proxy routes (Wave 16).
 *
 * All routes are under /v1/storage/azure and require a valid bearer token.
 * The Azure account key is stored server-side (encrypted at rest) and NEVER
 * returned to the client.
 *
 * Config endpoints:
 *   POST   /v1/storage/azure/config      — set/update Azure config
 *   GET    /v1/storage/azure/config      — read non-secret info
 *   DELETE /v1/storage/azure/config      — remove Azure config
 *
 * Object proxy endpoints (single well-known object):
 *   GET    /v1/storage/azure/object/graphvault-vault.json — download vault blob
 *   PUT    /v1/storage/azure/object/graphvault-vault.json — upload vault blob
 *   DELETE /v1/storage/azure/object/graphvault-vault.json — delete vault blob
 *
 * Only the single well-known vault file is proxied — same minimal, auditable
 * surface as the S3 adapter (one PUT per save, one GET per load).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { badRequest } from '../errors.js';
import type { AuthContext } from '../services/auth.js';
import type { Services } from '../services/index.js';

/** The only object key proxied through. Must match the client adapter. */
export const AZURE_VAULT_OBJECT_KEY = 'graphvault-vault.json';

/**
 * Validate the Azure config payload. Defined locally (the shared package is not
 * editable in this wave); mirrors the s3ConfigRequestSchema shape and limits.
 */
const azureConfigRequestSchema = z.object({
  /** Storage account name (DNS label: lowercase letters + digits). */
  account: z
    .string()
    .min(3)
    .max(64)
    .refine((a) => /^[a-z0-9][a-z0-9-]*$/i.test(a), 'account must be a valid storage account name'),
  /** Blob container name. */
  container: z.string().min(1).max(63),
  /** Account key (base64). The secret — encrypted at rest, never returned. */
  accountKey: z
    .string()
    .min(1)
    .max(2048)
    .refine((k) => {
      // Must be valid base64 (Azure account keys are base64-encoded 64-byte keys).
      try {
        return Buffer.from(k, 'base64').length > 0;
      } catch {
        return false;
      }
    }, 'accountKey must be base64-encoded'),
  /**
   * Optional endpoint override (e.g. Azurite). Must be http(s) and is stored
   * verbatim (trailing slashes stripped at request time).
   */
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine((u) => /^https?:\/\//i.test(u), 'Azure endpoint must use http or https')
    .optional(),
});

export function registerAzureRoutes(
  app: FastifyInstance,
  services: Services,
  config: ServerConfig,
): void {
  const auth = (request: FastifyRequest): Promise<AuthContext> =>
    services.auth.authenticate(request.headers.authorization);

  // ---- Config: store Azure credentials ----

  app.post('/v1/storage/azure/config', async (request, reply) => {
    const { user } = await auth(request);
    const parsed = azureConfigRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid Azure configuration', parsed.error.flatten());
    }
    await services.azure.saveConfig(user.id, parsed.data);
    return reply.code(201).send({ ok: true });
  });

  // ---- Config: read non-secret info ----

  app.get('/v1/storage/azure/config', async (request, reply) => {
    const { user } = await auth(request);
    const info = await services.azure.getConfigInfo(user.id);
    if (!info) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Azure is not configured' } });
    }
    return reply.send(info);
  });

  // ---- Config: delete ----

  app.delete('/v1/storage/azure/config', async (request, reply) => {
    const { user } = await auth(request);
    await services.azure.deleteConfig(user.id);
    return reply.code(204).send();
  });

  // ---- Object proxy: GET (download) ----

  app.get(`/v1/storage/azure/object/${AZURE_VAULT_OBJECT_KEY}`, async (request, reply) => {
    const { user } = await auth(request);
    const { content, contentType } = await services.azure.proxyGet(user.id, AZURE_VAULT_OBJECT_KEY);
    return reply.code(200).header('content-type', contentType).send(content);
  });

  // ---- Object proxy: PUT (upload) ----

  // The vault object can be large, so this proxy PUT opts into the blob-sized cap.
  app.put(
    `/v1/storage/azure/object/${AZURE_VAULT_OBJECT_KEY}`,
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
      const status = await services.azure.proxyPut(
        user.id,
        AZURE_VAULT_OBJECT_KEY,
        body,
        contentType,
      );
      return reply.code(status >= 200 && status < 300 ? 200 : status).send();
    },
  );

  // ---- Object proxy: DELETE ----

  app.delete(`/v1/storage/azure/object/${AZURE_VAULT_OBJECT_KEY}`, async (request, reply) => {
    const { user } = await auth(request);
    await services.azure.proxyDelete(user.id, AZURE_VAULT_OBJECT_KEY);
    return reply.code(204).send();
  });

  // ---- Reject requests for any other object keys ----

  const rejectOther = (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(400)
      .send({ error: { code: 'BAD_REQUEST', message: 'Only graphvault-vault.json is proxied' } });

  app.get('/v1/storage/azure/object/*', rejectOther);
  app.put('/v1/storage/azure/object/*', rejectOther);
  app.delete('/v1/storage/azure/object/*', rejectOther);
}
