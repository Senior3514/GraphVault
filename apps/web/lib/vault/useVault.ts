'use client';

/**
 * React state layer over the pure vault operations + persistence store.
 *
 * Owns the canonical notes array, derived index (parsed notes, backlinks,
 * search), and autosave. UI components call the returned mutators; this hook
 * keeps state immutable and persists asynchronously so a render never blocks on
 * storage. The pure operations live in `vault.ts`; this is just glue + effects.
 *
 * ## Encryption
 *
 * When vault encryption is enabled the hook uses an {@link EncryptedVaultStore}
 * to transparently encrypt/decrypt the notes blob. The passphrase is held in
 * memory only - never persisted.
 *
 * On first load, if the sentinel flag indicates the vault is encrypted but no
 * passphrase has been supplied yet, `ready` stays `false` and
 * `needsPassphrase` is `true`. The `VaultProvider` mounts a `PassphraseGate`
 * that calls `unlock(passphrase)` when the user submits.
 *
 * ## Auto-snapshot (version history)
 *
 * After each autosave the hook debounces a background IndexedDB snapshot via
 * {@link BackupStore}. The delay is intentionally longer than the autosave
 * debounce (autosave: immediate-on-change, snapshot: 5 s after the last change
 * settles) so rapid typing does not produce hundreds of snapshots. The snapshot
 * is fire-and-forget - a failure never blocks a render or an autosave.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { computeBacklinks, type Backlink } from './links';
import { NoteSearchIndex, type SearchResult } from './search';
import { AdapterVaultStore } from './store';
import { LOCAL_STORAGE_KEY } from './storage/localStorageAdapter';
import { aggregateTags, notesWithTag as notesWithTagOp, type TagCount } from './tags';
import type { IndexedNote, Note, NotePath } from './types';
import {
  createNote as createNoteOp,
  deleteNote as deleteNoteOp,
  indexNotes,
  mergeImport,
  renameNote as renameNoteOp,
  updateNoteContent as updateNoteContentOp,
  type ImportNote,
  type ImportSummary,
} from './vault';
import { EncryptedVaultStore, isVaultEncryptedSentinel } from './encryption/EncryptedVaultStore';
import { debounce } from './debounce';
import { getBackupStore } from './backups';

// Module-level default store (unencrypted path).
const store = new AdapterVaultStore();

// Debounce delay for auto-snapshots (ms). Longer than autosave so rapid edits
// don't produce a snapshot per keystroke.
const SNAPSHOT_DEBOUNCE_MS = 5_000;

/**
 * Build a `RawStorage` interface backed by `window.localStorage`, or a
 * no-op stub for SSR.
 */
function getRawStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
} {
  if (typeof window !== 'undefined') {
    return window.localStorage;
  }
  return {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// UseVault interface
// ---------------------------------------------------------------------------

export interface UseVault {
  ready: boolean;
  notes: IndexedNote[];
  /** Every tag in the vault with its note count, most-used first. */
  tags: TagCount[];
  getNote(path: NotePath): IndexedNote | undefined;
  backlinksFor(path: NotePath): Backlink[];
  /** Paths of notes carrying the given tag (case-insensitive, `#` optional). */
  notesWithTag(tag: string): NotePath[];
  search(query: string): SearchResult[];
  resolveLink(target: string): NotePath | null;
  createNote(path: string, content?: string): Note;
  updateContent(path: NotePath, content: string): void;
  renameNote(from: NotePath, to: string): NotePath;
  deleteNote(path: NotePath): void;
  importNotes(incoming: readonly ImportNote[]): ImportSummary;
  /**
   * Write pending draft edits directly to the active storage adapter WITHOUT
   * going through the React state → useEffect → adapter.save pipeline.
   *
   * This is the safe path for beforeunload / visibilitychange=hidden handlers:
   * React's useEffect is async and may not fire before the browser unloads the
   * page. Calling `updateContent` (which dispatches `setRawNotes`) is therefore
   * NOT safe from a beforeunload handler - the last keystrokes would be lost.
   *
   * `directFlush` applies the patches to the current in-memory notes, calls
   * `adapter.save()` immediately (so the write races to complete before unload),
   * and ALSO dispatches a `setRawNotes` update to keep React state consistent
   * for the case where the tab is NOT closed (e.g. visibilitychange=hidden on
   * mobile where the app can resume later).
   *
   * @param updates  Array of `{ path, content }` pairs - the pending draft
   *   content for each tab that has unsaved edits. Unknown paths are silently
   *   skipped (the note may have been deleted between capturing the draft and
   *   the flush firing).
   */
  directFlush(updates: ReadonlyArray<{ path: NotePath; content: string }>): Promise<void>;
  resetVault(): Promise<void>;
  /**
   * Non-destructively reload notes from the active storage adapter into React
   * state. Unlike {@link resetVault}, this NEVER clears or reseeds storage - it
   * just re-reads what is already persisted. Used after a storage-backend switch
   * (migrate copies notes to the new adapter; reload surfaces them) so the
   * migrate "source preserved" promise is honoured.
   */
  reload(): Promise<void>;
  /**
   * Restore a snapshot by id. Non-destructive: a "pre-restore" snapshot of
   * the current state is taken first, then the snapshot notes are merged in
   * via the collision-safe merge. Returns false if the snapshot was not found.
   */
  restoreFromSnapshot(snapshotId: string): Promise<boolean>;

  // -------------------------------------------------------------------------
  // Encryption API
  // -------------------------------------------------------------------------

  /** True when the stored blob is flagged as encrypted. */
  encryptionEnabled: boolean;
  /**
   * True when the vault is encrypted but the passphrase has not yet been
   * supplied this session (user must unlock via PassphraseGate).
   */
  needsPassphrase: boolean;
  /**
   * Submit a passphrase to unlock an encrypted vault.
   *
   * Resolves on success; rejects with `VaultDecryptionError` on wrong
   * passphrase. The stored blob is NEVER mutated on a failed attempt.
   */
  unlock(passphrase: string): Promise<void>;
  /**
   * Enable at-rest encryption with the given passphrase.
   *
   * Encrypts the current plaintext blob in place and sets the sentinel.
   * Returns the count of notes encrypted.
   */
  enableEncryption(passphrase: string): Promise<number>;
  /**
   * Disable at-rest encryption.
   *
   * Decrypts the stored blob and writes it back as plaintext. Clears the
   * sentinel. The in-memory passphrase is wiped afterward.
   * Throws `VaultDecryptionError` if the passphrase does not match.
   */
  disableEncryption(passphrase: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVault(): UseVault {
  const [rawNotes, setRawNotes] = useState<Note[]>([]);
  const [ready, setReady] = useState(false);
  const [encryptionEnabled, setEncryptionEnabled] = useState(false);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const searchIndex = useRef<NoteSearchIndex | null>(null);

  // Holds the active EncryptedVaultStore when encryption is on.
  const encryptedStore = useRef<EncryptedVaultStore | null>(null);

  // Debounced auto-snapshot function. Created once and stable across renders.
  // The ref holds the latest rawNotes so the debounced callback always captures
  // the most recent notes without needing to be re-created on every state change.
  const latestNotesRef = useRef<Note[]>([]);
  const debouncedSnapshotRef = useRef<ReturnType<typeof debounce> | null>(null);

  // Initialise the debounced snapshot function once (browser only).
  useEffect(() => {
    if (typeof indexedDB === 'undefined') return; // SSR / Node guard
    const fn = debounce(() => {
      const notes = latestNotesRef.current;
      if (notes.length === 0) return;
      void getBackupStore()
        .takeSnapshot(notes)
        .then(() => getBackupStore().pruneOld())
        .catch(() => {
          // Snapshot failures are silent - never block a render or autosave.
        });
    }, SNAPSHOT_DEBOUNCE_MS);
    debouncedSnapshotRef.current = fn;
    return () => {
      fn.cancel();
    };
  }, []);

  // Initial load from the persistence store (seeds on first run).
  useEffect(() => {
    let active = true;

    // Check if the sentinel says the vault is encrypted.
    const sentinel = isVaultEncryptedSentinel();
    if (sentinel) {
      // The vault is encrypted - we need a passphrase before we can load.
      setEncryptionEnabled(true);
      setNeedsPassphrase(true);
      // `ready` stays false until unlock() is called.
      return;
    }

    // Not encrypted - load normally.
    store.load().then((loaded) => {
      if (!active) return;
      setRawNotes(loaded);
      setReady(true);
    });

    return () => {
      active = false;
    };
  }, []);

  const notes = useMemo(() => indexNotes(rawNotes), [rawNotes]);

  // Keep the search index in sync with the current notes.
  useEffect(() => {
    if (!searchIndex.current) {
      searchIndex.current = new NoteSearchIndex(notes);
    } else {
      searchIndex.current.replaceAll(notes);
    }
  }, [notes]);

  const backlinks = useMemo(() => computeBacklinks(notes), [notes]);

  const tags = useMemo(() => aggregateTags(notes), [notes]);

  const resolver = useMemo(() => {
    const byKey = new Map<string, NotePath>();
    for (const n of notes) {
      const add = (k: string) => {
        const key = k.trim().toLowerCase();
        if (key && !byKey.has(key)) byKey.set(key, n.path);
      };
      add(n.path.replace(/\.md$/i, ''));
      add(n.path.replace(/\.md$/i, '').split('/').pop() ?? '');
      add(n.parsed.title);
    }
    return byKey;
  }, [notes]);

  // Persist whenever notes change (after the initial load).
  // Also kicks off a debounced auto-snapshot so IDB history stays current.
  useEffect(() => {
    if (!ready) return;

    // Keep the ref up to date so the debounced snapshot function captures the
    // latest state without needing to be re-created.
    latestNotesRef.current = rawNotes;

    if (encryptedStore.current) {
      void encryptedStore.current.save(rawNotes);
    } else {
      void store.save(rawNotes);
    }

    // Trigger a debounced snapshot after the save settles. Fire-and-forget.
    debouncedSnapshotRef.current?.();
  }, [rawNotes, ready]);

  // ---------------------------------------------------------------------------
  // Encryption API
  // ---------------------------------------------------------------------------

  const unlock = useCallback(async (passphrase: string): Promise<void> => {
    const evs = new EncryptedVaultStore(getRawStorage(), LOCAL_STORAGE_KEY, passphrase);

    // Throws VaultDecryptionError if passphrase is wrong - we let it propagate.
    const loaded = await evs.load();

    encryptedStore.current = evs;
    // If load returned empty (new vault with encryption enabled), seed normally.
    const initialNotes = loaded.length > 0 ? loaded : await store.load();
    setRawNotes(initialNotes);
    setNeedsPassphrase(false);
    setEncryptionEnabled(true);
    setReady(true);
  }, []);

  const enableEncryption = useCallback(async (passphrase: string): Promise<number> => {
    if (!passphrase) throw new TypeError('Passphrase must not be empty.');

    const evs = new EncryptedVaultStore(getRawStorage(), LOCAL_STORAGE_KEY, passphrase);

    // Encrypts the existing plaintext blob (or validates an already-encrypted one).
    const encrypted = await evs.encryptExisting();
    encryptedStore.current = evs;
    setEncryptionEnabled(true);
    setNeedsPassphrase(false);

    // Reload state to ensure React knows about the current blob.
    const loaded = await evs.load();
    setRawNotes(loaded);

    return encrypted.length;
  }, []);

  const disableEncryption = useCallback(async (passphrase: string): Promise<void> => {
    if (!passphrase) throw new TypeError('Passphrase must not be empty.');

    // Use the current store if available, otherwise build a temporary one.
    const evs =
      encryptedStore.current ??
      new EncryptedVaultStore(getRawStorage(), LOCAL_STORAGE_KEY, passphrase);

    evs.setPassphrase(passphrase);
    // Throws VaultDecryptionError on wrong passphrase - blob is NOT mutated.
    const decrypted = await evs.decryptExisting();

    evs.lock();
    encryptedStore.current = null;
    setEncryptionEnabled(false);
    setNeedsPassphrase(false);
    setRawNotes(decrypted);
  }, []);

  // ---------------------------------------------------------------------------
  // Note operations
  // ---------------------------------------------------------------------------

  const getNote = useCallback((path: NotePath) => notes.find((n) => n.path === path), [notes]);

  const createNote = useCallback((path: string, content = '') => {
    let created: Note | undefined;
    setRawNotes((prev) => {
      const next = createNoteOp(prev, path, content);
      created = next[next.length - 1];
      return next;
    });
    // `created` is set synchronously inside the updater above.
    return created as Note;
  }, []);

  const updateContent = useCallback((path: NotePath, content: string) => {
    setRawNotes((prev) => updateNoteContentOp(prev, path, content));
  }, []);

  const renameNote = useCallback((from: NotePath, to: string) => {
    let target = from;
    setRawNotes((prev) => {
      const next = renameNoteOp(prev, from, to);
      target =
        next.find((n) => n.path !== from && !prev.some((p) => p.path === n.path))?.path ?? to;
      return next;
    });
    return target;
  }, []);

  const deleteNote = useCallback((path: NotePath) => {
    setRawNotes((prev) => deleteNoteOp(prev, path));
  }, []);

  const importNotes = useCallback((incoming: readonly ImportNote[]): ImportSummary => {
    let summary: ImportSummary = { added: 0, renamed: [], unchanged: 0 };
    setRawNotes((prev) => {
      const result = mergeImport(prev, incoming);
      summary = result.summary;
      return result.notes;
    });
    // `summary` is assigned synchronously inside the updater above.
    return summary;
  }, []);

  const directFlush = useCallback(
    async (updates: ReadonlyArray<{ path: NotePath; content: string }>): Promise<void> => {
      if (updates.length === 0) return;

      // Apply patches to the CURRENT rawNotes synchronously using the functional
      // updater pattern - we need the patched array both for the immediate
      // storage write AND for the React state update.
      let patched = latestNotesRef.current;
      for (const { path, content } of updates) {
        try {
          patched = updateNoteContentOp(patched, path, content);
        } catch {
          // Note deleted between draft capture and flush - skip, don't abort.
        }
      }

      // Write DIRECTLY to storage. This races to complete before the browser
      // unloads the page - unlike setRawNotes which defers through useEffect.
      if (encryptedStore.current) {
        await encryptedStore.current.save(patched);
      } else {
        await store.save(patched);
      }

      // Also update React state so the UI stays consistent if the tab isn't
      // actually closing (e.g. visibilitychange=hidden on mobile, resume later).
      setRawNotes(patched);
    },
    [],
  );

  const resetVault = useCallback(async () => {
    if (encryptedStore.current) {
      encryptedStore.current.clear();
      encryptedStore.current = null;
      setEncryptionEnabled(false);
    } else {
      await store.clear();
    }
    const seeded = await store.load();
    setRawNotes(seeded);
  }, []);

  const reload = useCallback(async () => {
    // Re-read from whichever store is currently active (encrypted or adapter).
    // No clear, no reseed - purely a refresh of in-memory state.
    const source = encryptedStore.current ?? store;
    const loaded = await source.load();
    setRawNotes(loaded);
    setReady(true);
  }, []);

  const restoreFromSnapshot = useCallback(
    async (snapshotId: string): Promise<boolean> => {
      const merged = await getBackupStore().restoreSnapshot(snapshotId, rawNotes, mergeImport);
      if (merged === undefined) return false;
      setRawNotes(merged);
      return true;
    },
    [rawNotes],
  );

  const search = useCallback((query: string) => searchIndex.current?.search(query) ?? [], []);

  const resolveLink = useCallback(
    (target: string) => resolver.get(target.trim().replace(/\.md$/i, '').toLowerCase()) ?? null,
    [resolver],
  );

  const backlinksFor = useCallback((path: NotePath) => backlinks.get(path) ?? [], [backlinks]);

  const notesWithTag = useCallback((tag: string) => notesWithTagOp(notes, tag), [notes]);

  return {
    ready,
    notes,
    tags,
    getNote,
    backlinksFor,
    notesWithTag,
    search,
    resolveLink,
    createNote,
    updateContent,
    renameNote,
    deleteNote,
    importNotes,
    directFlush,
    resetVault,
    reload,
    restoreFromSnapshot,
    encryptionEnabled,
    needsPassphrase,
    unlock,
    enableEncryption,
    disableEncryption,
  };
}
