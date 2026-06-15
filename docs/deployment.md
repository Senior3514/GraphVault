# GraphVault Deployment

> Status: Milestone 9 / 10. How to run the self-hosted GraphVault server with
> Docker Compose on a VPS or NAS, create the first user, configure TLS, and back
> up / restore your data. For the security rationale behind these steps, see
> [`security-basics.md`](./security-basics.md).

## What you deploy

A `docker compose` stack with three services in production:

- **`server`** — the `@graphvault/server` sync API, built from
  `docker/server.Dockerfile`. Speaks plain HTTP on port `4000` internally and
  stores blob bytes on a persistent volume.
- **`db`** — PostgreSQL 16, the durable backend (`GRAPHVAULT_STORAGE=postgres`),
  on its own named volume.
- **`caddy`** — Caddy 2 reverse proxy (production only). Obtains and renews
  Let's Encrypt TLS certificates automatically. The only process reachable from
  the internet (ports 80 and 443). The server is never exposed directly.

---

## Deploy to a VPS in 5 minutes

### Prerequisites

- A Linux host with **Docker** (20.10+) and the **Docker Compose plugin v2**
  (`docker compose version`).
- A **domain name** with an **A record** pointing at the host (e.g.
  `notes.example.com → 1.2.3.4`). Let the record propagate before running the
  deploy script.
- Ports **80** and **443** open in the host firewall (`ufw allow 80/tcp` and
  `ufw allow 443/tcp`).

### Step 1 — Clone the repository

```bash
git clone https://github.com/your-org/graphvault.git
cd graphvault
```

### Step 2 — Configure `.env`

```bash
# The deploy script creates .env from docker/env.example on first run,
# but you can do it manually and edit before deploying:
cp docker/env.example .env
$EDITOR .env
```

Set at minimum these five variables:

| Variable | Example value | Notes |
|---|---|---|
| `DOMAIN` | `notes.example.com` | No `https://` prefix. Must resolve to this host. |
| `ACME_EMAIL` | `you@example.com` | Let's Encrypt registration address. |
| `POSTGRES_PASSWORD` | `$(openssl rand -hex 24)` | Change from the default. |
| `GRAPHVAULT_CORS_ORIGIN` | `https://notes.example.com` | Your web client's origin. |
| `GRAPHVAULT_ENCRYPTION_KEY` | _(see below)_ | Base64 32-byte AES key. |

Generate the encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Back up `GRAPHVAULT_ENCRYPTION_KEY` separately** (password manager, offline
copy). Losing it makes WebDAV/S3/AI credentials and encrypted blobs
unrecoverable — there is no recovery path.

### Step 3 — Deploy

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

The script:
1. Checks Docker and compose are available.
2. Creates `.env` from the template if it does not exist (and tells you which
   vars to set).
3. Validates that `DOMAIN`, `ACME_EMAIL`, and `POSTGRES_PASSWORD` are set.
4. Runs `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`.
5. Waits for the server health check to pass.
6. Prints `https://$DOMAIN/v1/health` and the registration command.

### Step 4 — Verify

```bash
chmod +x scripts/verify-deploy.sh
./scripts/verify-deploy.sh
```

The script checks:
- DNS resolves.
- TLS certificate is valid (curl verifies the chain against the system CA bundle).
- HTTP → HTTPS redirect works on port 80.
- `/v1/health` returns `{"status":"ok"}`.
- `/v1/server-info` returns a JSON object.
- Security headers are present (HSTS, X-Frame-Options, CSP, etc.).

### Step 5 — Register the first user

```bash
curl -X POST https://notes.example.com/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-strong-passphrase","deviceName":"laptop"}'
```

### Manual verification checklist

- [ ] DNS A record for `$DOMAIN` points at the host.
- [ ] Firewall allows ports 80 and 443.
- [ ] `./scripts/verify-deploy.sh` — all checks green.
- [ ] First user registered (endpoint above).
- [ ] Open the web client, set server URL to `https://$DOMAIN`, sign in.
- [ ] Create a note, sync, open on a second device — verify round-trip.
- [ ] `GRAPHVAULT_ENCRYPTION_KEY` is backed up securely (offline or in a
  password manager).
- [ ] Daily backup cron scheduled (see Backups section).

---

## Quickstart — local / dev (`docker compose up`)

