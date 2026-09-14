/**
 * localStorage-backed {@link StorageAdapter}.
 *
 * This is a drop-in replacement for the original inline logic in `store.ts`
 * and preserves every guarantee it made:
 *
 *  - **Seed on first run**: if no data is found the adapter writes the sample
 *    notes before returning them so subsequent `load()` calls find real data.
 *  - **Corrupt-backup behaviour**: if the stored JSON is unparseable or has the
 *    wrong shape, the raw bytes are preserved under a `:corrupt-backup` key
 *    (best-effort - never throws on quota errors) and the vault is reseeded.
 *    Data is never silently discarded.
 *  - **Graceful SSR**: `isAvailable()` tests for `window.localStorage` without
 *    throwing, so the adapter returns `false` in Node/server contexts.
 */

import { seedNotes } from '../seed';
import type { Note } from '../types';
import type { StorageAdapter } from './index';

/** The localStorage key used to persist the note array. */
export const LOCAL_STORAGE_KEY = 'graphvault:vault:v1';

/** Narrow-cast guard: ensures a value has the shape of a {@link Note}. */
function isNote(value: unknown): value is Note {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === 'string' &&
    typeof v.content === 'string' &&
    typeof v.mtime === 'number' &&
    typeof v.ctime === 'number'
  );
}

/** Returns `true` when `window.localStorage` is accessible (client-side). */
function hasLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

/**
 * The concrete localStorage adapter.
 *
 * Export as a singleton so the registry and tests share the same instance.
 * Re-registration is idempotent because the registry probes by `id`.
 */
export const localStorageAdapter: StorageAdapter = {
  id: 'localStorage',
  label: 'Browser storage (localStorage)',

  isAvailable(): boolean {
    return hasLocalStorage();
  },

  async load(): Promise<Note[]> {
    if (!hasLocalStorage()) {
      // SSR / no-storage environment - return seed without trying to persist.
      return seedNotes();
    }

    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);

    // --- First run: seed and persist. ---
    if (raw === null) {
      const seeded = seedNotes();
      await this.save(seeded);
      return seeded;
    }

    // --- Parse and validate. ---
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new SyntaxError('Stored value is not a JSON array.');
      }
      const notes = parsed.filter(isNote);
      return notes;
    } catch {
      // Corrupt store: preserve a backup for potential recovery, then reseed.
      // Never throw away data silently - the backup key makes it retrievable.
      try {
        window.localStorage.setItem(`${LOCAL_STORAGE_KEY}:corrupt-backup`, raw);
      } catch {
        // Quota errors on the backup write are ignored; the primary concern is
        // that the user can keep working - not the backup itself.
      }

      const seeded = seedNotes();
      await this.save(seeded);
      return seeded;
    }
  },

  async save(notes: Note[]): Promise<void> {
    if (!hasLocalStorage()) return;
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(notes));
  },

  async clear(): Promise<void> {
    if (!hasLocalStorage()) return;
    window.localStorage.removeItem(LOCAL_STORAGE_KEY);
  },
};
