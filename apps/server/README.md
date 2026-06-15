# @graphvault/server

GraphVault's self-hosted sync server. Implements the wire protocol in
[`docs/sync-protocol.md`](../../docs/sync-protocol.md): auth, vault registration,
pull/push sync with deterministic conflict detection, and content-addressed blob
storage.

## Layout

```
src/
  app.ts            Fastify wiring: content parsers, error envelope, routes
  index.ts          Process entrypoint (loads config, ensures dataDir, listens)
  config.ts         Env-only configuration
  errors.ts         AppError + JSON error envelope (matches apiErrorSchema)
  routes/           Thin HTTP handlers (auth, vaults, blobs)
  services/         Business logic, decoupled from Fastify and reusable
    auth.ts         register/login, bearer-token auth, Argon2id (scrypt fallback)
    vault.ts        vault create/list + ownership checks
    sync.ts         pull (changes) + push with the §6 three-way conflict model
    blob.ts         blob put/get/has with hash re-verification
    crypto.ts       password hashing + opaque token helpers
  store/            Persistence abstraction (named `store` to avoid the repo's
                    root `.gitignore` `storage/` rule)
    types.ts        Storage interface + entity records
    memory.ts       InMemoryStorage (default; dev/test, non-durable)
    prisma.ts       Prisma/PostgreSQL adapter (loaded via dynamic import)
    blob-store.ts   Content-addressed blob bytes on disk
prisma/schema.prisma  PostgreSQL schema (spec §3)
test/                 node:test integration tests via app.inject()
```

## Configuration

All configuration is via environment variables — see [`.env.example`](./.env.example).

| Var                              | Default      | Meaning                                                |
| -------------------------------- | ------------ | ------------------------------------------------------ |
| `GRAPHVAULT_HOST`                | `127.0.0.1`  | Listen host                                            |
| `GRAPHVAULT_PORT`                | `4000`       | Listen port                                            |
| `GRAPHVAULT_CORS_ORIGIN`         | `*`          | Comma-separated origins, or `*`                        |
| `GRAPHVAULT_DATA_DIR`            | `./storage`  | Where blob bytes live on disk                          |
| `GRAPHVAULT_STORAGE`             | `memory`     | `memory` or `postgres`                                 |
| `DATABASE_URL`                   | —            | Postgres DSN (required for `postgres`)                 |
| `GRAPHVAULT_MAX_BLOB_BYTES`      | `67108864`   | Max blob upload size (64 MiB)                          |
| `GRAPHVAULT_RATE_LIMIT_MAX`      | `300`        | Max requests per window per client (global)            |
| `GRAPHVAULT_RATE_LIMIT_WINDOW`   | `60000`      | Rate-limit window, in milliseconds                     |
| `GRAPHVAULT_AUTH_RATE_LIMIT_MAX` | `10`         | Stricter per-window cap on `/v1/auth/*`                |
| `GRAPHVAULT_TRUST_PROXY`         | `false`      | Trust `X-Forwarded-*` from a fronting proxy            |
| `GRAPHVAULT_REQUIRE_HTTPS`       | prod: `true` | Reject plaintext (honors `X-Forwarded-Proto`)          |
| `GRAPHVAULT_ENCRYPTION_KEY`      | —            | base64 32-byte AES-256 key for at-rest blob encryption |

## Storage backends

- **memory** (default): `InMemoryStorage`, ideal for development and tests. No
  external dependencies; data is lost on restart.
- **postgres**: Prisma + PostgreSQL. The generated Prisma client is loaded with
  a dynamic import, so the default in-memory path builds and runs without a
  database or a generated client. To use it:

  ```bash
  export DATABASE_URL=postgresql://user:pass@localhost:5432/graphvault
  pnpm --filter @graphvault/server prisma:generate   # generates the client
  pnpm --filter @graphvault/server prisma:migrate     # applies migrations
  GRAPHVAULT_STORAGE=postgres pnpm --filter @graphvault/server start
  ```

## Develop / run / test

```bash
pnpm --filter @graphvault/server dev         # watch mode (tsx)
pnpm --filter @graphvault/server build       # tsc -b
pnpm --filter @graphvault/server typecheck
pnpm --filter @graphvault/server test        # node:test via tsx
pnpm --filter @graphvault/server start       # node dist/index.js
```

## Security notes

See [`docs/security-basics.md`](../../docs/security-basics.md) for the fuller
deployment writeup (Milestone 10 docs). The hardening below is implemented here:

- Passwords are hashed with Argon2id (scrypt fallback if the native addon is
  unavailable) and never logged. The `Authorization` and `Cookie` headers are
  redacted in logs; request bodies are never logged.
- Bearer tokens are opaque, random, stored only as SHA-256 hashes, expire, and
  are bound to a device.
- Every vault route checks that the authenticated user owns the vault.
- Blob uploads are re-hashed server-side and rejected on mismatch. The `:hash`
  path param is validated against `sha256:<64 hex>` before any filesystem
  access, so it can never be used for path traversal. All request bodies are
  validated against the zod schemas in `@graphvault/shared`.
- **Rate limiting** (`@fastify/rate-limit`): a global per-client cap plus a
  stricter cap on `/v1/auth/*` to slow credential stuffing and brute force.
  Exceeding it returns `429` with the standard error envelope.
- **Security headers** (`@fastify/helmet`): sensible defaults for a JSON +
  blob API (no inline scripts). HSTS is enabled when HTTPS is required.
- **Transport.** A TLS-terminating reverse proxy (Caddy/nginx) fronts the server
  in production. Set `GRAPHVAULT_TRUST_PROXY=true` so the server reads
  `X-Forwarded-For` / `X-Forwarded-Proto` correctly (client IPs for rate
  limiting, HTTPS detection). With `GRAPHVAULT_REQUIRE_HTTPS` (on by default in
  `production`) plaintext requests are rejected unless `X-Forwarded-Proto` is
  `https`. Local `http` dev is unaffected.
- **At-rest blob encryption (optional).** Set `GRAPHVAULT_ENCRYPTION_KEY` to a
  base64-encoded 32-byte key to transparently encrypt blob bytes on disk with
  AES-256-GCM (random nonce per blob, authenticated; on-disk layout is
  `[nonce][tag][ciphertext]`). The content hash remains the hash of the
  **plaintext**, so dedupe and the wire protocol are unchanged. A malformed key
  makes the server fail fast. Keep the key secret and backed up — losing it
  makes encrypted blobs unrecoverable. Unset = plaintext (legacy behavior).
- **No telemetry.** Logs stay local; the server makes no outbound calls except
  the database connection you configure.

### Verify your posture

`GET /v1/server-info` reports non-sensitive config flags (storage backend,
`encryptionAtRest`, rate-limit settings, `requireHttps`, `trustProxy`,
`maxBlobBytes`) so ops/clients can confirm the deployment. It never exposes
secrets, keys, or connection strings.
