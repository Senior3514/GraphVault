/**
 * Tiny IndexedDB-backed store for the File System Access directory handle.
 *
 * `FileSystemDirectoryHandle` objects are *structured-clonable*, so they can be
 * stored in IndexedDB and read back across sessions. localStorage cannot hold
 * them (it is string-only), which is exactly why the previous in-memory-only
 * approach silently lost the user's folder on reload.
 *
 * On a later load we read the handle back and re-request permission (a handle
 * read from IDB starts in the `prompt` state and needs `requestPermission`
 * inside a user gesture, or `queryPermission` to check a still-`granted` one).
 *
 * Everything here is defensive: in any environment without `indexedDB`
 * (SSR, Node test runner, Firefox private mode) the functions resolve to a
 * no-op / `null` rather than throwing, so callers can treat persistence as
 * best-effort.
 */

const DB_NAME = 'graphvault-fs';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'vault-directory';

/** Structural type for the IDB factory so we don't depend on lib.dom specifics. */
function getIndexedDB(): IDBFactory | undefined {
  try {
    if (typeof indexedDB === 'undefined') return undefined;
    return indexedDB;
  } catch {
    return undefined;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  const idb = getIndexedDB();
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(STORE_NAME, mode);
          const store = tx.objectStore(STORE_NAME);
          const req = fn(store);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
          tx.oncomplete = () => db.close();
        } catch {
          resolve(null);
        }
      }),
  );
}

/**
 * Persist the directory handle. Returns true on success, false when IndexedDB
 * is unavailable or the write failed (best-effort — never throws).
 */
export async function saveDirectoryHandle(handle: unknown): Promise<boolean> {
  const result = await withStore<IDBValidKey>('readwrite', (store) =>
    store.put(handle, HANDLE_KEY),
  );
  return result !== null;
}

/** Read the persisted directory handle, or `null` if none / unavailable. */
export async function loadDirectoryHandle<T = unknown>(): Promise<T | null> {
  return withStore<T>('readonly', (store) => store.get(HANDLE_KEY) as IDBRequest<T>);
}

/** Remove the persisted directory handle (e.g. when switching back to localStorage). */
export async function clearDirectoryHandle(): Promise<void> {
  await withStore<undefined>('readwrite', (store) => store.delete(HANDLE_KEY));
}
