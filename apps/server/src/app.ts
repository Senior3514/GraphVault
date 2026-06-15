import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { GRAPHVAULT_API_VERSION, SYNC_PROTOCOL_VERSION } from '@graphvault/shared';
import type { ServerConfig } from './config.js';

/**
 * Build the Fastify app. Kept separate from `listen` so tests can inject
 * requests without binding a socket.
 */
export async function buildApp(config: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
      // No remote log shipping by default — logs stay local.
    },
  });

  await app.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((o) => o.trim()),
  });

  // --- Milestone 0: hello world + health to validate wiring ---

  app.get('/', async () => ({
    name: 'GraphVault sync server',
    tagline: 'Local-first notes. Self-hosted sync. A graph you can think in.',
    apiVersion: GRAPHVAULT_API_VERSION,
    syncProtocolVersion: SYNC_PROTOCOL_VERSION,
  }));

  app.get('/v1/health', async () => ({
    status: 'ok',
    apiVersion: GRAPHVAULT_API_VERSION,
    syncProtocolVersion: SYNC_PROTOCOL_VERSION,
    time: new Date().toISOString(),
  }));

  return app;
}
