# GraphVault Sync Protocol (v1 draft)

> Status: **draft** - Milestone 1. This document is the canonical specification
> for how GraphVault clients and the self-hosted server exchange notes. The
> wire types live in `packages/shared/src/sync/` and must stay in sync with this
> document.

## 1. Goals & non-goals

**Goals**

- Sync a vault (a directory tree of `.md` files plus optional assets) between a
  single user's devices through a self-hosted server.
- Work offline: a client can make arbitrary local changes and reconcile later.
- Be simple enough to implement and audit. No CRDTs in v0.
- Detect conflicts deterministically and never silently lose data.
- Keep the server dumb about note _semantics_; it stores bytes and revisions.

**Non-goals (v0)**

- Real-time collaborative editing.
- Multi-user shared vaults (single user / small trusted team only).
- Partial/streaming sync of a single large file (whole-file granularity in v0).
- Server-side merge of conflicting content (clients resolve conflicts).

## 2. Concepts & vocabulary

| Term              | Meaning                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| **Vault**         | A directory tree the user syncs. On disk: `.md` files, assets, and a `.graphvault/` dir. |
| **File path**     | Vault-relative POSIX path, NFC-normalized, no leading slash, no `.`/`..` segments.       |
| **Content hash**  | `sha256:<hex>` of the raw file bytes. Identifies content; enables dedupe.                |
| **Blob**          | The raw bytes for a given content hash, stored content-addressed on the server.          |
| **Revision**      | A per-vault monotonically increasing integer (`seq`). Each accepted change bumps it.     |
| **File state**    | `{ path, hash, size, mtime, deleted, revision }` - the server's view of one file.        |
| **Tombstone**     | A file state with `deleted: true` and `hash: null`. Propagates deletions.                |
| **Base revision** | The server revision a local change was last reconciled against (for conflict checks).    |
| **Local index**   | The client's record of every file's `path, hash, mtime, deleted, baseRevision, dirty`.   |

### 2.1 Canonical file path rules

A path is the stable identity of a file across devices.

- Forward slashes only; never a leading slash (`notes/a.md`, not `/notes/a.md`).
- Unicode normalized to **NFC** before hashing or comparison.
- No empty, `.`, or `..` segments.
- Max 1024 bytes UTF-8.
- Case is preserved and significant on the wire. Clients on case-insensitive
  filesystems (macOS default, Windows) must detect local collisions and surface
  them rather than silently overwrite.

### 2.2 Canonical content representation

- Content is treated as **opaque bytes**. No normalization of line endings or
  encoding in v0 - the bytes you write are the bytes that sync.
- The content hash is `sha256` of those exact bytes, lowercase hex, prefixed
  `sha256:`. See `packages/shared/src/util/hash.ts`.
- A tombstone has `hash: null` and `size: 0`.

## 3. Server data model

Mirrors Milestone 2 entities; here for protocol context.

```
users         (id, email, password_hash, created_at)
devices       (id, user_id, name, created_at, last_seen)
vaults        (id, user_id, name, created_at, head_revision)
files         (id, vault_id, path, current_version_id, is_deleted, created_at, updated_at)
file_versions (id, file_id, hash, size, mtime, created_at, deleted)
revisions     (id, vault_id, seq, created_at)   -- one row per accepted change-set step
blobs         (hash, size, created_at)          -- content-addressed bytes on disk
```

- `vaults.head_revision` is the latest `seq`. It only ever increases.
- Each accepted file change creates a new `file_versions` row and advances the
  vault `head_revision`. The prior version is retained for history/conflict
  recovery.
- Blobs are stored on disk under `dataDir`, keyed by hash (e.g.
  `storage/blobs/ab/cd/<hash>`). Multiple file paths/versions may reference the
  same blob.

## 4. Security requirements

- **Transport:** HTTPS/TLS only in production. The server refuses plaintext in
  production mode; reverse proxies (Caddy/nginx) terminate TLS. See
  `docs/security-basics.md` (Milestone 8).
