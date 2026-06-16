# GraphVault Deployment

> Status: Milestone 9 / 10. How to run the self-hosted GraphVault server with
> Docker Compose on a VPS or NAS, create the first user, configure TLS, and back
> up / restore your data. For the security rationale behind these steps, see
> [`security-basics.md`](./security-basics.md). For a concrete, step-by-step VPS
> hardening checklist (TLS proxy, UFW, fail2ban, a hardened systemd unit,
> unattended upgrades), see [`hardening.md`](./hardening.md).

> **Production preflight:** on first boot with `NODE_ENV=production` the server
> runs a safety preflight and **refuses to start** on an insecure config —
> `GRAPHVAULT_CORS_ORIGIN='*'`, `GRAPHVAULT_REQUIRE_HTTPS=false`, or
> `GRAPHVAULT_STORAGE=postgres` with no `DATABASE_URL` — printing an actionable
> message and exiting non-zero. It warns (but boots) on a missing encryption key
> or binding all interfaces without `GRAPHVAULT_TRUST_PROXY`. See
> [`hardening.md`](./hardening.md#how-the-preflight-enforces-safe-config).

## What you deploy

A `docker compose` stack with two services:

- **`server`** — the `@graphvault/server` sync API, built from
  `docker/server.Dockerfile`. Speaks plain HTTP on port `4000` and stores blob
  bytes on a persistent volume.
- **`db`** — PostgreSQL 16, the durable backend (`GRAPHVAULT_STORAGE=postgres`),
  on its own named volume.

In production you add a **reverse proxy** (Caddy/nginx) in front to terminate
TLS. The server is meant to sit behind it, not be exposed directly.

## Prerequisites

- A Linux host with **Docker** and the **Docker Compose plugin** (`docker
compose version`).
- A domain name pointing at the host (for TLS), if exposing publicly.

## Quickstart — `docker compose up`

From the repository root:

```bash
# 1. Create your environment file from the template and edit the secrets.
cp docker/env.example .env
$EDITOR .env        # set a strong POSTGRES_PASSWORD, CORS origin, etc.

# 2. Build the image and start the stack in the background.
docker compose up -d --build

# 3. Watch it come up; the server waits for the DB healthcheck first.
docker compose ps
docker compose logs -f server

# 4. Verify the health endpoint (published to loopback by default).
curl http://127.0.0.1:4000/v1/health
# { "status": "ok", "apiVersion": "v1", "syncProtocolVersion": 1, "time": ... }
```

The server container runs `prisma db push` before booting, so the PostgreSQL
schema is created/updated automatically on first start and on every upgrade (the
command is idempotent). The repo ships no versioned migrations yet; once they
exist under `apps/server/prisma/migrations`, switch the compose `command` to
`prisma migrate deploy`.

## First-user creation

GraphVault has no admin UI for accounts; create the first user by calling the
registration endpoint directly. Registration is open by design (single user /
small trusted team), so do it immediately after first boot and restrict access
at the proxy if needed.

```bash
curl -X POST http://127.0.0.1:4000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{
        "email": "you@example.com",
        "password": "a-long-strong-passphrase",
        "deviceName": "laptop"
      }'
```

The response is an `AuthToken`:

```json
{
  "accessToken": "…opaque…",
  "expiresAt": 1750000000,
  "userId": "…",
  "deviceId": "…"
}
```

Subsequent requests authenticate with `Authorization: Bearer <accessToken>`.
Logging in again later uses the same shape at `POST /v1/auth/login`.

## Environment reference

Set these in `.env` (read automatically by `docker compose`). Defaults shown are
the compose/app defaults.

| Variable                    | Default         | Used by     | Meaning                                                                   |
| --------------------------- | --------------- | ----------- | ------------------------------------------------------------------------- |
| `POSTGRES_USER`             | `graphvault`    | db + server | PostgreSQL role; also composed into `DATABASE_URL`.                       |
| `POSTGRES_PASSWORD`         | _(example)_     | db + server | PostgreSQL password. **Change this.**                                     |
| `POSTGRES_DB`               | `graphvault`    | db + server | PostgreSQL database name.                                                 |
| `GRAPHVAULT_HOST`           | `0.0.0.0`       | server      | Listen host inside the container (must be `0.0.0.0` in Docker).           |
| `GRAPHVAULT_PORT`           | `4000`          | server      | Listen port.                                                              |
| `GRAPHVAULT_STORAGE`        | `postgres`      | server      | Storage backend; `postgres` in compose (the app default is `memory`).     |
| `DATABASE_URL`              | _(composed)_    | server      | Postgres DSN; built from the `POSTGRES_*` vars in compose.                |
| `GRAPHVAULT_DATA_DIR`       | `/data`         | server      | On-disk blob storage; mapped to the `blob-data` volume.                   |
| `GRAPHVAULT_CORS_ORIGIN`    | _(your origin)_ | server      | Comma-separated allowed origins. **Production preflight rejects `*`.**    |
| `GRAPHVAULT_TRUST_PROXY`    | `true`          | server      | Trust `X-Forwarded-*` from the fronting proxy (compose default).          |
| `GRAPHVAULT_REQUIRE_HTTPS`  | `true`          | server      | Reject plaintext. **Production preflight rejects `false`.**               |
| `GRAPHVAULT_MAX_BLOB_BYTES` | `67108864`      | server      | Max blob upload size in bytes (64 MiB); blob PUT + cloud-storage proxies. |
| `GRAPHVAULT_MAX_JSON_BYTES` | `1048576`       | server      | Max body size for JSON / non-blob routes (1 MiB).                         |
| `GRAPHVAULT_ENCRYPTION_KEY` | _(unset)_       | server      | Optional 32-byte at-rest blob key (base64). Preflight warns if unset.     |

> The app itself defaults `GRAPHVAULT_HOST` to `127.0.0.1` and
> `GRAPHVAULT_STORAGE` to `memory`; the Docker image and compose file override
> these to `0.0.0.0` and `postgres` for a real deployment.

### Server-proxied cloud storage (optional)

In addition to the built-in sync store, the server can proxy a single vault blob
to an external object store so the **browser never holds the provider
credentials**. Four backends are supported, all dependency-free:
S3-compatible, WebDAV, **Azure Blob Storage** (Shared Key), and **Google Cloud
Storage** (S3-compatible XML API with HMAC interop keys, AWS SigV4). No extra
environment variables are required — users enter their credentials in Settings,
which are stored encrypted at rest (set `GRAPHVAULT_ENCRYPTION_KEY` so they
survive restarts) and proxied via `/v1/storage/{s3,webdav,azure,gcs}`. See
`apps/server/README.md` for the per-provider config fields. `GET /v1/server-info`
reports which proxies are available under `storageProxies`.

## Reverse proxy / TLS

Run the server behind a TLS-terminating proxy. `docker-compose.yml` includes a
commented `proxy` service using **Caddy**, which obtains and renews certificates
automatically. To enable it:

1. Point your domain's DNS at the host.
2. Create `docker/Caddyfile`:

   ```caddyfile
   notes.example.com {
       reverse_proxy server:4000
   }
   ```

3. Uncomment the `proxy` service and the `caddy-data` / `caddy-config` volumes in
   `docker-compose.yml`.
4. **Remove the `ports:` block from the `server` service** so only the proxy is
   publicly reachable; the proxy talks to `server:4000` over the internal Docker
   network.
5. `docker compose up -d` and browse to `https://notes.example.com`.

An nginx equivalent (TLS certs managed separately, e.g. with certbot):

```nginx
server {
    listen 443 ssl;
    server_name notes.example.com;
    # ssl_certificate / ssl_certificate_key ...
    location / {
        proxy_pass http://server:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Forward a trustworthy client IP (`X-Forwarded-For`) so server-side rate limiting
keys on the real client rather than the proxy.

## Backups

Back up **both** the database and the blob directory — see
[`security-basics.md`](./security-basics.md#backups) for why.

```bash
# 1. Database: logical dump via the running db container.
docker compose exec -T db \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > graphvault-db-$(date +%F).sql.gz

# 2. Blob bytes: archive the blob-data volume contents.
docker run --rm \
  -v graphvault_blob-data:/data:ro \
  -v "$PWD":/backup \
  busybox tar czf /backup/graphvault-blobs-$(date +%F).tar.gz -C /data .
```

> The volume name is `<project>_blob-data`, where `<project>` is the compose
> project name (defaults to the directory name). Check with
> `docker volume ls`.

If you set `GRAPHVAULT_ENCRYPTION_KEY`, back it up **separately and securely** —
the blob archive is unrecoverable without it.

## Restore

```bash
# Restore the database (stack up, DB reachable, schema applied):
gunzip -c graphvault-db-2026-06-15.sql.gz \
  | docker compose exec -T db psql -U "$POSTGRES_USER" "$POSTGRES_DB"

# Restore blob bytes into the volume:
docker run --rm \
  -v graphvault_blob-data:/data \
  -v "$PWD":/backup \
  busybox sh -c "cd /data && tar xzf /backup/graphvault-blobs-2026-06-15.tar.gz"
```

Restore the **blobs at or after the DB snapshot**: extra unreferenced blobs are
harmless, but a database referencing missing blob bytes will dangle. Restart the
stack afterward (`docker compose restart server`).

## Upgrades

```bash
git pull
docker compose build server
docker compose up -d
```

Because the server runs `prisma db push` on boot, the database schema is synced
automatically and idempotently during the restart. Take a fresh DB + blob backup
before upgrading. Container images are stateless — all durable state lives in the
`db-data` and `blob-data` volumes — so rebuilding the image never loses data.

## Troubleshooting

- **`server` keeps restarting** — check `docker compose logs server`. A common
  cause is the DB not being ready; the `depends_on … condition:
service_healthy` gate normally prevents this, but a misconfigured
  `DATABASE_URL` will surface here.
- **Health check fails** — `curl http://127.0.0.1:4000/v1/health` from the host;
  confirm the `ports:` mapping (or that the proxy is the intended entry point).
- **CORS errors in the web client** — set `GRAPHVAULT_CORS_ORIGIN` to the web
  app's exact origin.

## Web app (Vercel)

The Next.js web client (`apps/web`) deploys to Vercel as a static-rendered app.
It is **open-and-go**: no folder picker, no file-system permissions — the vault
is dynamic and ready the moment the page loads. On a static host it persists to
the browser; set a server URL to add multi-device sync.

### One-time setup

1. In Vercel, **Add New → Project** and import your fork of the GraphVault
   repository.
2. Keep **Root Directory** at the repo root (`./`) and the framework preset as
   **Other**. The committed root `vercel.json` drives the build:
   - install: `pnpm install --frozen-lockfile` (resolves the whole workspace),
   - build: `pnpm run build:web` (builds `@graphvault/shared`,
     `@graphvault/engine`, and `@graphvault/sync-core`, then the Next app),
   - output: `apps/web/out` — a fully static export (no server runtime).
3. _(Optional)_ Add an environment variable
   `NEXT_PUBLIC_GRAPHVAULT_SERVER_URL = https://your-server.example.com` to point
   the client at a self-hosted sync server. Omit it for a local-only,
   browser-persisted vault.
4. **Deploy.** Vercel gives you `https://<project>.vercel.app` — landing page at
   `/`, app at `/vault`, `/graph`, `/sync-status`, `/settings`.

### Enabling cloud sync

Static hosting serves the UI only; the sync server is a separate process. To get
multi-device sync, deploy the server (see the Docker section above) on a host
that can run Node + PostgreSQL — a VPS, Railway, Render, or Fly.io — put it
behind TLS, set `GRAPHVAULT_CORS_ORIGIN` to your Vercel origin, and set
`NEXT_PUBLIC_GRAPHVAULT_SERVER_URL` on the Vercel project to the server URL.
The Fastify server does not run on Vercel's serverless runtime as-is.
