'use client';

/**
 * Settings: configure the sync server URL and inspect / reset the local vault.
 * The server URL is persisted (Settings overrides the env default) and used by
 * the API client and the sync-status health check.
 *
 * New sections (M8 / security milestone):
 *  - Storage location: active adapter + switch to File System Access API.
 *  - Vault encryption: enable/disable AES-256-GCM at-rest encryption.
 */

import { useEffect, useRef, useState } from 'react';

import { GraphVaultClient } from '../../lib/api/client';
import { useServerSettings } from '../../lib/api/useServerSettings';
import {
  buildVaultZip,
  exportNotesToJson,
  parseJsonExport,
  readVaultZip,
  type ImportEntry,
} from '../../lib/vault/portability';
import { useVaultContext } from '../../lib/vault/VaultProvider';
import {
  FileSystemAdapter,
  fileSystemAdapter,
  getActiveAdapter,
  listAdapters,
} from '../../lib/vault/store';
import { migrateAdapter } from '../../lib/vault/encryption/migrationHelper';

/** Trigger a browser download of `data` under `filename`. */
function downloadBlob(data: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** A filesystem-safe timestamp like `2026-06-15-1432` for export filenames. */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

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

  const fileInput = useRef<HTMLInputElement | null>(null);
  const [ioMsg, setIoMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const exportZip = () => {
    const zip = buildVaultZip(vault.notes);
    downloadBlob(zip, `graphvault-${stamp()}.zip`, 'application/zip');
    setIoMsg({ kind: 'ok', text: `Exported ${vault.notes.length} notes as a Markdown .zip.` });
  };

  const exportJson = () => {
    const json = exportNotesToJson(vault.notes);
    downloadBlob(json, `graphvault-${stamp()}.json`, 'application/json');
    setIoMsg({ kind: 'ok', text: `Exported ${vault.notes.length} notes as JSON.` });
  };

  const onImportFile = async (file: File) => {
    setIoMsg(null);
    try {
      let entries: ImportEntry[];
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.zip')) {
        entries = await readVaultZip(new Uint8Array(await file.arrayBuffer()));
      } else if (lower.endsWith('.json')) {
        entries = parseJsonExport(await file.text());
      } else {
        // A single markdown/text file.
        entries = [{ path: file.name, content: await file.text() }];
      }
      if (entries.length === 0) {
        setIoMsg({ kind: 'err', text: 'No importable notes found in that file.' });
        return;
      }
      const s = vault.importNotes(entries);
      const parts = [`${s.added} added`];
      if (s.renamed.length) parts.push(`${s.renamed.length} kept as copies (no overwrite)`);
      if (s.unchanged) parts.push(`${s.unchanged} unchanged`);
      setIoMsg({ kind: 'ok', text: `Imported: ${parts.join(', ')}.` });
    } catch (err) {
      setIoMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Import failed.' });
    }
  };

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

      {/* ------------------------------------------------------------------ */}
      {/* Storage location                                                    */}
      {/* ------------------------------------------------------------------ */}
      <StorageSection />

      <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">Vault</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
          <dt>Encryption</dt>
          <dd className="text-neutral-200">
            {vault.encryptionEnabled ? 'On (AES-256-GCM)' : 'Off'}
          </dd>
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

      {/* ------------------------------------------------------------------ */}
      {/* Vault encryption                                                    */}
      {/* ------------------------------------------------------------------ */}
      <EncryptionSection />

      <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">Import &amp; export</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Your data, any storage. Export the whole vault as plain Markdown (zipped) or a single JSON
          backup, and import it anywhere. Nothing leaves your device — this runs entirely in your
          browser.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={exportZip}
            disabled={!vault.ready || vault.notes.length === 0}
            className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
          >
            Export .zip (Markdown)
          </button>
          <button
            type="button"
            onClick={exportJson}
            disabled={!vault.ready || vault.notes.length === 0}
            className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          >
            Export JSON
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
          >
            Import…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.json,.md,.markdown,.txt"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ''; // allow re-importing the same file
              if (file) void onImportFile(file);
            }}
          />
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          Import never overwrites: if a note already exists with different content, your copy is
          kept alongside the imported one.
        </p>
        <div className="mt-2 h-4 text-xs">
          {ioMsg && (
            <span className={ioMsg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
              {ioMsg.text}
            </span>
          )}
        </div>
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

// ---------------------------------------------------------------------------
// Storage section (choose location)
// ---------------------------------------------------------------------------

function StorageSection() {
  const [activeId, setActiveId] = useState<string>(() => {
    try {
      return getActiveAdapter().id;
    } catch {
      return 'localStorage';
    }
  });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const fsApiAvailable = FileSystemAdapter.isApiAvailable();
  const adapters = listAdapters();
  const vault = useVaultContext();

  const switchToFileSystem = async () => {
    setMsg(null);
    setBusy(true);
    try {
      // FileSystemAdapter.create() requires a user gesture — this click handler
      // qualifies. It shows the directory picker.
      const newAdapter = await FileSystemAdapter.create();

      // Migrate notes: copy → verify → activate.
      const source = getActiveAdapter();
      const result = await migrateAdapter(source, newAdapter);

      // Install the new adapter as active.
      fileSystemAdapter.setDirectory(
        // Access the underlying directory handle via the adapter's internal
        // property. We cast via unknown to keep the private API contained.
        (
          newAdapter as unknown as {
            directory: Parameters<typeof fileSystemAdapter.setDirectory>[0];
          }
        ).directory!,
      );

      setActiveId('fileSystem');
      setMsg({
        kind: 'ok',
        text: `Moved ${result.noteCount} note${result.noteCount !== 1 ? 's' : ''} to "${result.to}". Source (${result.from}) preserved as backup — clear it manually when satisfied.`,
      });

      // Reload vault notes from the new adapter.
      await vault.resetVault();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setMsg({ kind: 'warn', text: 'Folder selection cancelled.' });
      } else {
        setMsg({
          kind: 'err',
          text: err instanceof Error ? err.message : 'Failed to switch storage location.',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const switchToLocalStorage = () => {
    // Deactivate the FS adapter by clearing its handle.
    fileSystemAdapter.setDirectory(
      null as unknown as Parameters<typeof fileSystemAdapter.setDirectory>[0],
    );
    setActiveId('localStorage');
    setMsg({ kind: 'ok', text: 'Switched back to browser storage (localStorage).' });
  };

  const activeLabel =
    adapters.find((a) => a.id === activeId)?.label ?? 'Browser storage (localStorage)';

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">Storage location</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Choose where your notes are stored. Switching migrates all notes safely (copy, verify,
        activate) — no data is deleted automatically.
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
        <dt>Active backend</dt>
        <dd className="text-neutral-200">{activeLabel}</dd>
      </dl>

      <div className="mt-3 flex flex-wrap gap-2">
        {fsApiAvailable ? (
          <>
            <button
              type="button"
              disabled={activeId === 'fileSystem' || busy}
              onClick={() => void switchToFileSystem()}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            >
              {busy ? 'Migrating…' : 'Use local folder (File System)'}
            </button>
            <button
              type="button"
              disabled={activeId === 'localStorage' || busy}
              onClick={switchToLocalStorage}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            >
              Use browser storage
            </button>
          </>
        ) : (
          <p className="text-xs text-neutral-500">
            File System Access API is not available in this browser (requires Chrome / Edge 86+).
            Notes are stored in browser localStorage.
          </p>
        )}
      </div>

      <div className="mt-2 min-h-4 text-xs">
        {msg && (
          <span
            className={
              msg.kind === 'ok'
                ? 'text-emerald-400'
                : msg.kind === 'warn'
                  ? 'text-amber-400'
                  : 'text-red-400'
            }
          >
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Encryption section
// ---------------------------------------------------------------------------

type EncryptionStep = 'idle' | 'enable-form' | 'disable-form' | 'busy';

function EncryptionSection() {
  const vault = useVaultContext();
  const [step, setStep] = useState<EncryptionStep>('idle');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const isEnabled = vault.encryptionEnabled;

  const handleEnable = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);

    if (!passphrase) {
      setMsg({ kind: 'err', text: 'Please enter a passphrase.' });
      return;
    }
    if (passphrase !== confirm) {
      setMsg({ kind: 'err', text: 'Passphrases do not match.' });
      return;
    }

    setStep('busy');
    try {
      const count = await vault.enableEncryption(passphrase);
      setMsg({
        kind: 'ok',
        text: `Encryption enabled. ${count} note${count !== 1 ? 's' : ''} encrypted with AES-256-GCM.`,
      });
      setStep('idle');
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to enable encryption.',
      });
      setStep('enable-form');
    } finally {
      setPassphrase('');
      setConfirm('');
    }
  };

  const handleDisable = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);

    if (!passphrase) {
      setMsg({ kind: 'err', text: 'Enter your current passphrase to disable encryption.' });
      return;
    }

    setStep('busy');
    try {
      await vault.disableEncryption(passphrase);
      setMsg({ kind: 'ok', text: 'Encryption disabled. Notes are now stored as plaintext.' });
      setStep('idle');
    } catch (err) {
      setMsg({
        kind: 'err',
        text:
          err instanceof Error ? err.message : 'Failed to disable encryption. Wrong passphrase?',
      });
      setStep('disable-form');
    } finally {
      setPassphrase('');
    }
  };

  const cancel = () => {
    setStep('idle');
    setPassphrase('');
    setConfirm('');
    setMsg(null);
  };

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">Vault encryption</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Encrypt your notes at rest in the browser using AES-256-GCM. The passphrase is never stored
        — you will need it on every session.
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
        <dt>Status</dt>
        <dd className={isEnabled ? 'text-emerald-400' : 'text-neutral-200'}>
          {isEnabled ? 'Enabled (AES-256-GCM)' : 'Disabled (plaintext)'}
        </dd>
      </dl>

      {step === 'idle' && (
        <div className="mt-3">
          {isEnabled ? (
            <button
              type="button"
              onClick={() => {
                setStep('disable-form');
                setMsg(null);
              }}
              className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-1.5 text-sm text-amber-300 hover:bg-amber-950/60"
            >
              Disable encryption
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setStep('enable-form');
                setMsg(null);
              }}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
            >
              Enable encryption
            </button>
          )}
        </div>
      )}

      {/* Enable form */}
      {(step === 'enable-form' || (step === 'busy' && !isEnabled)) && (
        <form onSubmit={(e) => void handleEnable(e)} className="mt-4 space-y-3" noValidate>
          {/* Unmissable warning */}
          <div className="rounded-md border border-amber-900/60 bg-amber-950/20 p-3 text-xs text-amber-300">
            <strong>Warning:</strong> if you lose this passphrase, your notes cannot be recovered.
            There is no reset or recovery mechanism. Back up your notes (export) before enabling
            encryption.
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-400" htmlFor="enc-pass">
              Passphrase
            </label>
            <input
              id="enc-pass"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              disabled={step === 'busy'}
              placeholder="Choose a strong passphrase…"
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
            />
          </div>
          <div>
            <label
              className="mb-1 block text-xs font-medium text-neutral-400"
              htmlFor="enc-confirm"
            >
              Confirm passphrase
            </label>
            <input
              id="enc-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={step === 'busy'}
              placeholder="Repeat passphrase…"
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={step === 'busy' || !passphrase || !confirm}
              className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
            >
              {step === 'busy' ? 'Encrypting…' : 'Encrypt vault'}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={step === 'busy'}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Disable form */}
      {(step === 'disable-form' || (step === 'busy' && isEnabled)) && (
        <form onSubmit={(e) => void handleDisable(e)} className="mt-4 space-y-3" noValidate>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-400" htmlFor="dis-pass">
              Current passphrase
            </label>
            <input
              id="dis-pass"
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              disabled={step === 'busy'}
              placeholder="Enter your current passphrase…"
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={step === 'busy' || !passphrase}
              className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-1.5 text-sm text-amber-300 hover:bg-amber-950/60 disabled:opacity-40"
            >
              {step === 'busy' ? 'Decrypting…' : 'Disable encryption'}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={step === 'busy'}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="mt-2 min-h-4 text-xs">
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}
