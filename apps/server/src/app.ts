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
import { registerAzureRoutes } from './routes/azure.js';
import { registerGcsRoutes } from './routes/gcs.js';
import { registerClipRoutes } from './routes/clip.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerSnapshotRoutes } from './routes/snapshots.js';
import { registerInboxRoutes } from './routes/inbox.js';
import { DEFAULT_INBOX_AUDIT_CAP } from './services/inbox.js';
import type { Storage } from './store/types.js';
import type { SnapshotStore } from './store/snapshot-store.js';

export interface AppOptions {
  /**
   * Inject a pre-built storage backend (used by tests against
   * {@link InMemoryStorage}). When omitted, storage is built from `config`.
   */
  storage?: Storage;
  /**
   * Inject a snapshot store (tests use {@link InMemorySnapshotStore}). Only used
   * when the snapshot feature is enabled in `config`; otherwise ignored.
   */
  snapshotStore?: SnapshotStore;
  /**
   * Inject a clock (ms since epoch) for the snapshot service so tests can age
   * entries deterministically (TTL / expiry). Defaults to `Date.now`.
   */
  snapshotNow?: () => number;
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
    // Global cap applies to JSON / non-blob routes. The blob PUT route opts into
    // the larger `maxBlobBytes` cap via a per-route `bodyLimit` (see blobs.ts),
    // so a giant JSON payload can't exhaust memory on the auth/push endpoints.
    bodyLimit: config.maxJsonBytes,
    // Behind a reverse proxy that terminates TLS, trust X-Forwarded-* so client
    // IPs (rate limiting) and proto (HTTPS detection) are read correctly.
    trustProxy: config.trustProxy,
    // --- connection hardening (env-configurable; safe defaults in config.ts) ---
    // Bound how long a single request may take to arrive (Slowloris defense) and
    // how long idle keep-alive sockets and header-less connections live, so a
    // hostile or broken client can't pin server resources open indefinitely.
    requestTimeout: config.requestTimeoutMs,
    keepAliveTimeout: config.keepAliveTimeoutMs,
    connectionTimeout: config.connectionTimeoutMs,
    // Reject absurdly long URL path params early (e.g. a forged `:hash`).
    maxParamLength: config.maxParamLength,
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
  const services = createServices(storage, config.dataDir, {
    encryptionKey: config.encryptionKey,
    aiDailyCap: config.aiDailyCap,
    snapshots: config.snapshotsEnabled
      ? {
          maxBytes: config.snapshotMaxBytes,
          maxCount: config.snapshotMaxCount,
          ttlDays: config.snapshotTtlDays,
          now: options.snapshotNow,
        }
      : undefined,
    snapshotStore: options.snapshotStore,
    inbox: config.inboxEnabled
      ? {
          maxBytes: config.inboxMaxBytes,
          maxAuditEntries: DEFAULT_INBOX_AUDIT_CAP,
        }
      : undefined,
  });

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
    maxJsonBytes: config.maxJsonBytes,
    // Server-proxied storage adapters: the route is always registered, so the
    // browser can store credentials server-side and never touch the provider.
    // `credentialsEncryptedAtRest` reports whether a persistent server key backs
    // the at-rest AES-GCM encryption (vs a process-lifetime key).
    // `credentialsPersisted` reports whether the stored (encrypted) credentials
    // survive a restart — true on the durable `postgres` backend, false on the
    // ephemeral in-memory backend. NEVER exposes account names, keys, or any
    // secret material.
    storageProxies: {
      s3: { available: true },
      webdav: { available: true },
      azure: { available: true },
      gcs: { available: true },
      credentialsEncryptedAtRest: config.encryptionKey !== undefined,
      credentialsPersisted: config.storage === 'postgres',
    },
    // Public, opt-in graph-snapshot store. Off by default; only non-sensitive
    // posture flags are exposed (no payloads, no ids).
    snapshots: {
      enabled: config.snapshotsEnabled,
      maxBytes: config.snapshotMaxBytes,
    },
    // "Connect anything" inbound webhook. Enabled by default (a token must be
    // minted by an authenticated user before anything can be posted). Only
    // non-sensitive posture flags are exposed (no tokens, no audit data).
    inbox: {
      enabled: config.inboxEnabled,
      maxBytes: config.inboxMaxBytes,
    },
  }));

  // --- Milestone 2: auth, vaults, sync, blobs ---
  registerAuthRoutes(app, services, config);
  registerVaultRoutes(app, services);
  registerBlobRoutes(app, services, config);

  // --- Milestone 18: WebDAV proxy storage ---
  registerWebDavRoutes(app, services, config);

  // --- Milestone 18: S3-compatible storage proxy ---
  registerS3Routes(app, services, config);

  // --- Wave 16: Azure Blob + Google Cloud Storage proxies (creds never in browser) ---
  registerAzureRoutes(app, services, config);
  registerGcsRoutes(app, services, config);

  // --- Milestone 22: URL web-clipper (server-side fetch + HTML→Markdown) ---
  registerClipRoutes(app, services);

  // --- AI proxy (BFF): server-side AI key storage + chat proxy ---
  registerAiRoutes(app, services);

  // --- Wave 18: opt-in public graph-snapshot store (short share links). When
  //     disabled (the default), no routes are registered → /v1/snapshots* 404s. ---
  registerSnapshotRoutes(app, services, config);

  // --- Wave 19: "connect anything" inbound webhook + per-connector audit log.
  //     Enabled by default; an inbound token must be minted by an authenticated
  //     user before the public POST /v1/inbox/:token endpoint can create a note.
  registerInboxRoutes(app, services, config);

  return app;
}
