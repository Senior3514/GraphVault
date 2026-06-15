'use client';

/**
 * Sync status overview — wired to the real sync engine and auth state.
 *
 * - Server health is checked via the existing `GraphVaultClient`.
 * - Auth state is read from `useAuth`: shows whether the user is signed in and
 *   provides a link to Settings to sign in or register a vault.
 * - "Sync now" runs a real `@graphvault/sync-core` cycle (SCAN→PULL→PUSH→SETTLE)
 *   through the web adapters (useSync): it scans the local vault, pulls/pushes,
 *   and resolves conflicts into conflict copies. Never silently loses data.
 * - Last sync time, pending change count, and the conflicts list reflect real
 *   persisted local state from localStorage (sync index + sync metadata).
 *
 * ## Enabling sync
 *
 *   1. Go to Settings and configure the server URL.
 *   2. Sign in or register an account on your server.
 *   3. Register a server vault (or adopt an existing one) in Settings.
 *   4. Return here and click "Sync now".
 *
 * ## Offline / error handling
 *
 *   - Server unreachable: health check shows "Offline"; sync is disabled.
 *   - Not signed in: sync is disabled with a clear message; token in sessionStorage
 *     is lost on tab close, so sign in again on each new session.
 *   - No vault registered: sync is disabled with guidance.
 *   - Sync error: shown inline; the vault is never partially written (the local
 *     index is only committed after a successful SETTLE).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { GraphVaultClient, type HealthInfo } from '../../lib/api/client';
import { useAuth } from '../../lib/api/useAuth';
import { useServerSettings } from '../../lib/api/useServerSettings';
import { useSync, loadSyncMeta } from '../../lib/sync';
import { useVaultContext } from '../../lib/vault/VaultProvider';

type HealthState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; info: HealthInfo }
  | { kind: 'error'; message: string };

export default function SyncStatusPage() {
  const { serverUrl, loaded: settingsLoaded } = useServerSettings();
  const vault = useVaultContext();
  const auth = useAuth();
  const [health, setHealth] = useState<HealthState>({ kind: 'idle' });

  // Read the stored vault id so we can pass it to useSync.
  const [storedVaultId, setStoredVaultId] = useState<string | undefined>(undefined);
  useEffect(() => {
    const meta = loadSyncMeta();
    setStoredVaultId(meta.vaultId);
  }, []);

  const sync = useSync({
    serverUrl,
    token: auth.token ?? undefined,
    vaultId: storedVaultId,
    deviceId: auth.deviceId ?? undefined,
  });

  const check = useCallback(async () => {
    setHealth({ kind: 'checking' });
    try {
      const info = await new GraphVaultClient(serverUrl).health();
      setHealth({ kind: 'ok', info });
    } catch (err) {
      setHealth({ kind: 'error', message: err instanceof Error ? err.message : 'Unreachable' });
    }
  }, [serverUrl]);

  useEffect(() => {
    if (settingsLoaded) void check();
  }, [settingsLoaded, check]);

  const online = health.kind === 'ok';

  // Determine why sync is blocked, for a specific user-facing message.
  const syncBlockReason: string | null = !auth.loaded
    ? null // still loading
    : !auth.isSignedIn
      ? 'Not signed in'
      : !storedVaultId && !sync.canSync
        ? 'No vault registered'
        : !online
          ? 'Server offline'
          : null;

  return (
    <main className="mx-auto w-full max-w-3xl overflow-auto px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Sync status</h1>
      <p className="mt-1 text-sm text-neutral-500">Self-hosted sync. Your notes, your server.</p>

      {/* ------------------------------------------------------------------ */}
      {/* Server connection                                                   */}
      {/* ------------------------------------------------------------------ */}
      <section className="mt-8 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-200">Server connection</h2>
          <button
            type="button"
            onClick={() => void check()}
            className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            Re-check
          </button>
        </div>
        <p className="mt-1 break-all text-xs text-neutral-500">{serverUrl}</p>
        <div className="mt-3 text-sm">
          {health.kind === 'checking' && <Badge tone="neutral">Checking…</Badge>}
          {health.kind === 'idle' && <Badge tone="neutral">Not checked</Badge>}
          {health.kind === 'error' && (
            <div>
              <Badge tone="red">Offline</Badge>
              <p className="mt-2 text-xs text-neutral-500">{health.message}</p>
              <p className="mt-1 text-xs text-neutral-600">
                Configure the server URL in{' '}
                <Link href="/settings" className="underline hover:text-neutral-400">
                  Settings
                </Link>
                .
              </p>
            </div>
          )}
          {health.kind === 'ok' && (
            <div>
              <Badge tone="green">Online</Badge>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
                <dt>API version</dt>
                <dd className="text-neutral-200">{health.info.apiVersion}</dd>
                <dt>Sync protocol</dt>
                <dd className="text-neutral-200">v{health.info.syncProtocolVersion}</dd>
                <dt>Server time</dt>
                <dd className="text-neutral-200">{health.info.time}</dd>
              </dl>
            </div>
          )}

          {/* Account status row */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span>Account:</span>
            {!auth.loaded ? (
              <Badge tone="neutral">Loading…</Badge>
            ) : auth.isSignedIn ? (
              <>
                <Badge tone="green">Signed in</Badge>
                <span className="text-neutral-600">{auth.userId}</span>
              </>
            ) : (
              <>
                <Badge tone="neutral">Not signed in</Badge>
                <Link href="/settings" className="underline hover:text-neutral-400">
                  Sign in or register in Settings
                </Link>
              </>
            )}
          </div>

          {/* Vault status row */}
          {auth.isSignedIn && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              <span>Vault:</span>
              {storedVaultId ? (
                <>
                  <Badge tone="green">Registered</Badge>
                  <span className="truncate text-neutral-600 max-w-[16rem]">{storedVaultId}</span>
                </>
              ) : (
                <>
                  <Badge tone="neutral">None</Badge>
                  <Link href="/settings" className="underline hover:text-neutral-400">
                    Register a vault in Settings
                  </Link>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Sync controls                                                       */}
      {/* ------------------------------------------------------------------ */}
      <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-200">Sync</h2>
          <button
            type="button"
            disabled={sync.busy || !sync.canSync}
            onClick={() => void sync.syncNow()}
            className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-emerald-50 hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {sync.busy ? 'Syncing…' : 'Sync now'}
          </button>
        </div>

        <p className="mt-2 text-sm text-neutral-400">
          {sync.lastSyncAt ? (
            <>
              Last synced <span className="text-neutral-200">{formatTime(sync.lastSyncAt)}</span>
              {sync.status === 'synced' && ' — up to date.'}
            </>
          ) : (
            'Never synced. Connect to your server and run a sync to reconcile this vault.'
          )}
        </p>

        {/* Blocked reasons */}
        {!sync.canSync && syncBlockReason && (
          <div className="mt-2 text-xs">
            {syncBlockReason === 'Not signed in' && (
              <p className="text-amber-400/80">
                Not signed in.{' '}
                <Link href="/settings" className="underline hover:text-amber-300">
                  Sign in from Settings
                </Link>{' '}
                to enable sync.
              </p>
            )}
            {syncBlockReason === 'No vault registered' && (
              <p className="text-amber-400/80">
                No server vault is registered.{' '}
                <Link href="/settings" className="underline hover:text-amber-300">
                  Register or adopt a vault in Settings
                </Link>{' '}
                to enable sync.
              </p>
            )}
            {syncBlockReason === 'Server offline' && (
              <p className="text-amber-400/80">
                Server is not reachable. Check the URL in{' '}
                <Link href="/settings" className="underline hover:text-amber-300">
                  Settings
                </Link>{' '}
                and ensure the server is running.
              </p>
            )}
          </div>
        )}

        {sync.status === 'error' && sync.error && (
          <p className="mt-2 text-xs text-red-400">{sync.error}</p>
        )}

        {sync.status === 'synced' && (
          <p className="mt-2 text-xs text-emerald-400">
            Sync complete. All devices converged on the same vault state.
          </p>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Stats                                                               */}
      {/* ------------------------------------------------------------------ */}
      <section className="mt-6 grid grid-cols-3 gap-4">
        <Stat label="Notes in vault" value={vault.ready ? String(vault.notes.length) : '—'} />
        <Stat
          label="Pending changes"
          value={String(sync.pendingCount)}
          hint={sync.pendingCount === 0 ? 'Nothing to push' : 'Local edits awaiting sync'}
        />
        <Stat
          label="Conflicts"
          value={String(sync.conflicts.length)}
          hint={sync.conflicts.length === 0 ? 'None' : 'Conflict copies created'}
        />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Conflicts list                                                      */}
      {/* ------------------------------------------------------------------ */}
      <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5 text-sm">
        <h2 className="text-sm font-semibold text-neutral-200">Conflicts</h2>
        {sync.conflicts.length === 0 ? (
          <p className="mt-2 text-neutral-400">
            No conflicts. When two devices edit the same note, GraphVault keeps the server version
            and saves your local copy alongside it so nothing is ever lost.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {sync.conflicts.map((c) => (
              <li
                key={`${c.path}:${c.conflictCopyPath}`}
                className="rounded border border-neutral-800 bg-neutral-950/40 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="amber">{conflictLabel(c.kind)}</Badge>
                  <span className="break-all text-xs text-neutral-300">{c.path}</span>
                </div>
                <p className="mt-2 break-all text-xs text-neutral-500">
                  Your version was preserved as{' '}
                  <span className="text-neutral-300">{c.conflictCopyPath}</span>. Merge it into the
                  canonical note, then delete the copy.
                </p>
                <p className="mt-1 text-[11px] text-neutral-600">Resolved {formatTime(c.at)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function conflictLabel(kind: string): string {
  switch (kind) {
    case 'CONTENT_CONFLICT':
      return 'Edited on two devices';
    case 'DELETE_EDIT_CONFLICT':
      return 'Deleted vs. edited';
    default:
      return kind;
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function Badge({
  tone,
  children,
}: {
  tone: 'green' | 'red' | 'neutral' | 'amber';
  children: React.ReactNode;
}) {
  const cls = {
    green: 'bg-emerald-900/40 text-emerald-300',
    red: 'bg-red-900/40 text-red-300',
    neutral: 'bg-neutral-800 text-neutral-300',
    amber: 'bg-amber-900/40 text-amber-300',
  }[tone];
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs ${cls}`}>{children}</span>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="text-2xl font-semibold text-neutral-100">{value}</div>
      <div className="mt-1 text-xs text-neutral-400">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-neutral-600">{hint}</div>}
    </div>
  );
}
