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
  routes/           Thin HTTP handlers (auth, vaults, blobs, webdav, s3, azure,
                    gcs, ai, clip, snapshots, inbox)
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

| Var                                  | Default      | Meaning                                                |
| ------------------------------------ | ------------ | ------------------------------------------------------ |
| `GRAPHVAULT_HOST`                    | `127.0.0.1`  | Listen host                                            |
| `GRAPHVAULT_PORT`                    | `4000`       | Listen port                                            |
| `GRAPHVAULT_CORS_ORIGIN`             | `*`          | Comma-separated origins, or `*`                        |
| `GRAPHVAULT_DATA_DIR`                | `./storage`  | Where blob bytes live on disk                          |
| `GRAPHVAULT_STORAGE`                 | `memory`     | `memory` or `postgres`                                 |
| `DATABASE_URL`                       | —            | Postgres DSN (required for `postgres`)                 |
| `GRAPHVAULT_MAX_BLOB_BYTES`          | `67108864`   | Max blob upload size (64 MiB)                          |
| `GRAPHVAULT_RATE_LIMIT_MAX`          | `300`        | Max requests per window per client (global)            |
| `GRAPHVAULT_RATE_LIMIT_WINDOW`       | `60000`      | Rate-limit window, in milliseconds                     |
| `GRAPHVAULT_AUTH_RATE_LIMIT_MAX`     | `10`         | Stricter per-window cap on `/v1/auth/*`                |
| `GRAPHVAULT_TRUST_PROXY`             | `false`      | Trust `X-Forwarded-*` from a fronting proxy            |
| `GRAPHVAULT_REQUIRE_HTTPS`           | prod: `true` | Reject plaintext (honors `X-Forwarded-Proto`)          |
| `GRAPHVAULT_ENCRYPTION_KEY`          | —            | base64 32-byte AES-256 key for at-rest blob encryption |
| `GRAPHVAULT_MAX_JSON_BYTES`          | `1048576`    | Max body size for JSON / non-blob routes (1 MiB)       |
| `GRAPHVAULT_REQUEST_TIMEOUT_MS`      | `30000`      | Max time to fully receive a request before aborting    |
| `GRAPHVAULT_KEEP_ALIVE_TIMEOUT_MS`   | `72000`      | Idle keep-alive socket lifetime (keep above proxy's)   |
| `GRAPHVAULT_CONNECTION_TIMEOUT_MS`   | `60000`      | Max time a socket may stay open without headers        |
| `GRAPHVAULT_MAX_PARAM_LENGTH`        | `256`        | Max length of a single URL path param (e.g. `:hash`)   |
| `GRAPHVAULT_AI_DAILY_CAP`            | `200`        | Per-user/day request cap on the AI proxy (`0` = off)   |
| `GRAPHVAULT_SNAPSHOTS_ENABLED`       | `false`      | Opt-in public graph-snapshot store (off = routes 404)  |
| `GRAPHVAULT_SNAPSHOT_MAX_BYTES`      | `400000`     | Max encoded snapshot payload size (413 over)           |
| `GRAPHVAULT_SNAPSHOT_MAX_COUNT`      | `5000`       | Max stored snapshots; oldest evicted first             |
| `GRAPHVAULT_SNAPSHOT_TTL_DAYS`       | `30`         | Snapshot expiry in days (swept on read; `0` = never)   |
| `GRAPHVAULT_SNAPSHOT_RATE_LIMIT_MAX` | `20`         | Stricter per-window cap on `POST /v1/snapshots`        |
| `GRAPHVAULT_INBOX_ENABLED`           | `true`       | "Connect anything" inbound webhook (off = routes 404)  |
| `GRAPHVAULT_INBOX_MAX_BYTES`         | `1000000`    | Max rendered inbound note size (413 over)              |
| `GRAPHVAULT_INBOX_RATE_LIMIT_MAX`    | `30`         | Stricter per-window cap on `POST /v1/inbox/:token`     |

## Public graph-snapshot store (opt-in, off by default)

A minimal, abuse-resistant store that lets the web client share a **read-only**
graph via a **short** url (`/embed?id=<id>`) instead of a giant encoded blob in
the URL. The snapshot payload is an **opaque, already-encoded string**
(gzip+base64url of a graph JSON) the client produces; the server stores and
returns it **verbatim** and never parses or executes it beyond size validation.

It is **off by default** (`GRAPHVAULT_SNAPSHOTS_ENABLED=false`). When disabled,
every `/v1/snapshots*` route returns `404` — the feature is invisible. Snapshots
are **unauthenticated public shares** (no account): anyone with the short id can
read it, so only enable it if you intend to host public read-only graph shares.

Endpoints (only registered when enabled):

| Method   | Path                | Auth | Body                      | Success                       |
| -------- | ------------------- | ---- | ------------------------- | ----------------------------- |
| `POST`   | `/v1/snapshots`     | none | `{ data: string }`        | `201 { id, deleteToken }`     |
| `GET`    | `/v1/snapshots/:id` | none | —                         | `200 { id, data, createdAt }` |
| `DELETE` | `/v1/snapshots/:id` | none | `{ deleteToken: string }` | `204`                         |

- `POST` rejects an empty payload (`400`) and one over `GRAPHVAULT_SNAPSHOT_MAX_BYTES`
  (`413`). Ids are random URL-safe base64url (`^[A-Za-z0-9_-]{16,32}$`). The route
  counts against the global rate limit **and** carries a stricter per-window cap
  (`GRAPHVAULT_SNAPSHOT_RATE_LIMIT_MAX`) to deter abuse.
- `GET` validates the id format before any filesystem access (path-traversal
  guard) and sweeps **expired** entries (`GRAPHVAULT_SNAPSHOT_TTL_DAYS`), so an
  expired or unknown id returns `404`.
- Storage is capped at `GRAPHVAULT_SNAPSHOT_MAX_COUNT` with **oldest-first
  eviction**, so it can't grow unbounded.
- `DELETE` is gated behind a one-time **`deleteToken`** returned from `POST`
  (there is no owner/account). The token is stored hashed (SHA-256) and compared
  in constant time; a party who only knows the public share id cannot delete or
  grief the snapshot. Wrong/missing token → `403`, unknown id → `404`.

## "Connect anything" inbound webhook (Wave 19)

Lets an external service (Zapier, an email forwarder, IFTTT, a `curl` in cron, …)
POST Markdown to a **per-connector token** and have it land as a **new note** in
the user's vault, with a per-connector **audit log**. It reuses the existing,
tested blob + sync services — the content hash is the `sha256` of the **plaintext**
note bytes, exactly like the rest of the protocol.

It is **on by default** (`GRAPHVAULT_INBOX_ENABLED=true`): the public inbound
endpoint does nothing until an authenticated user explicitly mints a token. Set
the flag to `false` to remove every `/v1/inbox*` route (the feature becomes
invisible — `404`).

| Method   | Path                   | Auth | Body                                   | Success                                                                 |
| -------- | ---------------------- | ---- | -------------------------------------- | ----------------------------------------------------------------------- |
| `POST`   | `/v1/inbox/tokens`     | yes  | `{ vaultId, label }`                   | `201 { id, token, label }` (token once)                                 |
| `GET`    | `/v1/inbox/tokens`     | yes  | —                                      | `200 [{ id, vaultId, label, createdAt, lastUsedAt }]`                   |
| `DELETE` | `/v1/inbox/tokens/:id` | yes  | —                                      | `204`                                                                   |
| `GET`    | `/v1/inbox/log`        | yes  | —                                      | `200 [{ id, tokenId, source, path, bytes, status, at }]` (newest first) |
| `POST`   | `/v1/inbox/:token`     | none | `{ title?, markdown, tags?, source? }` | `201 { path }`                                                          |

- A token binds `(userId, vaultId, label)`. Minting verifies the caller **owns**
  the vault. Only the token's **SHA-256 hash** is stored; the raw token is
  returned **once** at creation and never appears in the list (which exposes
  neither the token nor its hash).
- `POST /v1/inbox/:token` is **unauthenticated — the token is the credential**.
  It is resolved by `hashToken(:token)`; an unknown/revoked token → `404` (we
  never leak which tokens exist). The route is size-capped
  (`GRAPHVAULT_INBOX_MAX_BYTES` → `413`) and carries a stricter per-window cap
  (`GRAPHVAULT_INBOX_RATE_LIMIT_MAX`).
- **No clobber (data-safety first).** The note is written to a **guaranteed-new**
  vault-relative path `Inbox/<sanitized-source-or-'webhook'>-<short-id>.md`. The
  `source` is sanitized to `[A-Za-z0-9_-]` (no traversal, always ends `.md`), and
  the path is verified absent before writing (a fresh id is drawn on the
  astronomically-unlikely collision). An inbound post can therefore never
  overwrite an existing note; if the underlying push still reported a conflict it
  returns `409` and records a `rejected` audit entry rather than retrying blindly.
- Every attempt (`accepted` / `rejected`) is appended to a per-user, capped
  (last 500, oldest evicted) audit log, readable via `GET /v1/inbox/log`.

## AI proxy / BFF (BYO-key, M22)

A backend-for-frontend that lets the web client use an AI assistant **without
the browser ever holding the AI API key**. The user configures their key
(OpenRouter or a direct provider) once; the server stores it encrypted at rest
(AES-256-GCM, key derived from `GRAPHVAULT_ENCRYPTION_KEY` or a process-lifetime
key when unset) and **never returns it to the client**. The browser sends only
the chat prompt; the key is attached server-side. All routes require a bearer
token.

| Method   | Path            | Body                           | Returns                                |
| -------- | --------------- | ------------------------------ | -------------------------------------- |
| `POST`   | `/v1/ai/config` | `{ apiKey, gateway?, model? }` | `204` (key stored encrypted at rest)   |
| `GET`    | `/v1/ai/config` | —                              | `{ keySet, gateway, model }` (no key)  |
| `DELETE` | `/v1/ai/config` | —                              | `204` (removes the config)             |
| `POST`   | `/v1/ai/chat`   | chat-completion request        | forwarded completion from the upstream |

`POST /v1/ai/chat` is bounded by `GRAPHVAULT_AI_DAILY_CAP` (per-user/day request
cap; default `200`, `0` = unlimited — discouraged in production without
key-level billing controls).

## URL web-clipper (M22)

| Method | Path       | Auth | Body      | Returns                          |
| ------ | ---------- | ---- | --------- | -------------------------------- |
| `POST` | `/v1/clip` | yes  | `{ url }` | `{ title, markdown, sourceUrl }` |

`POST /v1/clip` fetches a web page server-side and converts it to clean
Markdown. The URL is validated against an SSRF guard before any fetch, and the
route inherits the global rate limit.

## Storage backends

- **memory** (default): `InMemoryStorage`, ideal for development and tests. No
  external dependencies; **all** data — including provider/AI credentials and
  inbox tokens/audit — is lost on restart.
- **postgres**: Prisma + PostgreSQL. The generated Prisma client is loaded with
  a dynamic import, so the default in-memory path builds and runs without a
  database or a generated client. On this backend everything is durable,
  including the server-proxied storage / AI credentials (stored as AES-256-GCM
  ciphertext) and the inbox tokens + audit log — they survive a restart. To use
  it:

  ```bash
  export DATABASE_URL=postgresql://user:pass@localhost:5432/graphvault
  pnpm --filter @graphvault/server prisma:generate   # generates the client
  # Create/update the tables. The repo ships NO migration files in 0.1.0, so use
  # `db push` (idempotent, matches docker-compose.yml) rather than migrate deploy:
  pnpm --filter @graphvault/server exec prisma db push --skip-generate
  GRAPHVAULT_STORAGE=postgres pnpm --filter @graphvault/server start
  ```

  > The `prisma:migrate` script (`prisma migrate deploy`) is reserved for a
  > future versioned-migration workflow; with no `prisma/migrations/` directory
  > committed it creates no tables. Use `prisma db push` to materialize the
  > schema from `prisma/schema.prisma` directly — this is what the Compose stack
  > runs on every boot.

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
`maxBlobBytes`, and a `storageProxies` block listing the available cloud-storage
proxies plus whether their credentials are encrypted at rest with a persistent
key (`credentialsEncryptedAtRest`) and whether they are persisted across a
restart (`credentialsPersisted`, true on the `postgres` backend)) so ops/clients
can confirm the deployment. It never exposes secrets, keys, account names, or
connection strings.

