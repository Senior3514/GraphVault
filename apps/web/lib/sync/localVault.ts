/**
 * A {@link LocalVault} adapter over the web client's note set.
 *
 * The browser vault keeps notes in memory (and `localStorage`) behind the
 * `VaultStore` abstraction; `useVault` owns the live array. This adapter wraps a
 * snapshot of that array plus a small set of mutators so `runSync` can read,
 * write, and delete notes without knowing about React. The sync index is
 * persisted separately in `localStorage` (see {@link loadIndex}/{@link saveIndex}).
 *
 * Hashing uses the portable `hashContent` from `@graphvault/sync-core`, which
 * prefers Web Crypto (`crypto.subtle`) in the browser.
 */

import type { LocalEntry, LocalVault } from '@graphvault/sync-core';
import type { FilePath, LocalFileEntry } from '@graphvault/shared';

import type { Note, NotePath } from '../vault/types';

const INDEX_KEY = 'graphvault:sync-index:v1';

/** Mutations the sync engine performs, applied back onto the live vault. */
export interface VaultMutator {
  /** Current notes snapshot. */
  notes(): Note[];
  /** Create or overwrite a note's content. */
  upsert(path: NotePath, content: string, mtime: number): void;
  /** Delete a note. */
  remove(path: NotePath): void;
}

function loadIndex(): LocalFileEntry[] {
  try {
    const raw = window.localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as LocalFileEntry[];
  } catch {
    return [];
  }
}

function saveIndex(entries: LocalFileEntry[]): void {
  try {
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
  } catch {
    /* ignore quota/availability errors */
  }
}

/** Build a {@link LocalVault} port backed by the given {@link VaultMutator}. */
export function createLocalVault(mutator: VaultMutator): LocalVault {
  return {
    listEntries(): LocalEntry[] {
      return mutator.notes().map((n) => ({
        path: n.path as FilePath,
        hash: null,
        content: n.content,
        mtime: n.mtime,
        deleted: false,
      }));
    },

    readContent(path: FilePath): string | null {
      return mutator.notes().find((n) => n.path === path)?.content ?? null;
    },

    writeContent(path: FilePath, content: string, mtime: number): void {
      mutator.upsert(path, content, mtime);
    },

    deleteContent(path: FilePath): void {
      mutator.remove(path);
    },

    readIndex(): LocalFileEntry[] {
      return loadIndex();
    },

    writeIndex(entries: LocalFileEntry[]): void {
      saveIndex(entries);
    },
  };
}

export { INDEX_KEY as SYNC_INDEX_KEY };
