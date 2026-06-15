'use client';

/**
 * Sync status overview. The server health check is wired for real against
 * `NEXT_PUBLIC_GRAPHVAULT_SERVER_URL` (overridable in Settings); last-sync /
 * pending / conflicts are local placeholders until the sync engine lands
 * (Milestone 5).
 */

import { useCallback, useEffect, useState } from 'react';

import { GraphVaultClient, type HealthInfo } from '../../lib/api/client';
import { useServerSettings } from '../../lib/api/useServerSettings';
import { useVaultContext } from '../../lib/vault/VaultProvider';

type HealthState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; info: HealthInfo }
  | { kind: 'error'; message: string };

export default function SyncStatusPage() {
  const { serverUrl, loaded } = useServerSettings();
  const vault = useVaultContext();
  const [health, setHealth] = useState<HealthState>({ kind: 'idle' });

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
    if (loaded) void check();
  }, [loaded, check]);

  return (
    <main className="mx-auto w-full max-w-3xl overflow-auto px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Sync status</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Self-hosted sync. Your notes, your server.
      </p>

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
        </div>
      </section>

      <section className="mt-6 grid grid-cols-3 gap-4">
        <Stat label="Notes in vault" value={vault.ready ? String(vault.notes.length) : '—'} />
        <Stat label="Pending changes" value="0" hint="Local-only until sync" />
        <Stat label="Conflicts" value="0" hint="None" />
      </section>

      <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5 text-sm">
        <h2 className="text-sm font-semibold text-neutral-200">Last sync</h2>
        <p className="mt-2 text-neutral-400">
          Never synced — the sync engine arrives in Milestone 5. When connected, this panel
          will show the last sync time, pending pushes, and any conflict copies created to
          preserve data.
        </p>
      </section>
    </main>
  );
}

function Badge({ tone, children }: { tone: 'green' | 'red' | 'neutral'; children: React.ReactNode }) {
  const cls = {
    green: 'bg-emerald-900/40 text-emerald-300',
    red: 'bg-red-900/40 text-red-300',
    neutral: 'bg-neutral-800 text-neutral-300',
  }[tone];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs ${cls}`}>{children}</span>;
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
