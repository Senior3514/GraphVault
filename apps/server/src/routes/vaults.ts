import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  pushRequestSchema,
  registerVaultRequestSchema,
  type PushOp,
} from '@graphvault/shared';
import { badRequest } from '../errors.js';
import type { AuthContext } from '../services/auth.js';
import type { Services } from '../services/index.js';

/**
 * Vault registration (§5.2) and sync (§5.3/§5.4). Every route authenticates the
 * bearer token and, for vault-scoped routes, enforces ownership.
 */
export function registerVaultRoutes(app: FastifyInstance, services: Services): void {
  const auth = (request: FastifyRequest): Promise<AuthContext> =>
    services.auth.authenticate(request.headers.authorization);

  app.post('/v1/vaults', async (request, reply) => {
    const { user } = await auth(request);
    const parsed = registerVaultRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid vault registration request', parsed.error.flatten());
    }
    const result = await services.vault.create(user.id, parsed.data.name);
    return reply.code(201).send(result);
  });

  app.get('/v1/vaults', async (request) => {
    const { user } = await auth(request);
    return services.vault.list(user.id);
  });

  app.get('/v1/vaults/:id/changes', async (request) => {
    const { user } = await auth(request);
    const { id } = request.params as { id: string };
    await services.vault.requireOwned(user.id, id);

    const query = request.query as { since?: string; limit?: string };
    const since = parseNonNegativeInt(query.since, 0);
    const limit = query.limit === undefined ? undefined : parseNonNegativeInt(query.limit, 0);
    return services.sync.changes(id, since, limit);
  });

  app.post('/v1/vaults/:id/push', async (request) => {
    const { user, device } = await auth(request);
    const { id } = request.params as { id: string };
    await services.vault.requireOwned(user.id, id);

    const parsed = pushRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid push request', parsed.error.flatten());
    }
    // The push must come from the authenticated device.
    if (parsed.data.deviceId !== device.id) {
      throw badRequest('deviceId does not match the authenticated device');
    }
    const ops: PushOp[] = parsed.data.ops;
    return services.sync.push(id, ops);
  });
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
