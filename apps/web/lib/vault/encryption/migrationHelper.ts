/**
 * Safe vault storage migration helper.
 *
 * Migrates all notes from a source {@link StorageAdapter} to a destination
 * adapter using a copy-verify-activate strategy:
 *
 *   1. Load all notes from the source adapter.
 *   2. Write them all to the destination adapter.
 *   3. Load back from the destination and verify every note survived intact
 *      (path, content, mtime, ctime equality check).
 *   4. Only then declare success — the source is NOT cleared automatically
 *      (the caller decides whether to clear).
 *
 * This means at no point during migration are notes accessible only from the
 * destination: the source stays intact until the caller explicitly clears it.
 * If verification fails, the destination is cleared (best-effort) and the
 * error is thrown — the source is unaffected.
 *
 * ## Why not clear source automatically?
 *
 * Automatic source cleanup would risk data loss if something goes wrong between
 * the write and the reload (e.g. quota error, permission revoked). Keeping the
 * source alive means the user can always fall back. The Settings UI calls
 * `source.clear()` only after the user confirms the migration succeeded.
 */

import type { StorageAdapter } from '../storage/index';
import type { Note } from '../types';

// ---------------------------------------------------------------------------
// Migration result
// ---------------------------------------------------------------------------

export interface MigrationResult {
  /** Number of notes successfully migrated. */
  noteCount: number;
  /** Names of adapters involved (for UI display). */
  from: string;
  to: string;
  /** Notes as loaded back from the destination (verified copy). */
  notes: Note[];
}

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------

/**
 * Safely migrate all notes from `source` to `destination`.
 *
 * @throws {Error} if verification fails (destination is best-effort cleared).
 */
export async function migrateAdapter(
  source: StorageAdapter,
  destination: StorageAdapter,
): Promise<MigrationResult> {
  // Step 1: load from source.
  const sourceNotes = await source.load();

  if (sourceNotes.length === 0) {
    // Nothing to migrate — write an empty vault to the destination so it
    // initialises correctly (seed notes will appear on next load).
    await destination.save([]);
    return {
      noteCount: 0,
      from: source.label,
      to: destination.label,
      notes: [],
    };
  }

  // Step 2: write to destination.
  await destination.save(sourceNotes);

  // Step 3: verify round-trip.
  const destNotes = await destination.load();
  const { ok, missing, corrupt } = verifyNotes(sourceNotes, destNotes);

  if (!ok) {
    // Verification failed — clean up destination (best-effort) and throw.
    try {
      await destination.clear();
    } catch {
      // Ignore cleanup failures; the error below is the primary signal.
    }
    const detail =
      missing.length > 0
        ? `Missing notes: ${missing.join(', ')}`
        : `Corrupted notes: ${corrupt.join(', ')}`;
    throw new Error(`Migration verification failed — source is unchanged. ${detail}`);
  }

  return {
    noteCount: sourceNotes.length,
    from: source.label,
    to: destination.label,
    notes: destNotes,
  };
}

// ---------------------------------------------------------------------------
// Internal verification
// ---------------------------------------------------------------------------

interface VerifyResult {
  ok: boolean;
  missing: string[];
  corrupt: string[];
}

function verifyNotes(original: Note[], copy: Note[]): VerifyResult {
  const copyMap = new Map(copy.map((n) => [n.path, n]));
  const missing: string[] = [];
  const corrupt: string[] = [];

  for (const note of original) {
    const found = copyMap.get(note.path);
    if (!found) {
      missing.push(note.path);
      continue;
    }
    if (
      found.content !== note.content ||
      found.mtime !== note.mtime ||
      found.ctime !== note.ctime
    ) {
      corrupt.push(note.path);
    }
  }

  return {
    ok: missing.length === 0 && corrupt.length === 0,
    missing,
    corrupt,
  };
}
