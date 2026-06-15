'use client';

/**
 * Settings: configure the sync server URL and inspect / reset the local vault.
 * The server URL is persisted (Settings overrides the env default) and used by
 * the API client and the sync-status health check.
 */

import { useEffect, useState } from 'react';

import { GraphVaultClient } from '../../lib/api/client';
import { useServerSettings } from '../../lib/api/useServerSettings';
import { useVaultContext } from '../../lib/vault/VaultProvider';

export default function SettingsPage() {
  const { serverUrl, setServerUrl, loaded } = useServerSettings();
  const vault = useVaultContext();
  const [draftUrl, setDraftUrl] = useState('');
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<string | null>(null);

  useEffect(() => {
    if (loaded) setDraftUrl(serverUrl);
  }, [loaded, serverUrl]);

  const save = () => {
    setServerUrl(draftUrl);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const testConnection = async () => {
    setTest('Testing…');
    try {
      const info = await new GraphVaultClient(draftUrl.trim()).health();
      setTest(`OK — API ${info.apiVersion}, protocol v${info.syncProtocolVersion}`);
    } catch (err) {
      setTest(`Failed — ${err instanceof Error ? err.message : 'unreachable'}`);
    }
  };

  const totalChars = vault.notes.reduce((n, note) => n + note.content.length, 0);

  const resetVault = async () => {
    if (
      !window.confirm(
        'Reset the local vault to the sample notes? Your current notes will be removed.',
      )
    ) {
      return;
    }
    await vault.resetVault();
  };

  return (
    <main className="mx-auto w-full max-w-3xl overflow-auto px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Settings</h1>

      <section className="mt-8 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">Sync server</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Base URL of your self-hosted GraphVault server. Defaults to
          <code className="mx-1 text-neutral-400">NEXT_PUBLIC_GRAPHVAULT_SERVER_URL</code>.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="url"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder="http://127.0.0.1:4000"
            className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-600"
          />
          <button
            type="button"
            onClick={save}
            className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => void testConnection()}
            className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
          >
            Test
          </button>
        </div>
        <div className="mt-2 h-4 text-xs">
          {saved && <span className="text-emerald-400">Saved.</span>}
          {test && <span className="text-neutral-400">{test}</span>}
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">Vault</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
          <dt>Storage</dt>
          <dd className="text-neutral-200">Browser (localStorage)</dd>
          <dt>Notes</dt>
          <dd className="text-neutral-200">{vault.ready ? vault.notes.length : '—'}</dd>
          <dt>Total content</dt>
          <dd className="text-neutral-200">
            {vault.ready ? `${totalChars.toLocaleString()} chars` : '—'}
          </dd>
        </dl>
        <p className="mt-4 text-xs text-neutral-500">
          This web shell stores notes in your browser. The desktop app will read and write real{' '}
          <code className="text-neutral-400">.md</code> files on disk.
        </p>
        <button
          type="button"
          onClick={() => void resetVault()}
          className="mt-3 rounded-md border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/60"
        >
          Reset vault to samples
        </button>
      </section>

      <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5 text-xs text-neutral-500">
        <h2 className="text-sm font-semibold text-neutral-200">Privacy</h2>
        <p className="mt-2">
          No telemetry. The app only contacts the sync server URL you configure above.
        </p>
      </section>
    </main>
  );
}
