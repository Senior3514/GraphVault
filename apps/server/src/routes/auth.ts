import type { FastifyInstance } from 'fastify';
import { loginRequestSchema, registerRequestSchema } from '@graphvault/shared';
import type { ServerConfig } from '../config.js';
import { badRequest } from '../errors.js';
import type { Services } from '../services/index.js';

/** Auth routes (§5.1): register and login, both returning an AuthToken. */
export function registerAuthRoutes(
  app: FastifyInstance,
  services: Services,
  config: ServerConfig,
): void {
  // Stricter rate limit on credential endpoints to slow credential stuffing and
  // brute-force attempts, independent of (and below) the global cap.
  const authRateLimit = {
    config: {
      rateLimit: {
        max: config.authRateLimitMax,
        timeWindow: config.rateLimitWindowMs,
      },
    },
  };

  app.post('/v1/auth/register', authRateLimit, async (request, reply) => {
    const parsed = registerRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid registration request', parsed.error.flatten());
    }
    const token = await services.auth.register(parsed.data);
    return reply.code(201).send(token);
  });

  app.post('/v1/auth/login', authRateLimit, async (request) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid login request', parsed.error.flatten());
    }
    return services.auth.login(parsed.data);
  });
}
