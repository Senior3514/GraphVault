# @graphvault/sync-core

The GraphVault **client sync agent**: a pure, environment-agnostic TypeScript
library that implements the end-to-end sync algorithm from
[`docs/sync-protocol.md`](../../docs/sync-protocol.md) §6-§7, decoupled from the
browser, the UI, and the server.

Like [`@graphvault/engine`](../engine), it is intentionally **framework-free and
filesystem-free**:

- No React, no DOM, no `node:fs`.
- The host wires up two small **ports** and calls `runSync`; the engine drives
  them.
- The same code runs in the web client (Web Crypto for hashing), the desktop
  client (real filesystem), and tests (in-memory fakes).

The wire types it speaks live in [`@graphvault/shared`](../shared) and are the
single source of truth shared with the server.

## Install

Within the monorepo it is a workspace package:

```jsonc
// some other package.json
"dependencies": { "@graphvault/sync-core": "workspace:*" }
```

## Ports

The host provides two interfaces. The engine never reaches past them.

### `LocalVault` - local content + index

```ts
interface LocalEntry {
  path: FilePath;
  hash: string | null; // sha256:<hex>, or null for a deletion
  content?: string; // raw bytes for live files
  mtime: number; // epoch ms
  deleted: boolean;
}

interface LocalVault {
  listEntries(): LocalEntry[] | Promise<LocalEntry[]>;
  readContent(path): string | null | Promise<string | null>;
  writeContent(path, content, mtime): void | Promise<void>;
  deleteContent(path): void | Promise<void>;
  readIndex(): LocalFileEntry[] | Promise<LocalFileEntry[]>;
  writeIndex(entries): void | Promise<void>;
}
```

The **local index** is the client's record of every file's
`path, hash, size, mtime, deleted, baseRevision, dirty` (`LocalFileEntry` from
`@graphvault/shared`). `baseRevision` is the server revision a local change was
last reconciled against - the basis for three-way conflict detection - and
`dirty` flags files whose content diverged from that base.

### `RemoteApi` - the server calls the engine needs

```ts
interface RemoteApi {
  getChanges(vaultId, since, limit?): Promise<ChangesResponse>; // GET  /changes
  push(vaultId, body): Promise<PushResponse>; // POST /push
  hasBlob(hash): Promise<boolean>; // HEAD /blobs/:hash
  putBlob(hash, content): Promise<void>; // PUT  /blobs/:hash
  getBlob(hash): Promise<string>; // GET  /blobs/:hash
}
```

All bodies use the shared zod-validated wire types.

## The sync cycle

```ts
import { runSync } from '@graphvault/sync-core';

const result = await runSync(localVault, remoteApi, vaultId, {
  deviceId: 'web-…', // identifies this device in pushes + conflict names
  deviceName: 'laptop', // human label embedded in conflict-copy filenames
});
```

`runSync` performs one converging cycle (spec §7):

1. **SCAN** - walk the local vault, (re)hash changed files (mtime/size
   fast-path via the index), and reconcile the index: new files become dirty,
   missing files become tombstones, unchanged files stay clean.
2. **PULL** - `getChanges` from the local head; apply each remote `FileState`,
   downloading missing blobs and writing content; advance `baseRevision`.
   Locally-dirty paths are left for PUSH (they are not silently overwritten).
3. **PUSH** - for every dirty file, ensure its blob exists server-side
   (`hasBlob` → `putBlob`), then `push` the `PushOp`s.
4. **SETTLE** - apply the push response:
   - `applied` paths advance to the new head and become clean.
   - `CONTENT_CONFLICT` / `DELETE_EDIT_CONFLICT` → create a **conflict copy**
     (§6.2): keep the **server** version at the canonical path so every device
     converges, and write the **local** version to
     `name (conflict <YYYY-MM-DD> from <device>).md`. The copy is a normal,
     dirty note that syncs on the next round. No data is ever silently lost.
   - `STALE_BASE` → advance `baseRevision` to the server's and retry (no manual
     merge).
   - `MISSING_BLOB` → leave dirty and retry (the next PUSH re-uploads).

   SETTLE loops back through PULL→PUSH until the push yields no retries, bounded
   by `maxRounds` (default 10).

It returns:

```ts
interface SyncResult {
  applied: FilePath[]; // local changes the server accepted
  conflicts: ResolvedConflict[]; // conflict copies created this cycle
  pulled: FilePath[]; // paths pulled from the server
  pushed: FilePath[]; // paths whose blobs were uploaded
  newRevision: number; // server head now reconciled to
}
```

### Idempotent & resumable

Identity is **content-hash + path + revision**, not transfer order. Interrupting
at any step and re-running `runSync` converges to the same state; a second run
with no local or remote changes is a no-op (empty `applied`/`pushed`/`pulled`).

## Helpers

- `hashContent(content): Promise<'sha256:<hex>'>` - portable content hash
  (Web Crypto with a `node:crypto` fallback), in the shared `sha256:<hex>`
  format.
- `byteLength(content)` - UTF-8 byte length (the `size` the protocol records).
- `conflictCopyPath(path, device, at?)` / `conflictDate(at?)` - §6.2 naming.

## Scripts

```bash
pnpm --filter @graphvault/sync-core build      # tsc -b
pnpm --filter @graphvault/sync-core typecheck  # tsc -b
pnpm --filter @graphvault/sync-core test       # node:test via tsx
pnpm --filter @graphvault/sync-core clean
```
