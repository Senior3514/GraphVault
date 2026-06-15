/**
 * The client sync algorithm (spec §6-§7).
 *
 * `runSync(local, remote, vaultId, options)` performs one converging cycle:
 *
 *   SCAN    Walk the local vault; (re)hash changed files; reconcile the index.
 *   PULL    GET /changes since the local head; apply remote states; download
 *           missing blobs; write content; advance baseRevision.
 *   PUSH    Upload blobs for dirty files (PUT /blobs); POST /push with PushOps.
 *   SETTLE  Apply the push response: advance baseRevision for `applied`; for
 *           CONTENT_CONFLICT / DELETE_EDIT_CONFLICT create a conflict copy
 *           (§6.2); for STALE_BASE pull and retry. Loop until stable.
 *
 * The cycle is idempotent and resumable: identity is content-hash + path +
 * revision, not transfer order, so interrupting and restarting converges to the
 * same state. A second `runSync` with no local or remote changes is a no-op.
 */

import type { Conflict, FilePath, FileState, LocalFileEntry, PushOp } from '@graphvault/shared';

import { conflictCopyPath } from './conflict.js';
import { byteLength, hashContent } from './hash.js';
import type { LocalVault, RemoteApi } from './ports.js';
import type { ResolvedConflict, SyncOptions, SyncResult } from './types.js';

/** Mutable index keyed by path for the duration of a cycle. */
type IndexMap = Map<FilePath, LocalFileEntry>;

function toIndexMap(entries: LocalFileEntry[]): IndexMap {
  const map: IndexMap = new Map();
  for (const e of entries) map.set(e.path, e);
  return map;
}

/** Highest baseRevision in the index — the revision we are caught up to. */
function localHead(index: IndexMap): number {
  let head = 0;
  for (const e of index.values()) {
    if (e.baseRevision > head) head = e.baseRevision;
  }
  return head;
}

/**
 * SCAN. Reconcile the local index against actual local content: hash files
 * whose content changed, add new files, mark deletions, and clear dirtiness on
 * files that match their base state again. Returns the (mutated) index map.
 */
async function scan(local: LocalVault, index: IndexMap): Promise<void> {
  const entries = await local.listEntries();
  const seen = new Set<FilePath>();

  for (const entry of entries) {
    seen.add(entry.path);
    const prev = index.get(entry.path);
    const hash =
      entry.hash ?? (entry.content !== undefined ? await hashContent(entry.content) : null);
    const size = entry.content !== undefined ? byteLength(entry.content) : 0;

    if (!prev) {
      // Brand-new local file the server has never seen.
      index.set(entry.path, {
        path: entry.path,
        hash,
        size,
        mtime: entry.mtime,
        deleted: false,
        baseRevision: 0,
        dirty: true,
      });
      continue;
    }

    const changed = prev.hash !== hash || prev.deleted;
    index.set(entry.path, {
      ...prev,
      hash,
      size,
      mtime: entry.mtime,
      deleted: false,
      // Dirty if content diverged from the last reconciled (base) state.
      dirty: changed ? true : prev.dirty,
    });
  }

  // Files present in the index but missing locally are deletions — but only if
  // the server knew about them (baseRevision > 0). A never-synced new file that
  // vanished is simply dropped.
  for (const [path, prev] of index) {
    if (seen.has(path) || prev.deleted) continue;
    if (prev.baseRevision === 0 && !prev.dirty) {
      index.delete(path);
      continue;
    }
    index.set(path, {
      ...prev,
      hash: null,
      size: 0,
      deleted: true,
      dirty: true,
    });
  }
}

/**
 * PULL. Page through `getChanges` from the local head and apply every remote
 * file state that the local side is not already ahead of. Returns the set of
 * paths written locally and the new server head we reconciled to.
 */
async function pull(
  local: LocalVault,
  remote: RemoteApi,
  vaultId: string,
  index: IndexMap,
  options: SyncOptions,
): Promise<{ pulled: FilePath[]; head: number }> {
  const pulled: FilePath[] = [];
  let since = localHead(index);
  let head = since;

  for (;;) {
    const res = await remote.getChanges(vaultId, since, options.changesLimit);
    head = Math.max(head, res.revision);

    for (const state of res.changes) {
      since = Math.max(since, state.revision);
      const applied = await applyRemoteState(local, remote, index, state);
      if (applied) pulled.push(state.path);
    }

    if (!res.hasMore) break;
  }

  return { pulled, head };
}

/**
 * Apply one remote {@link FileState} to the local vault + index. Skips files
 * the local side has dirty edits for (those are reconciled via push/conflict).
 * Returns true if local content/index changed.
 */