- **Passwords:** never stored or logged in raw form. The server stores an
  Argon2id (preferred) or bcrypt hash. Raw passwords exist only inside the TLS
  request body during register/login.
- **Auth:** clients send `Authorization: Bearer <accessToken>` on every request
  after login. Tokens are opaque, expire (`expiresAt`), and are bound to a
  `deviceId`.
- **Authorization:** every vault is owned by a user; the server checks that the
  authenticated user owns the vault on every request.
- **At-rest encryption (optional):** the server may encrypt blob bytes at rest
  with a server-held key (Milestone 8). This is distinct from optional
  **client-side end-to-end encryption**, where the client encrypts content
  before upload and the server only ever sees ciphertext + hashes.
- **Telemetry:** none by default. No outbound calls except those the user
  configures.
- **Input validation:** all request bodies validated against the zod schemas in
  `packages/shared`; oversized requests and malformed paths are rejected.

## 5. Protocol operations

All endpoints are under `/v1`. Request/response bodies are JSON except blob
upload/download, which are raw bytes. Types referenced below are defined in
`packages/shared/src/sync/protocol.ts` and `.../model.ts`.

### 5.1 Auth (Milestone 2)

```
POST /v1/auth/register   { email, password, deviceName? } -> AuthToken
POST /v1/auth/login      { email, password, deviceName? } -> AuthToken
```

`AuthToken = { accessToken, expiresAt, userId, deviceId }`.

### 5.2 Vault registration

```
POST /v1/vaults          { name } -> { vaultId, name, revision }
GET  /v1/vaults          -> VaultRef[]
```

Registering a vault creates an empty vault at `revision: 0`. A device "adopts"
a vault by recording its `vaultId` and starting from `baseRevision: 0`.

### 5.3 Fetch server state (pull)

```
GET /v1/vaults/:id/changes?since=<seq>&limit=<n>
  -> { revision, changes: FileState[], hasMore }
```

- Returns every file state with `revision > since`, ordered by `revision`
  ascending, capped at `limit` (default 500, max 2000).
- `revision` in the response is the server head at response time.
- If `hasMore` is true, the client repeats with `since` = the highest
  `revision` it received, until caught up.
- `since=0` (or omitted) returns the full current state (a bootstrap).

After applying changes, the client downloads any missing blobs (§5.5) for the
hashes it does not already have, then advances each file's local
`baseRevision`.

### 5.4 Push local changes

```
POST /v1/vaults/:id/push   { deviceId, ops: PushOp[] }
  -> { revision, applied: FilePath[], conflicts: Conflict[] }

PushOp = { path, hash|null, size, mtime, deleted, baseRevision }
```

For each op, the server compares `op.baseRevision` to the file's current server
revision (see §6). Accepted ops are committed atomically as a single
change-set; the response `revision` is the new head. Rejected ops appear in
`conflicts` with a `kind` and the server's authoritative `server` state; the
client must reconcile (§6.2) and may re-push.

Before pushing content (i.e. a non-delete op), the client must ensure the blob
for `op.hash` exists on the server (§5.5). A push referencing a missing blob is
rejected with `kind: MISSING_BLOB`.

### 5.5 Blob upload / download

Content is addressed by hash and transferred separately from metadata so it can
be deduplicated and resumed independently.

```
HEAD /v1/blobs/:hash             -> 200 if present, 404 if not
PUT  /v1/blobs/:hash   <bytes>   -> 201 { hash, size }   (server verifies hash)
GET  /v1/blobs/:hash             -> <bytes>
```

- The server **recomputes** the SHA-256 of uploaded bytes and rejects the
  upload if it does not match `:hash` (integrity + anti-poisoning).
- Blob endpoints are idempotent: uploading an existing hash is a no-op 200/201.

## 6. Conflict model

GraphVault uses **three-way comparison** keyed on `baseRevision`. The three
points are: the client's new state, the client's `baseRevision` (last common
ancestor), and the server's current state.

