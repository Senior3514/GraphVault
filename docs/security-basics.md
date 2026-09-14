# GraphVault Security Basics

> Status: Milestone 8 / 10. This document describes GraphVault's security model
> for a self-hosted v0 deployment: what the server protects, how, and what you
> as the operator are responsible for. It complements the protocol-level
> requirements in [`sync-protocol.md`](./sync-protocol.md) §4.

GraphVault is built for a single user or a small, trusted team running their own
server. It is **not** a hardened multi-tenant SaaS. The threat model is: protect
notes in transit and at rest, keep accounts and devices isolated, and never
silently lose data.

## Transport security (TLS)

The GraphVault server speaks **plain HTTP** and is designed to run **behind a
TLS-terminating reverse proxy** (Caddy or nginx). This keeps the application
free of certificate handling and lets you use battle-tested proxies with
automatic certificate renewal.

- In production, **always** put a reverse proxy in front and serve the server
  only over HTTPS. Do not expose the raw HTTP port to the public internet.
- The recommended deployment publishes the server port to loopback only
  (`127.0.0.1:4000`) and lets the proxy reach it over the internal Docker
  network. See [`deployment.md`](./deployment.md) for a Caddy example.
- Clients send their bearer token on every request; without TLS that token (and
  your note contents) would travel in cleartext. TLS is therefore mandatory in
  any real deployment.

## Authentication

### Password hashing - Argon2id

User passwords are hashed with **Argon2id** (a memory-hard, side-channel-
resistant KDF) before storage. If the native `argon2` addon is unavailable at
runtime, the server falls back to Node's built-in **scrypt**. Either way:

- Raw passwords are never written to disk or logs. They exist only inside the
  TLS-protected request body during register/login.
- The `Authorization` header is redacted in server logs.

### Bearer tokens + device binding

After `register`/`login`, the server issues an opaque **bearer token**:

- Tokens are random and opaque (no embedded claims to tamper with).
- Only the **SHA-256 hash** of the token is stored server-side - a database leak
  does not reveal usable tokens.
- Each token has an expiry (`expiresAt`) and is **bound to a device**
  (`deviceId`), so a device can be reasoned about and (in future) revoked
  independently.
- Clients send `Authorization: Bearer <accessToken>` on every request after
  login.

## Authorization - vault ownership

Every vault is owned by exactly one user. On **every** vault-scoped request
(pull, push, blob access within a vault context), the server checks that the
authenticated user owns the target vault. There are no cross-user shared vaults
in v0. A request for a vault you do not own is rejected, not silently ignored.

## Rate limiting

The server applies **rate limiting** (Milestone 8) to blunt brute-force and
abuse, with tighter limits on the authentication endpoints (`/v1/auth/*`) than
on general API traffic. Limits are configurable via environment variables.
Because the server sits behind a reverse proxy, configure the proxy to pass a
trustworthy client IP (e.g. `X-Forwarded-For`) and the server to honor it, so
limits are keyed on the real client rather than the proxy.

## HTTP hardening headers

The server sets sensible security response headers via `@fastify/helmet`
(Milestone 8): content-type sniffing protections, frame/embedding restrictions,
and related defaults. The web client additionally sanitizes rendered Markdown
(DOMPurify) to prevent stored-XSS from note content.

## Data integrity

Integrity is a first-class concern, per the protocol:

- **Content addressing.** Blobs are identified by `sha256:<hex>` of their bytes.
  On upload (`PUT /v1/blobs/:hash`) the server **recomputes** the hash and
  rejects any mismatch - this prevents content poisoning and detects corruption.
- **Deterministic conflict detection.** The server never merges file contents;
  it decides accept-vs-conflict deterministically (sync-protocol §6) and
  preserves the losing side as a conflict copy. **No silent data loss.**
- **Input validation.** All request bodies are validated against the zod schemas
  in `@graphvault/shared`; oversized requests and malformed paths are rejected.

## At-rest encryption (optional)

The server can optionally encrypt blob bytes **at rest** with a server-held key.

