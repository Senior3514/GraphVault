/**
 * Browser-backed vault persistence.
 *
 * The real desktop app will persist notes to the filesystem; for the web shell
 * we persist to `localStorage` behind the {@link VaultStore} abstraction so the
 * UI is fully usable now and the backend is swappable later without UI changes.
 *
 * On first run (no stored data) the store seeds a few sample notes.
 *
 * ## Pluggable storage
 * Persistence is now delegated to the active {@link StorageAdapter}. The
 * registry is pre-populated with adapters in preferred order:
 *
 *   1. {@link fileSystemAdapter} - File System Access API (Chromium, opt-in).
 *   2. {@link localStorageAdapter} - universal browser fallback.
 *
 * Because the File System adapter requires an explicit user gesture to pick a
 * folder, `isAvailable()` returns `false` until `FileSystemAdapter.create()`
 * has been called and the resulting adapter has been installed. The active
 * adapter returned by `getActiveAdapter()` therefore always starts as
 * `localStorageAdapter`, and switches to the FS adapter only when the user
 * explicitly opts in (e.g. from Settings).
 */

import type { Note, VaultStore } from './types';
import { localStorageAdapter } from './storage/localStorageAdapter';
import { fileSystemAdapter } from './storage/fileSystemAdapter';
import { webdavAdapter } from './storage/webdavAdapter';
import { s3Adapter } from './storage/s3Adapter';
import { azureAdapter } from './storage/azureAdapter';
import { gcsAdapter } from './storage/gcsAdapter';
import { getActiveAdapter, registerAdapter, type StorageAdapter } from './storage/index';

// ---------------------------------------------------------------------------
// One-time adapter registration (safe to call multiple times - registry is
// never reset in production). Adapters are probed in registration order; the
// first available one wins.
//
// Priority order:
//   1. webdavAdapter  - WebDAV server proxy (available when signed in + configured)
//   2. s3Adapter      - S3-compatible server proxy (available when signed in + configured)
//   3. azureAdapter   - Azure Blob server proxy (available when signed in + configured)
//   4. gcsAdapter     - Google Cloud Storage server proxy (available when signed in + configured)
//   5. fileSystemAdapter - File System Access API (Chromium, opt-in)
//   6. localStorageAdapter - universal browser fallback (always last)
//
// All server-proxy adapters are listed before the local adapters so that
// once configured, saving goes directly to the user's own storage without
// needing manual selection each time.
//
// Note: isAvailable() on server-proxy adapters checks sessionStorage for a
// token, so they correctly return false during SSR and before sign-in.
// ---------------------------------------------------------------------------

registerAdapter(webdavAdapter);
registerAdapter(s3Adapter);
registerAdapter(azureAdapter);
registerAdapter(gcsAdapter);
registerAdapter(fileSystemAdapter);
registerAdapter(localStorageAdapter);

// Re-export for callers that want the key (e.g. tests or Settings).
export { LOCAL_STORAGE_KEY as STORAGE_KEY_NAME } from './storage/localStorageAdapter';

// Re-export adapter types so host code can work with them directly.
export type { StorageAdapter };
export { getActiveAdapter, registerAdapter, listAdapters, getAdapterById } from './storage/index';
export { localStorageAdapter } from './storage/localStorageAdapter';
export { fileSystemAdapter, FileSystemAdapter } from './storage/fileSystemAdapter';
export { webdavAdapter, WebDavStorageAdapter } from './storage/webdavAdapter';
export { s3Adapter, S3StorageAdapter } from './storage/s3Adapter';
export { azureAdapter, AzureStorageAdapter } from './storage/azureAdapter';
export { gcsAdapter, GcsStorageAdapter } from './storage/gcsAdapter';

// ---------------------------------------------------------------------------
// LocalStorageVaultStore - backward-compatible concrete class
//
// Kept so existing imports of `LocalStorageVaultStore` keep compiling and
// behaving identically to before. Internally it now delegates to
// `localStorageAdapter` rather than duplicating the implementation.
// ---------------------------------------------------------------------------

/**
 * A {@link VaultStore} backed by `window.localStorage`, seeded on first use.
 *
 * @deprecated Prefer using {@link getActiveAdapter} directly, which respects
 *   the registered adapter order (e.g. returns the FS adapter when the user
 *   has picked a folder). `LocalStorageVaultStore` is kept for backward
 *   compatibility and always pins to `localStorage` regardless of the active
 *   adapter.
 */
export class LocalStorageVaultStore implements VaultStore {
  async load(): Promise<Note[]> {
    return localStorageAdapter.load();
  }

  async save(notes: Note[]): Promise<void> {
    return localStorageAdapter.save(notes);
  }

  /** Remove all stored data (used by Settings "reset vault"). */
  async clear(): Promise<void> {
    return localStorageAdapter.clear();
  }
}

// ---------------------------------------------------------------------------
// AdapterVaultStore - the preferred VaultStore implementation going forward
//
// Delegates to whatever adapter is currently active (or to a specific adapter
// passed in the constructor). Use this for new code.
// ---------------------------------------------------------------------------

/**
 * A {@link VaultStore} that delegates to a {@link StorageAdapter}.
 *
 * By default it calls {@link getActiveAdapter} on each operation so it
 * automatically follows adapter switches (e.g. after the user picks a
 * folder). Pass an explicit `adapter` to pin to one backend.
 */
export class AdapterVaultStore implements VaultStore {
  private readonly _adapter: StorageAdapter | null;

  constructor(adapter?: StorageAdapter) {
    this._adapter = adapter ?? null;
  }

  private get adapter(): StorageAdapter {
    return this._adapter ?? getActiveAdapter();
  }

  async load(): Promise<Note[]> {
    return this.adapter.load();
  }

  async save(notes: Note[]): Promise<void> {
    return this.adapter.save(notes);
  }

  async clear(): Promise<void> {
    return this.adapter.clear();
  }
}
