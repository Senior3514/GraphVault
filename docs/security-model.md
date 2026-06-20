# GraphVault Security Model

A summary of the threat model, shipped mitigations, and planned work. For the
server-specific hardening checklist see
[`security-basics.md`](./security-basics.md). For the import/export security
guards see [`data-portability.md`](./data-portability.md). For the sync
protocol security requirements see
[`sync-protocol.md`](./sync-protocol.md#4-security-requirements).

## Threat model summary

GraphVault is built for a **single user or a small trusted team** running their
own server. It is not a hardened multi-tenant SaaS.

| Threat                                        | Mitigation                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Note content read in transit                  | TLS via a reverse proxy (mandatory in production); see Transport below                        |
| Credential theft                              | Argon2id password hashing; opaque device-bound bearer tokens; token hash stored server-side   |
| Cross-device account access                   | Per-device tokens; server enforces `deviceId` binding on every request                        |
| Unauthorised vault access                     | Server checks vault ownership on every request; no cross-user access in v0                    |
| Brute-force / credential stuffing             | Rate limiting on all routes; stricter cap on `/v1/auth/*`                                     |
| Markdown XSS in the rendered preview          | DOMPurify sanitisation of rendered Markdown output                                            |
| Malicious import archive (zip-slip, zip-bomb) | Hardened import pipeline (path rejection, size caps, file-count cap); see data-portability.md |
| Disk theft / volume compromise                | Optional AES-256-GCM at-rest blob encryption on the server                                    |
| Telemetry / data exfiltration                 | No outbound calls by default; the app contacts only the server URL you configure              |

## Local-first and no-telemetry

The web client and the `@graphvault/engine` library make no network calls
beyond what the user explicitly configures. Notes are stored in browser
localStorage. The app contacts only the self-hosted server URL set in Settings.
There are no analytics, crash-reporting, or phone-home endpoints anywhere in
the stack.

## Markdown XSS sanitisation

The Markdown preview (`MarkdownPreview` component) sanitises rendered HTML with
DOMPurify before inserting it into the DOM. This prevents stored-XSS from
crafted note content — for example, a note containing `<script>` tags or
malicious `javascript:` href values.

The editor surface is a plain `<textarea>` and renders no HTML, so it is not
a sanitisation target.

## Import hardening (untrusted archives)

Importing an uploaded file is treated as an untrusted-input boundary. The
`safeImportPath()` function in `apps/web/lib/vault/portability.ts` rejects:

- Absolute paths (`/`, `\`, `C:\`, `\\server\share`).
- Any path segment that resolves to `..` (zip-slip protection).
- Non-text extensions (only `.md`, `.markdown`, `.txt` are accepted).

Additional caps guard against resource exhaustion:

- **Per-file**: 4 MiB maximum uncompressed content per entry.
- **Aggregate**: 64 MiB maximum total uncompressed content across all entries.
- **File count**: 10 000 maximum entries per archive.

These limits are enforced before any content is written to the vault. Rejected
entries are silently skipped; an aggregate-size breach aborts the import with
an error message.

## Server transport security (TLS)

The sync server speaks plain HTTP and runs **behind a TLS-terminating reverse
proxy** (Caddy or nginx). In production:

- Never expose the server port to the public internet over plain HTTP.
- Bearer tokens and note content would travel in cleartext without TLS.
- Caddy can obtain and renew certificates automatically; see
  [`deployment.md`](./deployment.md) for an example Caddyfile.

## Authentication

### Password storage — Argon2id

User passwords are hashed with **Argon2id** (memory-hard, side-channel-
resistant). If the native `argon2` addon is unavailable at runtime, the server
falls back to Node's built-in **scrypt**. Raw passwords never touch disk or
logs; they exist only inside the TLS-protected request body during
register/login.

### Bearer tokens

After register/login the server issues an opaque bearer token:

- Only the SHA-256 hash of the token is stored server-side; a database leak
  does not expose usable tokens.
- Each token has an expiry and is bound to a `deviceId`.
- Clients send `Authorization: Bearer <accessToken>` on every request.

## Authorization — vault ownership

Every vault is owned by exactly one user. The server checks ownership on every
vault-scoped request (pull, push, blob access). There are no cross-user shared
vaults in v0.

## Rate limiting

The server applies configurable rate limiting. Auth endpoints (`/v1/auth/*`)
have a tighter cap than general API traffic. Configure the reverse proxy to
forward a trustworthy `X-Forwarded-For` header so limits key on the real client
IP, not the proxy address.

## HTTP security headers

The server sets sensible security headers via `@fastify/helmet`: content-type
sniffing protection, frame/embedding restrictions, and related defaults.

## At-rest blob encryption (server, optional, shipped)

When `GRAPHVAULT_ENCRYPTION_KEY` is set, the server encrypts blob bytes on
disk with **AES-256-GCM** (authenticated encryption):

- The content hash remains the SHA-256 of the **plaintext** bytes. Encryption
  is a storage-layer detail; the wire protocol and dedupe logic are unchanged.
- The key must be **base64-encoded and decode to exactly 32 bytes** (AES-256);
  it is read from the environment at startup. A malformed key — wrong alphabet,
  or decoding to any length other than 32 bytes — causes a fast fail. (A hex
  string is rejected: decode it to base64 first.)
- Protects against disk / volume theft. Does not protect against a compromised
  running server (the key is in memory while the server runs).
- **If you lose the key, encrypted blobs are unrecoverable.** Back the key up
  separately from the data.

Generate a key:

```bash
openssl rand -base64 32
```

## Browser-side vault encryption (shipped)

Passphrase encryption of the browser vault store (WebCrypto) is **shipped**:
**Settings → Vault encryption** enables it, deriving an AES-256-GCM key from
the passphrase with **PBKDF2-SHA-256 (310 000 iterations)** and encrypting the
local vault store at rest in the browser (`apps/web/lib/crypto/vaultCrypto.ts`,
`EncryptionSection` in Settings). This protects the locally-persisted vault on a
shared or stolen device; the passphrase is never stored.

End-to-end encryption of synced note content — so the **sync server** never sees
plaintext even when fully compromised — is a separate, larger effort: E2E key
management and per-vault key rotation for the sync server are tracked as open
questions in [`sync-protocol.md §9`](./sync-protocol.md).

## Content integrity

- **Content addressing**: blobs are identified by `sha256:<hex>` of their
  bytes. On upload, the server recomputes the hash and rejects any mismatch —
  preventing content poisoning and detecting corruption.
- **Conflict copies**: the sync server and the import pipeline both preserve
  the losing side of any content collision. No silent data loss.
- **Input validation**: all request bodies are validated against zod schemas in
  `@graphvault/shared`; oversized requests and malformed paths are rejected.

## Production safety preflight (fail-fast config audit)

On startup with `NODE_ENV=production` the server audits its own configuration
([`preflight.ts`](../apps/server/src/preflight.ts)) and **refuses to boot** on an
insecure setup, exiting non-zero with an actionable message:

- `GRAPHVAULT_CORS_ORIGIN='*'` — an open CORS policy in production.
- `GRAPHVAULT_REQUIRE_HTTPS=false` — plaintext would be accepted.
- `GRAPHVAULT_STORAGE=postgres` with no `DATABASE_URL`.

It warns (but boots) on a missing `GRAPHVAULT_ENCRYPTION_KEY` or binding all
interfaces without `GRAPHVAULT_TRUST_PROXY`. Dev/test are unaffected. This turns
a quietly-insecure deployment into a loud boot failure.

## Connection hardening

The Fastify instance bounds slow-client and idle-socket abuse with
env-configurable `requestTimeout`, `keepAliveTimeout`, `connectionTimeout`, and
`maxParamLength` (safe defaults in `config.ts`). Body limits are split: a tight
global cap for JSON/non-blob routes (`GRAPHVAULT_MAX_JSON_BYTES`, 1 MiB default)
so a giant payload to auth/push can't exhaust memory, while the blob PUT and the
WebDAV/S3 vault-upload proxies opt into the larger `GRAPHVAULT_MAX_BLOB_BYTES`
cap. SIGTERM/SIGINT trigger a graceful `app.close()` drain.

## Hardening checklist (operators)

See [`hardening.md`](./hardening.md) for the full VPS checklist — TLS reverse
proxy, UFW, fail2ban, a hardened systemd unit, unattended upgrades, backups, and
how the preflight enforces safe config — and
[`security-basics.md`](./security-basics.md#hardening-checklist) for the original
operator notes.