- **Cipher:** AES-256-GCM (authenticated encryption - confidentiality plus
  tamper detection).
- **Key:** supplied via `GRAPHVAULT_ENCRYPTION_KEY`, **base64-encoded and
  decoding to exactly 32 bytes** (AES-256). A malformed key - wrong alphabet or
  wrong length - fails fast at boot. Generate one with `openssl rand -base64 32`.
- **Hash-of-plaintext invariant.** Content addressing is computed over the
  **plaintext** bytes. Encryption is a storage-layer concern: the `sha256` that
  identifies a blob is unchanged whether or not at-rest encryption is enabled, so
  dedupe and the wire protocol behave identically. Ciphertext, its per-blob
  nonce, and the GCM auth tag are persistence details that never appear on the
  wire.
- **Key management is your job.** If you lose `GRAPHVAULT_ENCRYPTION_KEY`,
  encrypted blobs are unrecoverable. Back the key up separately from the data,
  and treat key rotation as a re-encryption migration (out of scope for v0).

At-rest encryption protects against theft of the disk/volume. It does **not**
protect against a compromised running server, which holds the key in memory.

## Client-side end-to-end encryption (direction)

At-rest encryption above is distinct from **client-side E2E encryption**, where
the client encrypts note content **before** upload and the server only ever sees
ciphertext plus hashes. In that model the server cannot read notes even if fully
compromised. v0 documents the direction but ships server-side at-rest encryption
as the supported option; E2E key management and per-vault key rotation are
tracked as open questions in [`sync-protocol.md`](./sync-protocol.md) §9.

## Telemetry - none

GraphVault makes **no outbound telemetry calls** by default. The only network
traffic is between your clients and your server, plus whatever you explicitly
configure (e.g. your reverse proxy fetching certificates). There are no
analytics, crash-reporting, or phone-home endpoints.

## Backups

Two things hold your data; back up **both**, consistently:

1. **The PostgreSQL database** - users, devices, tokens, vaults, files, file
   versions, revisions, and blob metadata. This is the source of truth for note
   structure and history.
2. **The blob `dataDir`** - the content-addressed file bytes on disk (the
   `GRAPHVAULT_DATA_DIR` / mounted `/data` volume). The database references
   blobs by hash; without the bytes, the metadata is incomplete.

Recommendations:

- Back up the database with `pg_dump` (or volume/snapshot backups) and the blob
  directory with a file-level backup (restic, borg, rsync, or volume snapshots).
- Try to capture both at a consistent point in time. Because blobs are
  content-addressed and immutable, a slightly newer blob set than the DB is
  harmless (extra unreferenced bytes); a **newer DB than blob set** can dangle -
  prefer snapshotting blobs at or after the DB.
- If you enable at-rest encryption, back up `GRAPHVAULT_ENCRYPTION_KEY`
  **separately** and securely - the encrypted blob backup is useless without it.
- Test restores periodically. See [`deployment.md`](./deployment.md) for the
  backup/restore procedure.

## Hardening checklist

- [ ] Terminate TLS at a reverse proxy; never serve GraphVault over plain HTTP
      in production.
- [ ] Publish the server port to loopback / the internal network only; the proxy
      is the public surface.
- [ ] Use a strong, unique `POSTGRES_PASSWORD`; do not keep the example default.
- [ ] Restrict `GRAPHVAULT_CORS_ORIGIN` to your actual web origin(s), not `*`.
- [ ] Set a 32-byte `GRAPHVAULT_ENCRYPTION_KEY` if the host disk is not otherwise
      encrypted, and back the key up separately.
- [ ] Keep rate limiting enabled; configure the proxy to forward the real client
      IP.
- [ ] Keep the base images and dependencies updated; rebuild on security
      updates.
- [ ] Run the container as the non-root `node` user (the provided image already
      does).
- [ ] Back up the Postgres DB **and** the blob `dataDir`; test restores.
- [ ] Keep the server off the public internet except through the proxy; consider
      a firewall and fail2ban on the host.
