import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthContext } from '../services/auth.js';
import type { Services } from '../services/index.js';

/**
 * Blob upload/download (§5.5). Bytes are content-addressed; the server
 * recomputes the hash on PUT and rejects mismatches. All blob routes require a
 * valid bearer token (blobs are private to the deployment).
 */
export function registerBlobRoutes(app: FastifyInstance, services: Services): void {
  const auth = (request: FastifyRequest): Promise<AuthContext> =>
    services.auth.authenticate(request.headers.authorization);

  app.head('/v1/blobs/:hash', async (request, reply) => {
    await auth(request);
    const { hash } = request.params as { hash: string };
    const present = await services.blob.has(hash);
    return reply.code(present ? 200 : 404).send();
  });

  app.get('/v1/blobs/:hash', async (request, reply) => {
    await auth(request);
    const { hash } = request.params as { hash: string };
    const bytes = await services.blob.get(hash);
    if (!bytes) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Blob not found' } });
    return reply
      .code(200)
      .header('content-type', 'application/octet-stream')
      .header('content-length', bytes.length)
      .send(bytes);
  });

  app.put('/v1/blobs/:hash', async (request, reply) => {
    await auth(request);
    const { hash } = request.params as { hash: string };
    const body = request.body;
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from((body as Buffer | Uint8Array) ?? []);
    const result = await services.blob.put(hash, bytes);
    return reply.code(201).send(result);
  });
}
