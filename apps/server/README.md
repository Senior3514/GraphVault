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

| Var                        | Default      | Meaning                                   |
| -------------------------- | ------------ | ----------------------------------------- |
| `GRAPHVAULT_HOST`          | `127.0.0.1`  | Listen host                               |
| `GRAPHVAULT_PORT`          | `4000`       | Listen port                               |
| `GRAPHVAULT_CORS_ORIGIN`   | `*`          | Comma-separated origins, or `*`           |
| `GRAPHVAULT_DATA_DIR`      | `./storage`  | Where blob bytes live on disk             |
| `GRAPHVAULT_STORAGE`       | `memory`     | `memory` or `postgres`                    |
| `DATABASE_URL`             | —            | Postgres DSN (required for `postgres`)    |
| `GRAPHVAULT_MAX_BLOB_BYTES`| `67108864`   | Max blob upload size (64 MiB)             |

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

- Passwords are hashed with Argon2id (scrypt fallback if the native addon is
  unavailable) and never logged. The `Authorization` header is redacted in logs.
- Bearer tokens are opaque, random, stored only as SHA-256 hashes, expire, and
  are bound to a device.
- Every vault route checks that the authenticated user owns the vault.
- Blob uploads are re-hashed server-side and rejected on mismatch.