async function applyRemoteState(
  local: LocalVault,
  remote: RemoteApi,
  index: IndexMap,
  state: FileState,
): Promise<boolean> {
  const prev = index.get(state.path);

  // A locally-dirty file is reconciled through PUSH (and conflict handling),
  // not by being overwritten here — that would lose the local edit.
  if (prev?.dirty) {
    return false;
  }

  // Already at or beyond this revision with matching content: nothing to do.
  if (
    prev &&
    prev.baseRevision >= state.revision &&
    prev.hash === state.hash &&
    prev.deleted === state.deleted
  ) {
    return false;
  }

  if (state.deleted || state.hash === null) {
    if (prev && !prev.deleted) {
      await local.deleteContent(state.path);
    }
    index.set(state.path, {
      path: state.path,
      hash: null,
      size: 0,
      mtime: state.mtime,
      deleted: true,
      baseRevision: state.revision,
      dirty: false,
    });
    return true;
  }

  // Content state: ensure we have the bytes, then write them.
  const content = await remote.getBlob(state.hash);
  await local.writeContent(state.path, content, state.mtime);
  index.set(state.path, {
    path: state.path,
    hash: state.hash,
    size: state.size,
    mtime: state.mtime,
    deleted: false,
    baseRevision: state.revision,
    dirty: false,
  });
  return true;
}

/** Build PushOps for every dirty index entry. */
function dirtyOps(index: IndexMap): PushOp[] {
  const ops: PushOp[] = [];
  for (const e of index.values()) {
    if (!e.dirty) continue;
    ops.push({
      path: e.path,
      hash: e.hash,
      size: e.size,
      mtime: e.mtime,
      deleted: e.deleted,
      baseRevision: e.baseRevision,
    });
  }
  return ops;
}

/**
 * PUSH. Ensure every non-delete dirty op's blob exists server-side (upload if
 * missing), then POST the ops. Returns the push response plus the paths whose
 * blobs were uploaded.
 */
async function push(
  local: LocalVault,
  remote: RemoteApi,
  vaultId: string,
  ops: PushOp[],
  options: SyncOptions,
): Promise<{
  pushed: FilePath[];
  applied: FilePath[];
  conflicts: Conflict[];
  revision: number;
}> {
  const pushed: FilePath[] = [];

  for (const op of ops) {
    if (op.deleted || op.hash === null) continue;
    const present = await remote.hasBlob(op.hash);
    if (!present) {
      const content = await local.readContent(op.path);
      if (content !== null && content !== undefined) {
        await remote.putBlob(op.hash, content);
        pushed.push(op.path);
      }
    }
  }

  const res = await remote.push(vaultId, { deviceId: options.deviceId, ops });
  return {
    pushed,
    applied: res.applied,
    conflicts: res.conflicts,
    revision: res.revision,
  };
}

/**
 * SETTLE. Apply a push response against the index:
 * - `applied` paths advance to the new head and become clean.
 * - CONTENT_CONFLICT / DELETE_EDIT_CONFLICT create a conflict copy (§6.2),
 *   keep the server version canonical, and queue the copy as a new dirty file.
 * - STALE_BASE / MISSING_BLOB are left dirty so the next round retries.
 *
 * Returns the conflicts it resolved and whether another round is warranted.
 */
