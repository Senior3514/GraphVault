/**
 * Pluggable storage backend seam.
 *
 * A {@link StorageAdapter} is any object that can load/save/clear a set of
 * {@link Note} objects and describes itself with an `id`, `label`, and an
 * `isAvailable()` guard so the registry can pick the best adapter for the
 * current environment.
 *
 * Registry rule: adapters are probed in registration order; the first one
 * that passes `isAvailable()` is returned. The `localStorage` adapter is the
 * universal fallback - it is always registered last with a guaranteed
 * `isAvailable() === true` (when `window.localStorage` exists in the host).
 *
 * Callers obtain the active adapter once (module-level or in a hook) and pass
 * it to {@link LocalStorageVaultStore} (or any other {@link VaultStore}). They
 * never depend on a concrete adapter class directly, keeping all UI code
 * backend-agnostic.
 */

import type { Note } from '../types';

// ---------------------------------------------------------------------------
// StorageAdapter interface
// ---------------------------------------------------------------------------

/**
 * The persistence boundary every concrete backend must satisfy.
 *
 * Implementations MUST:
 *  - Never silently discard data - prefer throwing over quiet data loss.
 *  - Be idempotent: `save(notes)` followed immediately by `load()` must return
 *    an equivalent array.
 *  - Degrade gracefully: if the environment does not support the adapter,
 *    `isAvailable()` returns `false` and the factory will not select it.
 */
export interface StorageAdapter {
  /** Stable machine-readable identifier, e.g. `"localStorage"`. */
  readonly id: string;

  /** Human-readable label shown in Settings UI, e.g. `"Browser storage"`. */
  readonly label: string;

  /**
   * Returns `true` when the adapter is usable in the current environment.
   * Called synchronously; must not throw.
   */
  isAvailable(): boolean;

  /**
   * Return the full list of notes. On first call with no prior data the
   * adapter SHOULD seed sample notes and persist them before returning.
   *
   * Must not throw on empty/missing storage; should recover from corrupt data
   * (see {@link localStorageAdapter} for the backup-then-reseed pattern).
   */
  load(): Promise<Note[]>;

  /**
   * Persist the authoritative list of notes. Replaces everything previously
   * stored - callers are responsible for passing the full set.
   */
  save(notes: Note[]): Promise<void>;

  /**
   * Remove all stored data. Called by "reset vault" in Settings. Must not
   * throw if storage is already empty.
   */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Ordered list of registered adapters (probe order = registration order). */
const registry: StorageAdapter[] = [];

/**
 * Register a new adapter. Adapters are probed in order; earlier registrations
 * take priority when both are available. Call this at module initialisation
 * time - before {@link getActiveAdapter} is first invoked.
 */
export function registerAdapter(adapter: StorageAdapter): void {
  registry.push(adapter);
}

/**
 * Return the first registered adapter that passes `isAvailable()`.
 *
 * Throws if no adapter is available (the caller must ensure at least one
 * universal fallback is registered before calling this).
 */
export function getActiveAdapter(): StorageAdapter {
  for (const adapter of registry) {
    if (adapter.isAvailable()) {
      return adapter;
    }
  }
  throw new Error(
    'GraphVault: no storage adapter is available in this environment. ' +
      'Register at least one adapter before calling getActiveAdapter().',
  );
}

/**
 * Return the registered adapter with the given `id`, or `undefined` if none
 * matches. Useful for testing or explicit adapter selection.
 */
export function getAdapterById(id: string): StorageAdapter | undefined {
  return registry.find((a) => a.id === id);
}

/**
 * Return a snapshot of all registered adapters (in probe order), regardless
 * of availability. Useful for building a "storage backend" settings UI.
 */
export function listAdapters(): readonly StorageAdapter[] {
  return registry.slice();
}

/**
 * Remove all registered adapters. Intended for use in tests only - never call
 * this in production code.
 */
export function _resetRegistry(): void {
  registry.length = 0;
}