## Server-proxied cloud storage (BFF)

A GraphVault vault is a single JSON blob (`graphvault-vault.json`). You can keep
that blob in any of several cloud-storage backends **without the browser ever
holding the provider credentials** — the server stores them encrypted at rest
and proxies the one object. Each adapter exposes exactly three operations
(`GET` / `PUT` / `DELETE`) on the single well-known object; any other key is
rejected with `400`. Credentials are encrypted with AES-256-GCM, the key derived
via HKDF from `GRAPHVAULT_ENCRYPTION_KEY` (or a process-lifetime key when unset)
with a per-provider info string, and are **never** returned to the client.

| Provider             | Routes prefix        | Auth scheme                               | New deps |
| -------------------- | -------------------- | ----------------------------------------- | -------- |
| S3-compatible        | `/v1/storage/s3`     | AWS SigV4 (`node:crypto`)                 | none     |
| WebDAV               | `/v1/storage/webdav` | Basic (encrypted password)                | none     |
| Azure Blob Storage   | `/v1/storage/azure`  | Shared Key HMAC-SHA256 (`node:crypto`)    | none     |
| Google Cloud Storage | `/v1/storage/gcs`    | AWS SigV4 over GCS XML API (interop HMAC) | none     |

Each provider has the same endpoint shape:

