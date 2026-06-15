/**
 * Browser-backed vault persistence.
 *
 * The real desktop app will persist notes to the filesystem; for the web shell
 * we persist to `localStorage` behind the {@link VaultStore} abstraction so the
 * UI is fully usable now and the backend is swappable later without UI changes.
 *
 * On first run (no stored data) the store seeds a few sample notes.
 */

import { seedNotes } from './seed';
import type { Note, VaultStore } from './types';

const STORAGE_KEY = 'graphvault:vault:v1';

function hasLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

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

/** A `VaultStore` backed by `window.localStorage`, seeded on first use. */
export class LocalStorageVaultStore implements VaultStore {
  async load(): Promise<Note[]> {
    if (!hasLocalStorage()) return seedNotes();
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      const seeded = seedNotes();
      await this.save(seeded);
      return seeded;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return seedNotes();
      const notes = parsed.filter(isNote);
      return notes;
    } catch {
      // Corrupt store: never throw away silently — keep a backup, then reseed.
      try {
        window.localStorage.setItem(`${STORAGE_KEY}:corrupt-backup`, raw);
      } catch {
        /* ignore quota errors on backup */
      }
      const seeded = seedNotes();
      await this.save(seeded);
      return seeded;
    }
  }

  async save(notes: Note[]): Promise<void> {
    if (!hasLocalStorage()) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  }

  /** Remove all stored data (used by Settings "reset vault"). */
  async clear(): Promise<void> {
    if (!hasLocalStorage()) return;
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

export const STORAGE_KEY_NAME = STORAGE_KEY;
