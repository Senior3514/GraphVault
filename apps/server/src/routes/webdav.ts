/**
 * WebDAV proxy routes (M18).
 *
 * All routes are under /v1/storage/webdav and require a valid bearer token.
 * The WebDAV URL + credentials are stored server-side (encrypted at rest)
 * and NEVER returned to the client.
 *
 * Config endpoints:
 *   POST   /v1/storage/webdav/config      — set/update WebDAV config
 *   GET    /v1/storage/webdav/config      — read non-secret info
 *   DELETE /v1/storage/webdav/config      — remove WebDAV config
 *
 * Proxy endpoints (vault-relative paths via *-param):
 *   GET    /v1/storage/webdav/proxy/:path — download from WebDAV
 *   PUT    /v1/storage/webdav/proxy/:path — upload to WebDAV
 *   DELETE /v1/storage/webdav/proxy/:path — delete from WebDAV
 *
 * Rate limiting: inherits the global cap. Config writes share the global cap
 * (they are not credential endpoints — no need for the auth-tier cap).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { webdavConfigRequestSchema, webdavProxyPathSchema } from '@graphvault/shared';
import { badRequest } from '../errors.js';
import type { AuthContext } from '../services/auth.js';
import type { Services } from '../services/index.js';

export function registerWebDavRoutes(app: FastifyInstance, services: Services): void {
  const auth = (request: FastifyRequest): Promise<AuthContext> =>
    services.auth.authenticate(request.headers.authorization);

  // ---- Config: store WebDAV credentials ----

  app.post('/v1/storage/webdav/config', async (request, reply) => {
    const { user } = await auth(request);
    const parsed = webdavConfigRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid WebDAV configuration', parsed.error.flatten());
    }
    await services.webdav.saveConfig(user.id, parsed.data);
    return reply.code(201).send({ ok: true });
  });

  // ---- Config: read non-secret info ----

  app.get('/v1/storage/webdav/config', async (request, reply) => {
    const { user } = await auth(request);
    const info = await services.webdav.getConfigInfo(user.id);
    if (!info) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'WebDAV is not configured' } });
    }
    return reply.send(info);
  });

  // ---- Config: delete ----

  app.delete('/v1/storage/webdav/config', async (request, reply) => {
    const { user } = await auth(request);
    await services.webdav.deleteConfig(user.id);
    return reply.code(204).send();
  });

  // ---- Proxy: GET (download) ----

  app.get('/v1/storage/webdav/proxy/*', async (request, reply) => {
    const { user } = await auth(request);
    const proxyPath = extractProxyPath(request);
    const { content, contentType } = await services.webdav.proxyGet(user.id, proxyPath);
    return reply.code(200).header('content-type', contentType).send(content);
  });

  // ---- Proxy: PUT (upload) ----

  app.put('/v1/storage/webdav/proxy/*', async (request, reply) => {
    const { user } = await auth(request);
    const proxyPath = extractProxyPath(request);

    // Normalise the body to a Buffer regardless of how Fastify parsed it.
    // The wildcard content-type parser delivers a Buffer; the JSON parser
    // delivers a parsed object (when `Content-Type: application/json`).
    // In both cases, re-serialise to bytes for the proxy PUT.
    const rawBody = request.body;
    let body: Buffer;
    if (Buffer.isBuffer(rawBody)) {
      body = rawBody;
    } else if (typeof rawBody === 'string') {
      body = Buffer.from(rawBody, 'utf8');
    } else if (rawBody !== null && rawBody !== undefined) {
      // Parsed JSON object — re-serialise.
      body = Buffer.from(JSON.stringify(rawBody), 'utf8');
    } else {
      body = Buffer.alloc(0);
    }

    const contentType =
      (request.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
    const status = await services.webdav.proxyPut(user.id, proxyPath, body, contentType);
    return reply.code(status === 201 ? 201 : 204).send();
  });

  // ---- Proxy: DELETE ----

  app.delete('/v1/storage/webdav/proxy/*', async (request, reply) => {
    const { user } = await auth(request);
    const proxyPath = extractProxyPath(request);
    await services.webdav.proxyDelete(user.id, proxyPath);
    return reply.code(204).send();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract and validate the wildcard path from a proxy request.
 * Fastify stores the `*` wildcard in `request.params['*']`.
 */
function extractProxyPath(request: FastifyRequest): string {
  const raw = (request.params as Record<string, string>)['*'] ?? '';
  const parsed = webdavProxyPathSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`Invalid proxy path: ${raw}`);
  }
  return parsed.data;
}