```
POST   /v1/storage/<p>/config      # store/update credentials (encrypted at rest)
GET    /v1/storage/<p>/config      # read NON-secret info (no key is ever returned)
DELETE /v1/storage/<p>/config      # remove credentials
GET    /v1/storage/<p>/object/graphvault-vault.json   # download the vault blob
PUT    /v1/storage/<p>/object/graphvault-vault.json   # upload the vault blob
DELETE /v1/storage/<p>/object/graphvault-vault.json   # delete the vault blob
```

**Azure Blob Storage** — config: `account`, `container`, `accountKey` (base64
account key; the secret), optional `endpoint` (for Azurite/testing; defaults to
`https://<account>.blob.core.windows.net`). Requests use the Shared Key scheme
with `x-ms-version: 2021-08-06` and `x-ms-blob-type: BlockBlob` on PUT.

**Google Cloud Storage** — config: `bucket`, `accessId` + `secret` (a GCS HMAC
interop key pair; the secret is encrypted), optional `prefix`. Requests target
the GCS S3-compatible XML API (`https://storage.googleapis.com`) signed with AWS
SigV4 (`service=s3`, `region=auto`). Create an HMAC key in the Cloud console
under _Cloud Storage → Settings → Interoperability_.

No additional environment variables are required for any provider — users
configure their credentials via the `POST .../config` endpoint after signing in.
