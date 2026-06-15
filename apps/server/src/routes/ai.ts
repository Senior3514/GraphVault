/**
 * AI proxy routes.
 *
 * All routes are under /v1/ai and require a valid bearer token.
 * The AI API key is stored server-side (encrypted at rest) and NEVER returned
 * to the client.
 *
 * Config endpoints:
 *   POST   /v1/ai/config   — save/update AI key + gateway config
 *   GET    /v1/ai/config   — read non-secret info (keySet + gateway + model)
 *   DELETE /v1/ai/config   — remove AI config
 *
 * Chat proxy:
 *   POST   /v1/ai/chat     — forward a chat completion request to the upstream
 *                            gateway using the stored key
 *
 * Security notes:
 *   - The API key is never returned to the client.
 *   - Error messages are sanitised to prevent key leaks.
 *   - A per-user/day cap protects against runaway usage.
 *   - The global @fastify/rate-limit cap also applies.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { aiConfigRequestSchema, aiChatRequestSchema } from '@graphvault/shared';
import { badRequest } from '../errors.js';
import type { AuthContext } from '../services/auth.js';
import type { Services } from '../services/index.js';

export function registerAiRoutes(app: FastifyInstance, services: Services): void {
  const auth = (request: FastifyRequest): Promise<AuthContext> =>
    services.auth.authenticate(request.headers.authorization);

  // ---- Config: save/update AI key ----

  app.post('/v1/ai/config', async (request, reply) => {
    const { user } = await auth(request);
    const parsed = aiConfigRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid AI configuration', parsed.error.flatten());
    }
    // Validate that custom gateway includes a baseUrl.
    if (parsed.data.gateway === 'custom' && !parsed.data.baseUrl) {
      throw badRequest('baseUrl is required when gateway is "custom"');
    }
    await services.ai.saveConfig(user.id, parsed.data);
    return reply.code(201).send({ ok: true });
  });

  // ---- Config: read non-secret info ----

  app.get('/v1/ai/config', async (request, reply) => {
    const { user } = await auth(request);
    const info = await services.ai.getConfigInfo(user.id);
    if (!info) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'AI is not configured' } });
    }
    return reply.send(info);
  });

  // ---- Config: delete ----

  app.delete('/v1/ai/config', async (request, reply) => {
    const { user } = await auth(request);
    await services.ai.deleteConfig(user.id);
    return reply.code(204).send();
  });

  // ---- Chat proxy ----

  app.post('/v1/ai/chat', async (request, reply) => {
    const { user } = await auth(request);
    const parsed = aiChatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid chat request', parsed.error.flatten());
    }
    const { messages, model } = parsed.data;
    const result = await services.ai.chat(user.id, messages, model);
    return reply.send(result);
  });
}
