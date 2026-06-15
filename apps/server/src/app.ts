import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { GRAPHVAULT_API_VERSION, SYNC_PROTOCOL_VERSION } from '@graphvault/shared';
import type { ServerConfig } from './config.js';
import { AppError, errorEnvelope } from './errors.js';
import { createStorage, type StorageHandle } from './store/index.js';
import { createServices } from './services/index.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerVaultRoutes } from './routes/vaults.js';
import { registerBlobRoutes } from './routes/blobs.js';
import type { Storage } from './store/types.js';

export interface AppOptions {
  /**
   * Inject a pre-built storage backend (used by tests against
   * {@link InMemoryStorage}). When omitted, storage is built from `config`.
   */
  storage?: Storage;
}

/**
 * Build the Fastify app. Kept separate from `listen` so tests can inject
 * requests without binding a socket. When `options.storage` is provided it is
 * used directly; otherwise the configured backend is constructed and torn down
 * on `app.close()`.
 */
export async function buildApp(
  config: ServerConfig,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: Math.max(config.maxBlobBytes, 1024 * 1024),
    logger: {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
      // No remote log shipping by default — logs stay local.
      // Never log Authorization headers or request bodies (may contain secrets).
      redact: ['req.headers.authorization'],
    },
  });

  await app.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((o) => o.trim()),
  });

  // Parse raw bytes for blob uploads (content is opaque; never JSON).
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );
  // Some clients PUT blobs with no/other content types; accept raw bytes too.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // --- storage + services ---
  let storageHandle: StorageHandle | undefined;
  let storage: Storage;
  if (options.storage) {
    storage = options.storage;
  } else {
    storageHandle = await createStorage(config);
    storage = storageHandle.storage;
  }
  const services = createServices(storage, config.dataDir);

  app.addHook('onClose', async () => {
    if (storageHandle) await storageHandle.close();
  });

  // --- error handling: render everything as the standard JSON envelope ---
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .send(errorEnvelope(error.code, error.message, error.details));
    }
    if (error instanceof ZodError) {
      return reply.code(400).send(errorEnvelope('BAD_REQUEST', 'Invalid request', error.flatten()));
    }
    // Fastify's own validation / payload-too-large / parse errors.
    const statusCode = error.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send(errorEnvelope(error.code ?? 'BAD_REQUEST', error.message));
    }
    request.log.error(error);
    return reply.code(500).send(errorEnvelope('INTERNAL', 'Internal server error'));
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send(errorEnvelope('NOT_FOUND', 'Route not found'));
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

  // --- Milestone 2: auth, vaults, sync, blobs ---
  registerAuthRoutes(app, services);
  registerVaultRoutes(app, services);
  registerBlobRoutes(app, services);

  return app;
}
