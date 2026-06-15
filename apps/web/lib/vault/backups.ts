/**
 * IndexedDB-backed snapshot store for automatic local version history.
 *
 * ## Why IndexedDB?
 * `localStorage` is wiped by browser cache-clears. IndexedDB is a separate,
 * more durable storage mechanism with a much higher capacity limit. Snapshots
 * live here so a cache-clear that nukes `localStorage` does NOT destroy history.
 *
 * ## Snapshot model
 * A snapshot is a point-in-time copy of the full vault (array of Notes)
 * serialised to JSON. Each snapshot carries:
 *   - `id`          — opaque string (timestamp + random suffix), used as IDB key.
 *   - `takenAt`     — epoch ms when the snapshot was taken.
 *   - `noteCount`   — how many notes were captured (for the UI without deserialising).
 *   - `label`       — optional human-readable label (e.g. "pre-restore").
 *   - `notesJson`   — serialised Note[] (JSON string stored inline).
 *
 * ## Retention policy
 * `pruneOld()` keeps:
 *   - The most recent `RETENTION_RECENT` snapshots (regardless of age).
 *   - At most one snapshot per calendar day for the last `RETENTION_DAILY_DAYS` days.
 *   - Everything else is deleted.
 *
 * This means you always have ~20 granular recent snapshots PLUS one per-day
 * recovery point going back N days.
 *
 * ## Restore is non-destructive
 * `restoreSnapshot(id, currentNotes, mergeImportFn)` first takes a fresh
 * "pre-restore" snapshot of the current vault state, then applies the
 * snapshot's notes via the collision-safe `mergeImport` merge, so nothing is
 * silently overwritten.
 *
 * ## Testability
 * The IDB layer is injected through the {@link IDBStore} interface so tests
 * can substitute an in-memory implementation without any browser APIs.
 */

import type { Note } from './types';
import type { ImportNote } from './vault';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Lightweight snapshot descriptor returned by {@link BackupStore.listSnapshots}. */
export interface SnapshotMeta {
  id: string;
  takenAt: number;
  noteCount: number;
  label?: string;
}

/** Full snapshot including the serialised notes payload. */
export interface Snapshot extends SnapshotMeta {
  /** JSON-encoded Note[] */
  notesJson: string;
}

// ---------------------------------------------------------------------------
// Retention constants (exported so tests can assert on policy)
// ---------------------------------------------------------------------------

/** Keep at least this many recent snapshots unconditionally. */
export const RETENTION_RECENT = 20;
/** Keep one snapshot per calendar day for this many days back. */
export const RETENTION_DAILY_DAYS = 30;

// ---------------------------------------------------------------------------
// IDBStore port — inject in prod, fake in tests
// ---------------------------------------------------------------------------

/**
 * Minimal async key-value store interface backed by IndexedDB (or a fake in
 * tests). Keys are strings; values are Snapshot objects.
 */
export interface IDBStore {
  /** Insert or replace a snapshot. */
  put(snapshot: Snapshot): Promise<void>;
  /** Retrieve a snapshot by id. Returns undefined if not found. */
  get(id: string): Promise<Snapshot | undefined>;
  /** Return ALL snapshots ordered by `takenAt` ascending. */
  getAll(): Promise<Snapshot[]>;
  /** Delete a snapshot by id. No-op if not found. */
  delete(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Real IndexedDB store
// ---------------------------------------------------------------------------

const DB_NAME = 'graphvault-backups';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';

function openDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
  });
}

let _dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (!_dbPromise) _dbPromise = openDb();
  return _dbPromise;
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}

/**
 * Real {@link IDBStore} implementation backed by the browser's IndexedDB.
 */
export class RealIDBStore implements IDBStore {
  async put(snapshot: Snapshot): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await idbRequest(tx.objectStore(STORE_NAME).put(snapshot));
  }

  async get(id: string): Promise<Snapshot | undefined> {
    const db = await getDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const result = await idbRequest<Snapshot | undefined>(tx.objectStore(STORE_NAME).get(id));
    return result;
  }

  async getAll(): Promise<Snapshot[]> {
    const db = await getDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const all = await idbRequest<Snapshot[]>(tx.objectStore(STORE_NAME).getAll());
    return all.sort((a, b) => a.takenAt - b.takenAt);
  }

  async delete(id: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await idbRequest(tx.objectStore(STORE_NAME).delete(id));
  }
}

// ---------------------------------------------------------------------------
// BackupStore — the public API
// ---------------------------------------------------------------------------

