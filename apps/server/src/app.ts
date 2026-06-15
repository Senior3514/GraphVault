import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { GRAPHVAULT_API_VERSION, SYNC_PROTOCOL_VERSION } from '@graphvault/shared';
import type { ServerConfig } from './config.js';
import { AppError, errorEnvelope } from './errors.js';
import { createStorage, type StorageHandle } from './store/index.js';
import { createServices } from './services/index.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerVaultRoutes } from './routes/vaults.js';
import { registerBlobRoutes } from './routes/blobs.js';
import { registerWebDavRoutes } from './routes/webdav.js';
import { registerS3Routes } from './routes/s3.js';
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
    // Behind a reverse proxy that terminates TLS, trust X-Forwarded-* so client
    // IPs (rate limiting) and proto (HTTPS detection) are read correctly.
    trustProxy: config.trustProxy,
    logger: {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
      // No remote log shipping by default — logs stay local.
      // Never log Authorization headers or request bodies (may contain secrets).
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  // --- security headers (JSON API + opaque blob store; no inline scripts) ---
  await app.register(helmet, {
    // This server serves JSON and raw bytes, never HTML with inline scripts, so
    // the default restrictive CSP is fine and adds no risk.
    contentSecurityPolicy: true,
    // HSTS only makes sense once TLS is enforced; the proxy/browser handles it.
    hsts: config.requireHttps,
  });

  // --- HTTPS enforcement: reject plaintext when required (proxy terminates
  //     TLS, so honor X-Forwarded-Proto). Health stays reachable for probes. ---
  if (config.requireHttps) {
    app.addHook('onRequest', async (request, reply) => {
      const forwarded = request.headers['x-forwarded-proto'];
      const proto =
        typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : request.protocol;
      if (proto !== 'https') {
        return reply
          .code(403)
          .send(errorEnvelope('HTTPS_REQUIRED', 'Secure transport (HTTPS) is required'));
      }
    });
  }

  // --- rate limiting: a global cap, with a stricter cap on auth routes ---
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    // The plugin throws this value; returning an AppError makes the shared error
    // handler render the standard JSON envelope with a 429 status.
    errorResponseBuilder: (_request, context) =>
      new AppError(
        429,
        'RATE_LIMITED',
        `Too many requests; retry after ${Math.ceil(context.ttl / 1000)}s`,
      ) as unknown as object,
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
  const services = createServices(storage, config.dataDir, config.encryptionKey);

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

  // --- Milestone 8: non-sensitive posture flags so ops/clients can verify the
  //     deployment's security configuration. NEVER expose secrets/keys/DSNs. ---
  app.get('/v1/server-info', async () => ({
    apiVersion: GRAPHVAULT_API_VERSION,
    syncProtocolVersion: SYNC_PROTOCOL_VERSION,
    storage: config.storage,
    encryptionAtRest: config.encryptionKey !== undefined,
    rateLimit: {
      enabled: true,
      max: config.rateLimitMax,
      windowMs: config.rateLimitWindowMs,
      authMax: config.authRateLimitMax,
    },
    requireHttps: config.requireHttps,
    trustProxy: config.trustProxy,
    maxBlobBytes: config.maxBlobBytes,
  }));

  // --- Milestone 2: auth, vaults, sync, blobs ---
  registerAuthRoutes(app, services, config);
  registerVaultRoutes(app, services);
  registerBlobRoutes(app, services);

  // --- Milestone 18: WebDAV proxy storage ---
  registerWebDavRoutes(app, services);

  // --- Milestone 18: S3-compatible storage proxy ---
  registerS3Routes(app, services);

  return app;
}
