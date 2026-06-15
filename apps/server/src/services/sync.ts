import type {
  ChangesResponse,
  Conflict,
  ConflictKind,
  FilePath,
  FileState,
  PushOp,
  PushResponse,
} from '@graphvault/shared';
import { badRequest } from '../errors.js';
import type { DiskBlobStore } from '../store/blob-store.js';
import type { FileChange, Storage } from '../store/types.js';

export const DEFAULT_CHANGES_LIMIT = 500;
export const MAX_CHANGES_LIMIT = 2000;

/**
 * Implements the pull (§5.3) and push (§5.4) operations and the deterministic
 * three-way conflict model from spec §6. The server never merges content; it
 * only decides accept vs. conflict and commits accepted ops atomically.
 */
export class SyncService {
  constructor(
    private readonly storage: Storage,
    private readonly blobs: DiskBlobStore,
  ) {}

  async changes(
    vaultId: string,
    since: number,
    limit: number | undefined,
  ): Promise<ChangesResponse> {
    const cap = clampLimit(limit);
    const page = await this.storage.listChangesSince(vaultId, since, cap);
    const vault = await this.storage.getVault(vaultId);
    return {
      revision: vault?.headRevision ?? 0,
      changes: page.changes,
      hasMore: page.hasMore,
    };
  }

  /**
   * Evaluate every op against current server state, then commit the accepted
   * ones as a single atomic change-set. Rejected ops are returned as conflicts;
   * the head only advances if at least one op is accepted.
   */
  async push(vaultId: string, ops: PushOp[]): Promise<PushResponse> {
    assertNoDuplicatePaths(ops);

    const accepted: FileChange[] = [];
    const applied: FilePath[] = [];
    const conflicts: Conflict[] = [];

    for (const op of ops) {
      const current = (await this.storage.getFile(vaultId, op.path))?.state ?? null;
      const decision = await this.decide(op, current);
      if (decision.accept) {
        if (decision.commit) {
          accepted.push(toChange(op));
        }
        // Both committed and idempotent no-op ops count as "applied" so the
        // client can advance its baseRevision for them.
        applied.push(op.path);
      } else {
        conflicts.push({ path: op.path, kind: decision.kind, server: current });
      }
    }

    let revision: number;
    if (accepted.length > 0) {
      revision = await this.storage.commitChanges(vaultId, accepted);
    } else {
      revision = (await this.storage.getVault(vaultId))?.headRevision ?? 0;
    }

    return { revision, applied, conflicts };
  }

  /**
   * Per-path decision (§6.1). Returns either accept (with whether a new version
   * must be committed) or a conflict kind.
   */
  private async decide(op: PushOp, server: FileState | null): Promise<Decision> {
    // 2. No-op accept: the op's result already equals the server's state.
    if (server && statesEquivalent(op, server)) {
      return { accept: true, commit: false };
    }

    // 4. Missing blob: a non-delete op must reference an uploaded blob.
    if (!op.deleted) {
      if (op.hash === null) {
        throw badRequest('A non-delete op must carry a content hash');
      }
      const present = await this.blobs.has(op.hash);
      if (!present) {
        return { accept: false, kind: 'MISSING_BLOB' };
      }
    }

    const serverRev = server?.revision ?? 0;

    // 1. Fast-forward accept: nobody changed the file since the client's base.
    if (op.baseRevision === serverRev) {
      return { accept: true, commit: true };
    }

    // base > serverRev should never happen (client base can't exceed head);
    // treat it as a stale/incoherent base to be safe.
    if (op.baseRevision > serverRev) {
      return { accept: false, kind: 'STALE_BASE' };
    }

    // 3. Stale base: server moved ahead of the client's base. Classify.
    return { accept: false, kind: classifyConflict(op, server) };
  }
}

interface AcceptDecision {
  accept: true;
  /** True when a new file version must be written; false for an idempotent no-op. */
  commit: boolean;
}

interface RejectDecision {
  accept: false;
  kind: ConflictKind;
}

type Decision = AcceptDecision | RejectDecision;

/** Whether the op's resulting state is identical to the server's current state. */
function statesEquivalent(op: PushOp, server: FileState): boolean {
  if (op.deleted || server.deleted) {
    // Both deleted => equivalent (delete-vs-delete converges). If only one is
    // deleted, they're not equivalent.
    return op.deleted && server.deleted;
  }
  return op.hash === server.hash;
}

/** Classify a stale-base rejection into a specific conflict kind (§6.1 rule 3). */
function classifyConflict(op: PushOp, server: FileState | null): ConflictKind {
  // No server state but a non-zero base is incoherent -> stale base.
  if (!server) return 'STALE_BASE';

  const opDeleted = op.deleted;
  const serverDeleted = server.deleted;

  // One side deleted while the other edited.
  if (opDeleted !== serverDeleted) {
    return 'DELETE_EDIT_CONFLICT';
  }

  // Both sides have content but differ.
  if (!opDeleted && !serverDeleted && op.hash !== server.hash) {
    return 'CONTENT_CONFLICT';
  }

  // Server moved ahead but the op is otherwise compatible; pull and retry.
  return 'STALE_BASE';
}

function toChange(op: PushOp): FileChange {
  return {
    path: op.path,
    hash: op.deleted ? null : op.hash,
    size: op.deleted ? 0 : op.size,
    mtime: op.mtime,
    deleted: op.deleted,
  };
}

function assertNoDuplicatePaths(ops: PushOp[]): void {
  const seen = new Set<string>();
  for (const op of ops) {
    if (seen.has(op.path)) {
      throw badRequest(`Duplicate path in push: ${op.path}`);
    }
    seen.add(op.path);
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_CHANGES_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_CHANGES_LIMIT);
}