function generateId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function toDateKey(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/**
 * High-level backup service. Inject an {@link IDBStore} for the storage
 * backend (use {@link RealIDBStore} in the browser, an in-memory fake in
 * tests).
 */
export class BackupStore {
  constructor(private readonly store: IDBStore) {}

  /**
   * Capture a full snapshot of the current vault.
   *
   * @param notes  Current notes array.
   * @param label  Optional label (e.g. "pre-restore", "manual").
   * @returns      The created snapshot id.
   */
  async takeSnapshot(notes: readonly Note[], label?: string): Promise<string> {
    const id = generateId();
    const takenAt = Date.now();
    const notesJson = JSON.stringify(notes);
    const snapshot: Snapshot = {
      id,
      takenAt,
      noteCount: notes.length,
      notesJson,
      ...(label ? { label } : {}),
    };
    await this.store.put(snapshot);
    return id;
  }

  /**
   * Return all snapshots, newest first, WITHOUT the large `notesJson` payload.
   */
  async listSnapshots(): Promise<SnapshotMeta[]> {
    const all = await this.store.getAll();
    return all
      .slice()
      .reverse()
      .map(({ id, takenAt, noteCount, label }) => ({ id, takenAt, noteCount, label }));
  }

  /**
   * Load a full snapshot (including `notesJson`) by id.
   * Returns `undefined` if not found.
   */
  async getSnapshot(id: string): Promise<Snapshot | undefined> {
    return this.store.get(id);
  }

  /**
   * Delete a specific snapshot by id.
   */
  async deleteSnapshot(id: string): Promise<void> {
    return this.store.delete(id);
  }

  /**
   * Apply retention policy and remove old snapshots.
   *
   * Keeps:
   *   1. The `RETENTION_RECENT` most recent snapshots (unconditionally).
   *   2. One snapshot per calendar day for the past `RETENTION_DAILY_DAYS` days.
   *
   * Snapshots outside both windows are deleted.
   */
  async pruneOld(): Promise<void> {
    const all = await this.store.getAll(); // ascending by takenAt
    if (all.length === 0) return;

    const cutoff = Date.now() - RETENTION_DAILY_DAYS * 24 * 60 * 60 * 1000;

    // The RETENTION_RECENT newest are always kept (tail of ascending list).
    const keepRecent = new Set(all.slice(-RETENTION_RECENT).map((s) => s.id));

    // For each calendar day within the daily window, keep only the newest
    // snapshot of that day (ascending order so later entries overwrite earlier).
    const byDay = new Map<string, Snapshot>();
    for (const snap of all) {
      if (snap.takenAt >= cutoff) {
        byDay.set(toDateKey(snap.takenAt), snap);
      }
    }
    const keepDaily = new Set(Array.from(byDay.values()).map((s) => s.id));

    for (const snap of all) {
      if (!keepRecent.has(snap.id) && !keepDaily.has(snap.id)) {
        await this.store.delete(snap.id);
      }
    }
  }

  /**
   * Non-destructive restore of a snapshot.
   *
   * Safety guarantee: before restoring, a "pre-restore" snapshot of the
   * current vault is taken so the user can always undo the restore. The
   * snapshot notes are then merged into `currentNotes` via the collision-safe
   * `mergeImport` function — identical notes are de-duped, collisions become
   * "(imported)" copies. Nothing is silently overwritten.
   *
   * @param id            The snapshot to restore.
   * @param currentNotes  The current in-memory notes (will be snapshotted first).
   * @param mergeImportFn The collision-safe import merge from `vault.ts`.
   * @returns             The merged note array (pass to `setRawNotes`), or
   *                      `undefined` if the snapshot was not found.
   */
  async restoreSnapshot(
    id: string,
    currentNotes: readonly Note[],
    mergeImportFn: (
      existing: Note[],
      incoming: readonly ImportNote[],
    ) => { notes: Note[]; summary: unknown },
  ): Promise<Note[] | undefined> {
    const snapshot = await this.store.get(id);
    if (!snapshot) return undefined;

    // 1. Take a safety "pre-restore" snapshot of the current state first.
    await this.takeSnapshot(currentNotes, 'pre-restore');

    // 2. Parse the snapshot's notes.
    let snapshotNotes: Note[];
    try {
      snapshotNotes = JSON.parse(snapshot.notesJson) as Note[];
    } catch {
      throw new Error(`Snapshot ${id} contains invalid JSON.`);
    }

    // 3. Merge: snapshot notes into current notes using collision-safe merge.
    //    Snapshot notes are treated as "incoming". Identical notes are de-duped;
    //    notes at the same path with different content become "(imported)" copies.
    const { notes: merged } = mergeImportFn([...currentNotes], snapshotNotes);
    return merged;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (browser only)
// ---------------------------------------------------------------------------

let _singleton: BackupStore | null = null;

/**
 * Return the module-level {@link BackupStore} singleton backed by real IDB.
 *
 * Only call this inside browser-side code (not during SSR). Tests should
 * construct their own `BackupStore` with an injected fake store.
 */
export function getBackupStore(): BackupStore {
  if (!_singleton) {
    _singleton = new BackupStore(new RealIDBStore());
  }
  return _singleton;
}
