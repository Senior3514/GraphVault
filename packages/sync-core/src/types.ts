/**
 * Public result/option shapes for a sync cycle.
 */

import type { ConflictKind, FilePath } from '@graphvault/shared';

/** A conflict the engine resolved during a cycle, surfaced for the UI. */
export interface ResolvedConflict {
  /** The canonical path that conflicted. */
  path: FilePath;
  /** Why the server rejected the push. */
  kind: ConflictKind;
  /** Where the losing local version was preserved (the conflict copy). */
  conflictCopyPath: FilePath;
  /** When the conflict was resolved (ISO-8601). */
  at: string;
}

/** The outcome of one `runSync` call. */
export interface SyncResult {
  /** Paths whose local changes the server accepted. */
  applied: FilePath[];
  /** Conflicts resolved into conflict copies during this cycle. */
  conflicts: ResolvedConflict[];
  /** Paths pulled (applied) from the server into the local vault. */
  pulled: FilePath[];
  /** Paths whose content the engine pushed to the server. */
  pushed: FilePath[];
  /** The server head revision the local vault is now reconciled to. */
  newRevision: number;
}

/** Options controlling a sync cycle. */
export interface SyncOptions {
  /**
   * A stable identifier for this device. Used in the push request and in
   * conflict-copy filenames so the user can tell devices apart.
   */
  deviceId: string;
  /**
   * Human-friendly device label embedded in conflict-copy filenames. Defaults
   * to `deviceId` when omitted.
   */
  deviceName?: string;
  /** Page size for `getChanges`. Defaults to the server default. */
  changesLimit?: number;
  /**
   * Safety bound on SETTLE→PULL retry loops (STALE_BASE handling). Defaults to
   * 10; reaching it throws rather than spinning forever.
   */
  maxRounds?: number;
  /** Injectable clock for deterministic conflict-copy names in tests. */
  now?: () => Date;
}