### 6.1 Decision rules (per path, on push)

Let `serverRev` = the file's current server revision, `base` = `op.baseRevision`.

1. **Fast-forward (accept).** `base == serverRev`. No one else changed the file
   since the client's base. Apply the op, bump head, add to `applied`.
2. **No-op (accept).** `op.hash == server.hash` and `op.deleted == server.deleted`.
   Identical result; accept idempotently without creating a new version.
3. **Stale base (reject).** `base < serverRev` and the server changed in a way
   that differs from the op's result. Emit a conflict:
   - both sides have content and `op.hash != server.hash` → `CONTENT_CONFLICT`.
   - one side deleted while the other edited → `DELETE_EDIT_CONFLICT`.
   - otherwise (server moved ahead but op is otherwise compatible) →
     `STALE_BASE`; the client should pull and retry without manual merge.
4. **Missing blob (reject).** Non-delete op whose `hash` has no blob →
   `MISSING_BLOB`. Client uploads the blob and retries.

The server never merges file contents. Its job is to decide accept vs. conflict
deterministically.

### 6.2 Client-side conflict resolution

On `CONTENT_CONFLICT` or `DELETE_EDIT_CONFLICT` the client:

1. Pulls the latest server state and downloads the server blob.
2. Keeps the **server version at the canonical path** so all devices converge.
3. Writes the **local version to a conflict copy** alongside it:

   ```
   notes/idea.md                          <- server version (canonical)
   notes/idea (conflict 2026-06-15 from <device>).md   <- local version
   ```

   The conflict copy is a normal note: it shows up in search, the graph, and can
   be edited or deleted like any other file.

4. Surfaces the conflict in the UI's **Conflicts** list (Milestone 5) so the
   user can merge manually and delete the copy.
5. Sets the canonical file's `baseRevision` to the server revision and marks it
   clean; the conflict copy is a new dirty file that will sync on the next push.

This guarantees **no silent data loss**: the losing side is always preserved as
a sibling file, and every device converges on the same canonical content.

### 6.3 Deletions

- A delete is a tombstone op (`deleted: true`, `hash: null`).
- Delete vs. delete → no-op (already converged).
- Delete vs. edit → `DELETE_EDIT_CONFLICT`; resolution keeps the edited
  (non-deleted) version as canonical and records the deletion intent in the
  Conflicts list, because preserving content is safer than honoring a delete.
- Tombstones are retained server-side so late-syncing devices learn of the
  deletion; they may be garbage-collected after a retention window (Milestone 8).

## 7. End-to-end sync cycle (client agent)

```
1. SCAN     Walk the vault; compute hashes for changed files (mtime/size fast-path).
2. PULL     GET /changes?since=localHead; apply remote states; download blobs;
            on local/remote divergence, create conflict copies (§6.2).
3. PUSH     Upload blobs for dirty files (PUT /blobs); POST /push with PushOps.
4. SETTLE   Apply push response: advance baseRevision for `applied`; for
            `conflicts`, resolve per §6.2 and loop to step 2 until stable.
5. STATUS   Record lastSyncTime, pendingChanges, conflicts for the UI.
```

The cycle is **idempotent and resumable**: interrupting at any step and
restarting reaches the same converged state, because identity is content-hash +
path + revision, not transfer order.

## 8. Versioning & compatibility

- `SYNC_PROTOCOL_VERSION` (currently `1`) and `GRAPHVAULT_API_VERSION` (`v1`)
  are exported from `@graphvault/shared` and reported by `GET /v1/health`.
- Breaking wire changes bump the API version path segment (`/v2`).
- Additive, backward-compatible fields do not bump the version.

## 9. Open questions (to revisit in later milestones)

- Move/rename detection: v0 treats a rename as delete + create. A rename hint
  (same hash, different path within one push) could preserve history.
- Large assets: whole-file transfer only in v0; chunked/resumable upload later.
- End-to-end encryption key management and per-vault key rotation.
- Tombstone GC policy and history retention limits.

```

```
