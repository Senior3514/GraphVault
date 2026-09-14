'use client';

/**
 * React hook that drives a sync cycle from the browser.
 *
 * It wires the live vault (from `useVaultContext`) and the server connection
 * (base URL + bearer token) to `@graphvault/sync-core`'s `runSync` through the
 * {@link createLocalVault} and {@link createRemoteApi} adapters, and exposes the
 * status the `/sync-status` page renders: `{ status, lastSyncAt, pendingCount,
 * conflicts, syncNow }`.
 *
 * The pending count is derived from the persisted sync index (dirty entries);
 * last-sync metadata and conflicts persist in `localStorage` via `syncMeta`.
 *
 * ## deviceId binding
 *
 * When a bearer token is present (user is signed in), the `deviceId` from the
 * auth token MUST be used for the push request. The server enforces that the
 * push `deviceId` matches the authenticated device. Pass `deviceId` (from
 * `useAuth`) into `UseSyncOptions.deviceId` whenever a token is present.
 * When offline or not signed in, the locally generated id from syncMeta is used.
 */

import { runSync, type ResolvedConflict, type SyncResult } from '@graphvault/sync-core';
import type { LocalFileEntry } from '@graphvault/shared';
import { useCallback, useEffect, useState } from 'react';

import { useVaultContext } from '../vault/VaultProvider';
import { createLocalVault, SYNC_INDEX_KEY, type VaultMutator } from './localVault';
import { createRemoteApi } from './remoteApi';
import { loadSyncMeta, saveSyncMeta, type SyncMeta } from './syncMeta';

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error';

export interface UseSyncOptions {
  /** Server base URL (from Settings). */
  serverUrl: string;
  /** Bearer token, if the user is authenticated. */
  token?: string;
  /** The adopted server vault id, if registered. */
  vaultId?: string;
  /**
   * The device id bound to the current auth token. Must match what the server
   * recorded at login/register. Required when `token` is present.
   */
  deviceId?: string;
}

export interface UseSync {
  status: SyncStatus;
  lastSyncAt: string | null;
  pendingCount: number;
  conflicts: ResolvedConflict[];
  error: string | null;
  /** True while a sync cycle is in flight. */
  busy: boolean;
  /** Whether a sync can run (server configured + a vault id + a bearer token). */
  canSync: boolean;
  /** Run one sync cycle now. Resolves to the result, or null on error. */
  syncNow(): Promise<SyncResult | null>;
}

function countDirty(): number {
  try {
    const raw = window.localStorage.getItem(SYNC_INDEX_KEY);
    if (!raw) return 0;
    const entries = JSON.parse(raw) as LocalFileEntry[];
    if (!Array.isArray(entries)) return 0;
    return entries.filter((e) => e?.dirty).length;
  } catch {
    return 0;
  }
}

export function useSync(options: UseSyncOptions): UseSync {
  const { serverUrl, token, vaultId, deviceId: authDeviceId } = options;
  const vault = useVaultContext();

  const [status, setStatus] = useState<SyncStatus>('idle');
  const [meta, setMeta] = useState<SyncMeta | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Load persisted metadata + pending count on mount.
  useEffect(() => {
    setMeta(loadSyncMeta());
    setPendingCount(countDirty());
  }, []);

  const resolvedVaultId = vaultId ?? meta?.vaultId;
  // canSync requires a server URL, a vault id, AND a bearer token.
  const canSync = Boolean(serverUrl && resolvedVaultId && token);

  const syncNow = useCallback(async (): Promise<SyncResult | null> => {
    const current = meta ?? loadSyncMeta();
    const targetVault = vaultId ?? current.vaultId;

    if (!token) {
      setError('Not signed in. Sign in from the Settings page to sync.');
      setStatus('error');
      return null;
    }
    if (!targetVault) {
      setError('No vault registered on the server yet. Register a vault in Settings.');
      setStatus('error');
      return null;
    }

    setStatus('syncing');
    setError(null);

    // The server enforces that push.deviceId matches the authenticated device.
    // Use the auth-bound deviceId when available.
    const effectiveDeviceId = authDeviceId ?? current.deviceId;
    const effectiveDeviceName = current.deviceName;

    const mutator: VaultMutator = {
      notes: () => vault.notes.map((n) => ({ ...n })),
      upsert: (path, content, _mtime) => {
        // _mtime is provided by the sync engine (server mtime). The web vault's
        // updateContent / createNote always sets mtime to Date.now() - acceptable
        // because the sync index records the canonical server mtime separately.
        if (vault.getNote(path)) {
          vault.updateContent(path, content);
        } else {
          vault.createNote(path, content);
        }
      },
      remove: (path) => {
        if (vault.getNote(path)) vault.deleteNote(path);
      },
    };

    const local = createLocalVault(mutator);
    const remote = createRemoteApi({ baseUrl: serverUrl, token });

    try {
      const result = await runSync(local, remote, targetVault, {
        deviceId: effectiveDeviceId,
        deviceName: effectiveDeviceName,
      });

      const nextMeta: SyncMeta = {
        ...current,
        vaultId: targetVault,
        // Anchor the auth-bound deviceId so subsequent syncs also use it.
        deviceId: authDeviceId ?? current.deviceId,
        lastSyncAt: new Date().toISOString(),
        lastRevision: result.newRevision,
        // Accumulate conflicts; the user clears them by merging/deleting copies.
        conflicts: dedupeConflicts([...current.conflicts, ...result.conflicts]),
      };
      saveSyncMeta(nextMeta);
      setMeta(nextMeta);
      setPendingCount(countDirty());
      setStatus('synced');
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
      setStatus('error');
      setPendingCount(countDirty());
      return null;
    }
  }, [meta, serverUrl, token, vault, vaultId, authDeviceId]);

  return {
    status,
    lastSyncAt: meta?.lastSyncAt ?? null,
    pendingCount,
    conflicts: meta?.conflicts ?? [],
    error,
    busy: status === 'syncing',
    canSync,
    syncNow,
  };
}

/** Keep the latest conflict per (path, copy) pair. */
function dedupeConflicts(conflicts: ResolvedConflict[]): ResolvedConflict[] {
  const byKey = new Map<string, ResolvedConflict>();
  for (const c of conflicts) byKey.set(`${c.path}${c.conflictCopyPath}`, c);
  return [...byKey.values()];
}
