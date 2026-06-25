# docker

Self-hosted deployment assets for GraphVault: a multi-stage server image and a
Compose stack that brings up the sync server backed by PostgreSQL.

## Contents

| File                    | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `server.Dockerfile`     | Multi-stage build for `@graphvault/server` (runs as `node` user). |
| `env.example`           | Copy to `.env` and edit before bringing the stack up.             |
| `../docker-compose.yml` | `server` + PostgreSQL stack, with container hardening.            |

## Quickstart

From the repository root:

```bash
cp docker/env.example .env       # then edit secrets (POSTGRES_PASSWORD, CORS, …)
docker compose up -d --build
curl http://127.0.0.1:4000/v1/health
```

This brings up the sync server backed by PostgreSQL with durable on-disk storage
for blob bytes. The database schema is created with `prisma db push` (the repo
ships no migration files in 0.1.0), run automatically as the server container's
start command — so the tables exist on first boot.

Create the first user:

```bash
curl -X POST http://127.0.0.1:4000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-strong-passphrase","deviceName":"laptop"}'
```

## Production notes

- **TLS.** The server speaks plain HTTP and is meant to sit **behind** a
  TLS-terminating reverse proxy (Caddy or nginx). Do not expose port 4000
  directly to the public internet. `docker-compose.yml` includes a commented
  Caddy `proxy` service as a starting point.
- **Container hardening.** Both services run with `no-new-privileges` and drop
  all Linux capabilities; the server has a read-only root filesystem with
  explicit tmpfs/volume mounts and runs as the unprivileged `node` user.
- **Config + preflight.** Set `GRAPHVAULT_CORS_ORIGIN` to your exact web origin
  and keep `GRAPHVAULT_TRUST_PROXY` / `GRAPHVAULT_REQUIRE_HTTPS` on — the server
  refuses to boot in production with an open CORS policy or with HTTPS disabled.

Full instructions — env reference, TLS/Caddyfile, backups, restore, upgrades —
are in [`../docs/deployment.md`](../docs/deployment.md) and the VPS hardening
checklist in [`../docs/hardening.md`](../docs/hardening.md). The server env
reference lives in [`../apps/server/README.md`](../apps/server/README.md).
