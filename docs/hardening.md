# GraphVault VPS Hardening Checklist

> A concrete, do-it-once checklist for running the self-hosted GraphVault sync
> server safely on a public VPS. It complements [`deployment.md`](./deployment.md)
> (how to run the stack) and [`security-model.md`](./security-model.md) (what the
> server defends against). Work top to bottom; each step is independent.

The server speaks plain HTTP and is designed to sit **behind a TLS-terminating
reverse proxy**, never exposed directly. The startup **preflight** enforces the
non-negotiable parts of this in production (see the last section).

## 1. TLS reverse proxy (nginx)

Terminate TLS at nginx and proxy to the server over loopback. The critical
header is `X-Forwarded-Proto` — the server reads it (with `TRUST_PROXY=true`) to
satisfy its HTTPS requirement and to detect the real scheme.

```nginx
server {
    listen 443 ssl http2;
    server_name notes.example.com;

    ssl_certificate     /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # Upload cap — keep in step with GRAPHVAULT_MAX_BLOB_BYTES (64 MiB default).
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # REQUIRED
        proxy_read_timeout 75s;                        # > KEEP_ALIVE_TIMEOUT
    }
}

# Redirect plaintext to HTTPS.
server {
    listen 80;
    server_name notes.example.com;
    return 301 https://$host$request_uri;
}
```

Use **certbot** (`certbot --nginx -d notes.example.com`) for free, auto-renewing
certificates, or let Caddy do it (see the commented `proxy` service in
`docker-compose.yml`). Set on the server side:

```bash
GRAPHVAULT_TRUST_PROXY=true
GRAPHVAULT_REQUIRE_HTTPS=true
GRAPHVAULT_CORS_ORIGIN=https://your-web-origin   # NOT '*'
```

Keep the server published to loopback only (`127.0.0.1:4000:4000` in compose) so
nothing can reach it except the proxy.

## 2. Firewall (UFW)

Allow only SSH and HTTP(S); deny everything else inbound. The server port stays
closed to the world — nginx reaches it over loopback.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

## 3. Intrusion throttling (fail2ban)

The server rate-limits `/v1/auth/*` in-app, but fail2ban adds an IP-level ban
for SSH and for repeated proxy abuse.

```bash
sudo apt install fail2ban
sudo cp /etc/fail2ban/jail.conf /etc/fail2ban/jail.local
# Enable the [sshd] jail (on by default in jail.local) and, optionally, an
# [nginx-limit-req] / [nginx-http-auth] jail pointed at your access/error logs.
sudo systemctl enable --now fail2ban
sudo fail2ban-client status
```

## 4. Run as a hardened systemd service (non-Docker hosts)

If you run the built server directly (not via Docker), confine it with systemd.
Create a dedicated unprivileged user and a unit that drops privileges, makes the
filesystem read-only except the data dir, and forbids privilege escalation.

```ini
# /etc/systemd/system/graphvault.service
[Unit]
Description=GraphVault sync server
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=graphvault
Group=graphvault
WorkingDirectory=/opt/graphvault
EnvironmentFile=/etc/graphvault/graphvault.env
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=on-failure
RestartSec=5

# --- hardening ---
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
MemoryDenyWriteExecute=true
# The ONLY writable path: the blob data dir (GRAPHVAULT_DATA_DIR).
ReadWritePaths=/var/lib/graphvault

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin graphvault
sudo install -d -o graphvault -g graphvault /var/lib/graphvault
sudo systemctl daemon-reload
sudo systemctl enable --now graphvault
sudo systemctl status graphvault
```

`SIGTERM` (which `systemctl stop` sends) triggers the server's graceful shutdown:
it drains in-flight requests via `app.close()`, then exits 0. Put your secrets
(`DATABASE_URL`, `GRAPHVAULT_ENCRYPTION_KEY`, …) in
`/etc/graphvault/graphvault.env` with `chmod 600`, owned by root.

> Running via **Docker Compose** instead? The same controls are already wired
> into `docker-compose.yml`: `no-new-privileges`, `cap_drop: ALL`, a read-only
> root filesystem with an explicit `tmpfs` and the `blob-data` volume, a non-root
> user, and CPU/memory limits.

## 5. Unattended security upgrades

Keep the host patched automatically.

```bash
sudo apt install unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
# Confirm security updates apply automatically:
cat /etc/apt/apt.conf.d/50unattended-upgrades
```

For container images, rebuild and redeploy on a cadence
(`docker compose build --pull server && docker compose up -d`) so base-image CVEs
get picked up; back up first (next section).

## 6. Backups

Back up **both** PostgreSQL and the blob directory, and the encryption key
separately. See [`deployment.md` — Backups](./deployment.md#backups) for the exact
commands. Automate a daily dump (a cron job or systemd timer), keep several
days off-host, and **test a restore** at least once — an untested backup is a
hope, not a backup. If `GRAPHVAULT_ENCRYPTION_KEY` is set, store it in a separate
secret manager; the blob archive is unrecoverable without it.

## 7. Strong secrets

- `POSTGRES_PASSWORD`: a long random string (`openssl rand -base64 24`), never
  the example default.
- `GRAPHVAULT_ENCRYPTION_KEY`: `openssl rand -base64 32` (exactly 32 bytes
  decoded; a malformed key fails the server fast on boot).
- Register the first user immediately after boot — registration is open by
  design; restrict it at the proxy if you do not want it reachable publicly.

## How the preflight enforces safe config

On startup in production (`NODE_ENV=production`), the server runs a
[`preflight`](../apps/server/src/preflight.ts) audit and **refuses to boot** on
any of these errors, printing an actionable message and exiting non-zero:

- `GRAPHVAULT_CORS_ORIGIN` is `*` — set an explicit origin allowlist.
- `GRAPHVAULT_REQUIRE_HTTPS` is false — plaintext would be accepted.
- `GRAPHVAULT_STORAGE=postgres` with no `DATABASE_URL`.

It additionally **warns** (boots, but logs) when:

- the host binds all interfaces (`0.0.0.0`/`::`) but `GRAPHVAULT_TRUST_PROXY` is
  off — rate limiting and HTTPS detection would key on the proxy, not the client;
- `GRAPHVAULT_ENCRYPTION_KEY` is unset — blobs are stored as plaintext on disk.

In development and test the preflight is a no-op, so local plain-HTTP work is
unaffected. This makes a misconfigured production deployment fail loudly at boot
rather than quietly serving an open, plaintext API.