From the repository root (no TLS, loopback only):

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

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `POSTGRES_USER` | `graphvault` | db + server | PostgreSQL role; also composed into `DATABASE_URL`. |
| `POSTGRES_PASSWORD` | _(example)_ | db + server | PostgreSQL password. **Change this.** |
| `POSTGRES_DB` | `graphvault` | db + server | PostgreSQL database name. |
| `GRAPHVAULT_HOST` | `0.0.0.0` | server | Listen host inside the container (must be `0.0.0.0` in Docker). |
| `GRAPHVAULT_PORT` | `4000` | server | Listen port. |
| `GRAPHVAULT_STORAGE` | `postgres` | server | Storage backend; `postgres` in compose (the app default is `memory`). |
| `DATABASE_URL` | _(composed)_ | server | Postgres DSN; built from the `POSTGRES_*` vars in compose. |
| `GRAPHVAULT_DATA_DIR` | `/data` | server | On-disk blob storage; mapped to the `blob-data` volume. |
| `GRAPHVAULT_CORS_ORIGIN` | `*` | server | Comma-separated allowed origins. Restrict in production. |
| `GRAPHVAULT_MAX_BLOB_BYTES` | `67108864` | server | Max blob upload size in bytes (64 MiB). |
| `GRAPHVAULT_TRUST_PROXY` | `false` | server | Set `true` when behind a reverse proxy (Caddy/nginx) so rate-limiting keys on real client IPs via `X-Forwarded-For`. Automatically set by `docker-compose.prod.yml`. |
| `GRAPHVAULT_REQUIRE_HTTPS` | `true` in prod | server | Reject plain-HTTP requests. Automatically enabled by `docker-compose.prod.yml`. |
| `GRAPHVAULT_ENCRYPTION_KEY` | _(unset)_ | server | **Base64-encoded 32-byte AES-256-GCM key** for at-rest blob encryption AND for WebDAV/S3/AI credential encryption. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. If unset, a process-lifetime key is used for credentials (lost on restart) and blobs are stored as plaintext. **Back this up.** |
| `GRAPHVAULT_AI_DAILY_CAP` | `200` | server | Per-user/day AI proxy request cap (0 = unlimited). |
| `DOMAIN` | _(unset)_ | caddy | Public hostname (e.g. `notes.example.com`). Required in production. |
| `ACME_EMAIL` | _(unset)_ | caddy | Let's Encrypt registration e-mail. Required in production. |

> The app itself defaults `GRAPHVAULT_HOST` to `127.0.0.1` and
> `GRAPHVAULT_STORAGE` to `memory`; the Docker image and compose file override
> these to `0.0.0.0` and `postgres` for a real deployment.

## Reverse proxy / TLS

The production compose overlay (`docker-compose.prod.yml`) runs Caddy in front
of the server. Caddy:

- Obtains and renews Let's Encrypt certificates automatically (no certbot cron).
- Terminates TLS and proxies to `server:4000` over the internal Docker network.
- Sets all security headers (`HSTS`, `X-Frame-Options`, `CSP`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`).
- Forwards `X-Forwarded-For` / `X-Forwarded-Proto` so the server sees real
  client IPs for rate limiting.

The configuration lives in `docker/Caddyfile`. It reads `{env.DOMAIN}` and
`{env.ACME_EMAIL}` from the container environment (injected by compose).

### nginx alternative

If you prefer nginx (TLS certs managed separately, e.g. with certbot):

```nginx
server {
    listen 443 ssl;
    server_name notes.example.com;
    ssl_certificate     /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https:; media-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" always;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name notes.example.com;
    return 301 https://$host$request_uri;
}
```

Set `GRAPHVAULT_TRUST_PROXY=true` and `GRAPHVAULT_REQUIRE_HTTPS=true` in `.env`
when using nginx.

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

### Automating backups (cron)

```cron
# /etc/cron.d/graphvault — daily backup at 02:00 UTC
0 2 * * * root cd /opt/graphvault && \
  docker compose exec -T db pg_dump -U graphvault graphvault | \
  gzip > /var/backups/graphvault-db-$(date +\%F).sql.gz && \
  docker run --rm -v graphvault_blob-data:/data:ro -v /var/backups:/backup \
  busybox tar czf /backup/graphvault-blobs-$(date +\%F).tar.gz -C /data .
```

Keep at least 7 days of backups offsite. Test a restore periodically.

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
docker compose -f docker-compose.yml -f docker-compose.prod.yml build server
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Because the server runs `prisma db push` on boot, the database schema is synced
automatically and idempotently during the restart. Take a fresh DB + blob backup
before upgrading. Container images are stateless — all durable state lives in the
`db-data` and `blob-data` volumes — so rebuilding the image never loses data.

## Troubleshooting

- **`server` keeps restarting** — check
  `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs server`.
  A common cause is the DB not being ready; the `depends_on … condition:
  service_healthy` gate normally prevents this, but a misconfigured
  `DATABASE_URL` will surface here.
- **Caddy fails to obtain a certificate** — ensure the DNS A record has
  propagated (`dig +short $DOMAIN`) and ports 80/443 are open. Check
  `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy`.
  Let's Encrypt has rate limits; staging certs can be tested by adding
  `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` inside
  the `tls` block of `docker/Caddyfile`.
- **Health check fails** — `curl https://$DOMAIN/v1/health`; confirm Caddy is
  running and the `server` container is healthy.
- **CORS errors in the web client** — set `GRAPHVAULT_CORS_ORIGIN` to the web
  app's exact origin (`https://notes.example.com`).
- **WebDAV/S3/AI credentials lost on restart** — set `GRAPHVAULT_ENCRYPTION_KEY`
  so credentials are encrypted with a durable key, not a process-lifetime key.

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
