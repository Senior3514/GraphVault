/**
 * Locally persisted sync metadata.
 *
 * Tracks the bits the UI needs across reloads but the server does not own:
 * the adopted `vaultId`, this device's id/name, the last successful sync time,
 * and the most recent conflicts. Stored in `localStorage` under one key.
 */

import type { ResolvedConflict } from '@graphvault/sync-core';

const META_KEY = 'graphvault:sync-meta:v1';

export interface SyncMeta {
  /** The server vault this client is adopting, if registered. */
  vaultId?: string;
  /** Stable device id (from the auth token's `deviceId` when available). */
  deviceId: string;
  /** Human-friendly device label used in conflict-copy filenames. */
  deviceName: string;
  /** ISO-8601 timestamp of the last successful sync, if any. */
  lastSyncAt?: string;
  /** Server head revision last reconciled to. */
  lastRevision?: number;
  /** Conflicts surfaced for the user to merge/delete. */
  conflicts: ResolvedConflict[];
}

function defaultMeta(): SyncMeta {
  return {
    deviceId: makeDeviceId(),
    deviceName: defaultDeviceName(),
    conflicts: [],
  };
}

function makeDeviceId(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return `web-${c.randomUUID()}`;
  return `web-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function defaultDeviceName(): string {
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    if (/Macintosh/.test(navigator.userAgent)) return 'mac-web';
    if (/Windows/.test(navigator.userAgent)) return 'windows-web';
    if (/Linux/.test(navigator.userAgent)) return 'linux-web';
  }
  return 'web';
}

export function loadSyncMeta(): SyncMeta {
  try {
    const raw = window.localStorage.getItem(META_KEY);
    if (!raw) {
      const seeded = defaultMeta();
      saveSyncMeta(seeded);
      return seeded;
    }
    const parsed = JSON.parse(raw) as Partial<SyncMeta>;
    return {
      ...defaultMeta(),
      ...parsed,
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
    };
  } catch {
    return defaultMeta();
  }
}

export function saveSyncMeta(meta: SyncMeta): void {
  try {
    window.localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* ignore quota/availability errors */
  }
}

export { META_KEY as SYNC_META_KEY };
