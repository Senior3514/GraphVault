# GraphVault - live deployment on this VPS

Deployed 2026-07-24 on `srv950910` (public IP 168.231.110.18).

## Access model: Tailscale, not the public internet

The server listens on **127.0.0.1:4000 only**. Tailscale fronts it with
automatic TLS on the tailnet, so the vault is reachable from your own devices
at:

```
https://srv950910-3.tailfbaba4.ts.net
```

and from **nowhere else**. No public port is open, no DNS record is needed, and
there is no certificate to renew.

This deliberately replaces the original "expose `api.<domain>` and
`mcp.<domain>` publicly with Caddy + Let's Encrypt" plan, for two reasons:

1. **The MCP server is stdio-only.** `packages/mcp` constructs
   `StdioServerTransport` (`packages/mcp/src/index.ts`) - it has no HTTP/SSE
   transport and therefore no network listener and no authentication layer of
   its own. Publishing `mcp.<domain>` was not possible without first writing a
   network wrapper, and an unauthenticated MCP endpoint on the public internet
   is exactly the "vault fully exposed" outcome to avoid.
2. **Tailscale removes the whole exposure question.** Private mesh, auto-TLS,
   no open port, no attack surface to harden. The vault is personal, so a
   personal-network boundary is the correct one.

Postgres is on the internal Docker network only and is **not** published
(verified: nothing listening on 5432).

## Remaining manual step (needs root, once)

Tailscale's proxy config requires root. Run **either**:

```bash
# One-off:
sudo tailscale serve --bg --https=443 http://127.0.0.1:4000

# Or, to let your user manage tailscale from now on without sudo:
sudo tailscale set --operator=$USER
tailscale serve --bg --https=443 http://127.0.0.1:4000
```

Then verify:

```bash
curl -s https://srv950910-3.tailfbaba4.ts.net/v1/health
# expect: {"status":"ok",...}
```

Until this runs, `https://srv950910-3.tailfbaba4.ts.net` will not resolve to
the server. The stack itself is already up and healthy behind it.

## What is running

```bash
cd /home/pikachu/graphvault
sg docker -c "docker compose ps"
```

- `graphvault-db-1` - Postgres 16, internal network only, healthchecked.
- `graphvault-server-1` - Fastify, `127.0.0.1:4000`, read-only rootfs, all
  Linux capabilities dropped, runs as uid 1000, `restart: unless-stopped`
  (so both come back automatically on reboot).

Health check (simulating the TLS proxy, since the server correctly refuses
plaintext):

```bash
curl -s -H "X-Forwarded-Proto: https" http://127.0.0.1:4000/v1/health
```

## Secrets

`/home/pikachu/graphvault/.env`, mode `600`, gitignored, never committed.
Generated strong values for `POSTGRES_PASSWORD` and
`GRAPHVAULT_ENCRYPTION_KEY` (at-rest blob encryption). No default/placeholder
value remains.

**`GRAPHVAULT_ENCRYPTION_KEY` is unrecoverable if lost** - blobs encrypted with
it cannot be decrypted. The backup script below captures it alongside every
dump for exactly this reason.

## Backups - verified, not just configured

`ops/backup.sh` captures all three things a real restore needs:

- `db.sql.gz` - Postgres logical dump
- `blobs.tar.gz` - the blob volume
- `encryption-key.env` - the at-rest key (mode 600)

Runs nightly at 03:17 via cron, keeps 14 days, writes to
`/home/pikachu/graphvault-backups/`.

**Restore was tested end to end**, not assumed: the dump was restored into a
scratch database and produced 16/16 tables with zero errors.

To restore for real:

```bash
cd /home/pikachu/graphvault
B=/home/pikachu/graphvault-backups/<STAMP>
zcat $B/db.sql.gz | sg docker -c "docker compose exec -T db psql -U graphvault -d graphvault"
sg docker -c "docker run --rm -v graphvault_blob-data:/data -v $B:/backup alpine \
  tar xzf /backup/blobs.tar.gz -C /data"
# and restore GRAPHVAULT_ENCRYPTION_KEY from $B/encryption-key.env into .env
```

## Connecting Claude to the vault (MCP)

Because the MCP server is stdio, it runs **locally on the machine running your
Claude client**, and talks to this VPS over the tailnet. That machine must be
on the tailnet.

You need, from the running server: a bearer token (register a user / device via
the web client), and your vault id or name.

Claude Code:

```bash
claude mcp add graphvault \
  --env GRAPHVAULT_SERVER_URL=https://srv950910-3.tailfbaba4.ts.net \
  --env GRAPHVAULT_TOKEN=<your-bearer-token> \
  --env GRAPHVAULT_VAULT_NAME=<your-vault-name> \
  --env GRAPHVAULT_DEVICE_ID=<device-id-for-write-access> \
  -- node /path/to/graphvault/packages/mcp/dist/index.js
```

Claude Desktop (`mcpServers` block):

```json
{
  "mcpServers": {
    "graphvault": {
      "command": "node",
      "args": ["/path/to/graphvault/packages/mcp/dist/index.js"],
      "env": {
        "GRAPHVAULT_SERVER_URL": "https://srv950910-3.tailfbaba4.ts.net",
        "GRAPHVAULT_TOKEN": "<your-bearer-token>",
        "GRAPHVAULT_VAULT_NAME": "<your-vault-name>",
        "GRAPHVAULT_DEVICE_ID": "<device-id-for-write-access>"
      }
    }
  }
}
```

`GRAPHVAULT_DEVICE_ID` is what unlocks the write tools. Omit it for a
read-only connection.

Tools exposed: `list_notes`, `read_note`, `search_notes`, `get_backlinks`,
`graph_neighbors`, `vault_stats` (read) and `create_note`, `update_note`,
`append_to_note`, `delete_note` (write, device-id gated).

## Web client

Point the web app at this server by setting:

```
NEXT_PUBLIC_GRAPHVAULT_SERVER_URL=https://srv950910-3.tailfbaba4.ts.net
```

Note the consequence of the Tailscale model: a browser can only reach that URL
if the device is on the tailnet. A Vercel-hosted client on a non-tailnet device
will not reach it - which is the intended tradeoff (private by default). To use
the hosted client from anywhere, the server would have to be published
publicly, which reintroduces the exposure this deployment avoids.

## Honest gaps

- **No versioned DB migrations.** The repo ships `schema.prisma` with no
  `prisma/migrations/`, so the container runs `prisma db push
  --accept-data-loss` on start. Idempotent and fine for a personal vault, but
  it has no rollback story and can drop columns on a schema change. Committing
  real migrations and switching to `migrate deploy` is the fix.
- **MCP has no auth of its own** - it inherits whatever `GRAPHVAULT_TOKEN`
  grants. Fine for a local stdio process; it is why this is not exposed to a
  network.
- **Prisma OpenSSL warning** in the server log is cosmetic (it defaults to
  openssl-1.1.x and works), not an error.
- The firewall/fail2ban hardening from the original plan was **not** applied,
  because nothing is published publicly here - only Tailscale reaches the
  service. If this is ever published, do that hardening first.