async function settle(
  local: LocalVault,
  remote: RemoteApi,
  index: IndexMap,
  appliedPaths: FilePath[],
  conflicts: Conflict[],
  newRevision: number,
  options: SyncOptions,
): Promise<{ resolved: ResolvedConflict[]; needsRetry: boolean }> {
  const resolved: ResolvedConflict[] = [];
  let needsRetry = false;

  const appliedSet = new Set(appliedPaths);
  for (const path of appliedSet) {
    const prev = index.get(path);
    if (!prev) continue;
    if (prev.deleted) {
      // A committed deletion: drop the content tombstone from the index once
      // the server has it.
      index.set(path, { ...prev, baseRevision: newRevision, dirty: false });
    } else {
      index.set(path, { ...prev, baseRevision: newRevision, dirty: false });
    }
  }

  for (const conflict of conflicts) {
    if (conflict.kind === 'MISSING_BLOB') {
      // The blob upload was skipped or lost; leave dirty and retry — the next
      // PUSH re-checks hasBlob and uploads it.
      needsRetry = true;
      continue;
    }

    if (conflict.kind === 'STALE_BASE') {
      // The local change is compatible but based on an old revision. Advance
      // this file's baseRevision to the server's so the next push fast-forwards,
      // while keeping the local content (still dirty).
      const prev = index.get(conflict.path);
      if (prev && conflict.server) {
        index.set(conflict.path, {
          ...prev,
          baseRevision: conflict.server.revision,
          dirty: true,
        });
      }
      needsRetry = true;
      continue;
    }

    // CONTENT_CONFLICT or DELETE_EDIT_CONFLICT: preserve the local version as a
    // conflict copy, then adopt the server version as canonical.
    const at = (options.now ?? (() => new Date()))();
    const device = options.deviceName ?? options.deviceId;
    const copyPath = conflictCopyPath(conflict.path, device, at);
    const localContent = await local.readContent(conflict.path);

    if (localContent !== null && localContent !== undefined) {
      const copyHash = await hashContent(localContent);
      await local.writeContent(copyPath, localContent, at.getTime());
      index.set(copyPath, {
        path: copyPath,
        hash: copyHash,
        size: byteLength(localContent),
        mtime: at.getTime(),
        deleted: false,
        baseRevision: 0,
        dirty: true,
      });
    }

    // Adopt the server's authoritative state at the canonical path.
    if (conflict.server) {
      await adoptServerState(local, remote, index, conflict.server);
    }

    resolved.push({
      path: conflict.path,
      kind: conflict.kind,
      conflictCopyPath: copyPath,
      at: at.toISOString(),
    });
    // The new conflict copy is dirty and must be pushed; retry.
    needsRetry = true;
  }

  return { resolved, needsRetry };
}

/** Force-apply a server state at the canonical path (overwriting local edits). */
async function adoptServerState(
  local: LocalVault,
  remote: RemoteApi,
  index: IndexMap,
  state: FileState,
): Promise<void> {
  if (state.deleted || state.hash === null) {
    await local.deleteContent(state.path);
    index.set(state.path, {
      path: state.path,
      hash: null,
      size: 0,
      mtime: state.mtime,
      deleted: true,
      baseRevision: state.revision,
      dirty: false,
    });
    return;
  }
  const content = await remote.getBlob(state.hash);
  await local.writeContent(state.path, content, state.mtime);
  index.set(state.path, {
    path: state.path,
    hash: state.hash,
    size: state.size,
    mtime: state.mtime,
    deleted: false,
    baseRevision: state.revision,
    dirty: false,
  });
}

/**
 * Run one full sync cycle to convergence. Resolvable conflicts (STALE_BASE) and
 * created conflict copies drive internal PULL→PUSH→SETTLE rounds until the push
 * yields no more retries (bounded by `maxRounds`).
 */
export async function runSync(
  local: LocalVault,
  remote: RemoteApi,
  vaultId: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const maxRounds = options.maxRounds ?? 10;
  const index = toIndexMap(await local.readIndex());

  const appliedAll = new Set<FilePath>();
  const pushedAll = new Set<FilePath>();
  const pulledAll = new Set<FilePath>();
  const conflictsAll: ResolvedConflict[] = [];
  let newRevision = localHead(index);

  // SCAN once up front; rounds re-pull/-push but local content is stable
  // within a cycle (conflict copies are added to the index directly).
  await scan(local, index);

  for (let round = 0; round < maxRounds; round++) {
    // PULL
    const pullRes = await pull(local, remote, vaultId, index, options);
    for (const p of pullRes.pulled) pulledAll.add(p);
    newRevision = Math.max(newRevision, pullRes.head);

    // PUSH
    const ops = dirtyOps(index);
    if (ops.length === 0) {
      // Nothing to push; if we also pulled nothing new we are converged.
      break;
    }
    const pushRes = await push(local, remote, vaultId, ops, options);
    for (const p of pushRes.pushed) pushedAll.add(p);
    for (const p of pushRes.applied) appliedAll.add(p);

    // The push response revision is the server head after the commit.
    const pushHead = pushRes.revision;
    newRevision = Math.max(newRevision, pushHead);

    // SETTLE
    const { resolved, needsRetry } = await settle(
      local,
      remote,
      index,
      pushRes.applied,
      pushRes.conflicts,
      pushHead,
      options,
    );
    conflictsAll.push(...resolved);

    if (!needsRetry) break;
    if (round === maxRounds - 1) {
      throw new Error(`sync did not converge after ${maxRounds} rounds (vault ${vaultId})`);
    }
  }

  await local.writeIndex([...index.values()]);
  newRevision = Math.max(newRevision, localHead(index));

  return {
    applied: [...appliedAll],
    conflicts: conflictsAll,
    pulled: [...pulledAll],
    pushed: [...pushedAll],
    newRevision,
  };
}
