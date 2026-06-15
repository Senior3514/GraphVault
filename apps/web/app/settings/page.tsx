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

import { useCallback, useEffect, useRef, useState } from 'react';

import { GraphVaultClient } from '../../lib/api/client';
import { useAuth } from '../../lib/api/useAuth';
import { useServerSettings } from '../../lib/api/useServerSettings';
import { loadSyncMeta, saveSyncMeta } from '../../lib/sync';
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
import { exportToDirectory, isDirectoryExportSupported } from '../../lib/vault/exportToDirectory';
import { useAISettings } from '../../components/assistant/useAISettings';
import type { AISettings, ByokBackend } from '../../lib/ai/types';

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
  const auth = useAuth();
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
  const [dragOver, setDragOver] = useState(false);
  const [exportingDir, setExportingDir] = useState(false);

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

  /** Import every accepted file from a FileList (used by both picker and DnD). */
  const importFileList = useCallback(
    async (files: FileList | File[]) => {
      setIoMsg(null);
      const list = Array.from(files).filter((f) => {
        const n = f.name.toLowerCase();
        return (
          n.endsWith('.zip') ||
          n.endsWith('.json') ||
          n.endsWith('.md') ||
          n.endsWith('.markdown') ||
          n.endsWith('.txt')
        );
      });
      if (list.length === 0) {
        setIoMsg({ kind: 'err', text: 'No importable files (.zip, .json, .md) found.' });
        return;
      }
      // Accumulate results across multiple files.
      let totalAdded = 0;
      let totalRenamed = 0;
      let totalUnchanged = 0;
      const errors: string[] = [];
      for (const file of list) {
        try {
          let entries: ImportEntry[];
          const lower = file.name.toLowerCase();
          if (lower.endsWith('.zip')) {
            entries = await readVaultZip(new Uint8Array(await file.arrayBuffer()));
          } else if (lower.endsWith('.json')) {
            entries = parseJsonExport(await file.text());
          } else {
            entries = [{ path: file.name, content: await file.text() }];
          }
          if (entries.length === 0) continue;
          const s = vault.importNotes(entries);
          totalAdded += s.added;
          totalRenamed += s.renamed.length;
          totalUnchanged += s.unchanged;
        } catch (err) {
          errors.push(`${file.name}: ${err instanceof Error ? err.message : 'Import failed.'}`);
        }
      }
      if (errors.length > 0 && totalAdded === 0 && totalRenamed === 0 && totalUnchanged === 0) {
        setIoMsg({ kind: 'err', text: errors.join(' ') });
        return;
      }
      const parts = [`${totalAdded} added`];
      if (totalRenamed) parts.push(`${totalRenamed} kept as copies (no overwrite)`);
      if (totalUnchanged) parts.push(`${totalUnchanged} unchanged`);
      if (errors.length) parts.push(`${errors.length} file(s) failed`);
      setIoMsg({ kind: 'ok', text: `Imported: ${parts.join(', ')}.` });
    },
    [vault],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        void importFileList(e.dataTransfer.files);
      }
    },
    [importFileList],
  );

  const exportToFolder = async () => {
    setIoMsg(null);
    setExportingDir(true);
    try {
      const summary = await exportToDirectory(vault.notes);
      const parts = [`${summary.written} note${summary.written !== 1 ? 's' : ''} written`];
      if (summary.errors.length) parts.push(`${summary.errors.length} failed`);
      setIoMsg({ kind: 'ok', text: `Exported to folder: ${parts.join(', ')}.` });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User cancelled the picker — not an error.
        return;
      }
      setIoMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Export failed.' });
    } finally {
      setExportingDir(false);
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

      {/* Account / authentication */}
      <AuthSection auth={auth} serverUrl={serverUrl} />

      {/* Vault registration (only once signed in) */}
      {auth.isSignedIn && <VaultRegistrationSection auth={auth} serverUrl={serverUrl} />}

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

        {/* ---- Export buttons ---- */}
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
          {/* Export to folder — only shown when the File System Access API is available */}
          {isDirectoryExportSupported() && (
            <button
              type="button"
              onClick={() => void exportToFolder()}
              disabled={!vault.ready || vault.notes.length === 0 || exportingDir}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
              title="Write each note as a .md file into a folder you choose"
            >
              {exportingDir ? 'Exporting…' : 'Export to folder…'}
            </button>
          )}
        </div>

        {/* ---- Import: picker button + drag-and-drop zone ---- */}
        <div className="mt-4">
          <p className="mb-2 text-xs text-neutral-500">
            Import from <code className="text-neutral-400">.zip</code>,{' '}
            <code className="text-neutral-400">.json</code>, or individual{' '}
            <code className="text-neutral-400">.md</code> files. Drop files anywhere in the zone
            below, or click the button.
          </p>

          {/* Drag-and-drop target */}
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            aria-label="Drop files here to import"
            className={[
              'flex min-h-[6rem] flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors',
              dragOver
                ? 'border-neutral-400 bg-neutral-800/60'
                : 'border-neutral-700 bg-neutral-900/20 hover:border-neutral-600',
            ].join(' ')}
          >
            <p className="select-none text-xs text-neutral-500">
              {dragOver ? 'Drop to import' : 'Drop .zip / .json / .md here'}
            </p>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
            >
              Import files…
            </button>
          </div>

          <input
            ref={fileInput}
            type="file"
            accept=".zip,.json,.md,.markdown,.txt"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                void importFileList(e.target.files);
              }
              e.target.value = ''; // allow re-importing the same file
            }}
          />
        </div>

        <p className="mt-3 text-xs text-neutral-500">
          Import never overwrites: if a note already exists with different content, your copy is
          kept alongside the imported one.
        </p>
        <div className="mt-2 min-h-4 text-xs">
          {ioMsg && (
            <span className={ioMsg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
              {ioMsg.text}
            </span>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* AI assistant                                                        */}
      {/* ------------------------------------------------------------------ */}
      <AIAssistantSection />

      <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5 text-xs text-neutral-500">
        <h2 className="text-sm font-semibold text-neutral-200">Privacy</h2>
        <p className="mt-2">
          No telemetry. The app only contacts the sync server URL you configure above, and the AI
          provider you explicitly enable (if any).
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

// ---- Sync auth + vault registration (from sync wiring) ----
function Msg({ kind, text }: { kind: 'ok' | 'err' | 'info'; text: string }) {
  const cls =
    kind === 'ok' ? 'text-emerald-400' : kind === 'err' ? 'text-red-400' : 'text-neutral-400';
  return <span className={`text-xs ${cls}`}>{text}</span>;
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type AuthForm = 'none' | 'login' | 'register';

function AuthSection({ auth, serverUrl }: { auth: ReturnType<typeof useAuth>; serverUrl: string }) {
  const [form, setForm] = useState<AuthForm>('none');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const clearForm = useCallback(() => {
    setEmail('');
    setPassword('');
    setMsg(null);
  }, []);

  const handleSubmit = async (e: React.FormEvent, mode: 'login' | 'register') => {
    e.preventDefault();
    if (!email || !password) {
      setMsg({ kind: 'err', text: 'Email and password are required.' });
      return;
    }
    if (!serverUrl) {
      setMsg({ kind: 'err', text: 'Save a server URL first.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      if (mode === 'login') {
        await auth.login({ email, password, serverUrl });
      } else {
        await auth.register({ email, password, serverUrl });
      }
      setMsg({
        kind: 'ok',
        text: mode === 'login' ? 'Signed in.' : 'Account created and signed in.',
      });
      clearForm();
      setForm('none');
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Request failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = () => {
    auth.logout();
    setMsg(null);
    setForm('none');
  };

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">Account</h2>

      {auth.isSignedIn ? (
        <div className="mt-3 space-y-2">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
            <dt>Status</dt>
            <dd className="text-emerald-400">Signed in</dd>
            <dt>User ID</dt>
            <dd className="truncate text-neutral-200">{auth.userId}</dd>
            <dt>Device ID</dt>
            <dd className="truncate text-neutral-200">{auth.deviceId}</dd>
          </dl>
          <p className="text-xs text-neutral-500">
            Token is stored in sessionStorage and cleared when the tab closes. Sign in again on each
            session to sync.
          </p>
          <button
            type="button"
            onClick={handleLogout}
            className="mt-2 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700"
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-neutral-500">
            Sign in or create an account on your server to enable sync. Your password is only sent
            to the server URL configured above over a secure connection. The token is stored in
            sessionStorage (cleared on tab close) — never in a cookie or logged anywhere.
          </p>

          {form === 'none' && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setForm('login');
                  clearForm();
                }}
                className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => {
                  setForm('register');
                  clearForm();
                }}
                className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
              >
                Create account
              </button>
            </div>
          )}

          {(form === 'login' || form === 'register') && (
            <form
              onSubmit={(e) => void handleSubmit(e, form)}
              className="mt-3 space-y-3"
              noValidate
            >
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="auth-email"
                >
                  Email
                </label>
                <input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                  placeholder="you@example.com"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="auth-password"
                >
                  Password
                  {form === 'register' && (
                    <span className="ml-1 text-neutral-600">(min. 10 characters)</span>
                  )}
                </label>
                <input
                  id="auth-password"
                  type="password"
                  autoComplete={form === 'login' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  placeholder={form === 'register' ? 'Choose a strong password…' : 'Your password…'}
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={busy || !email || !password}
                  className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
                >
                  {busy
                    ? form === 'login'
                      ? 'Signing in…'
                      : 'Creating account…'
                    : form === 'login'
                      ? 'Sign in'
                      : 'Create account'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setForm('none');
                    clearForm();
                  }}
                  disabled={busy}
                  className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {msg && (
            <div className="mt-2">
              <Msg kind={msg.kind} text={msg.text} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Vault registration section
// ---------------------------------------------------------------------------

function VaultRegistrationSection({
  auth,
  serverUrl,
}: {
  auth: ReturnType<typeof useAuth>;
  serverUrl: string;
}) {
  const [vaults, setVaults] = useState<{ id: string; name: string }[] | null>(null);
  const [loadingVaults, setLoadingVaults] = useState(false);
  const [newVaultName, setNewVaultName] = useState('');
  const [registering, setRegistering] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [activeVaultId, setActiveVaultId] = useState<string | null>(null);
  const didLoad = useRef(false);

  // Load the current selected vault from syncMeta.
  useEffect(() => {
    const meta = loadSyncMeta();
    setActiveVaultId(meta.vaultId ?? null);
  }, []);

  // Fetch the user's vaults from the server.
  const fetchVaults = useCallback(async () => {
    if (!auth.token) return;
    setLoadingVaults(true);
    setMsg(null);
    try {
      const client = new GraphVaultClient(serverUrl, auth.token);
      const list = await client.listVaults();
      setVaults(list);
    } catch (err) {
      setMsg({
        kind: 'err',
        text: `Could not load vaults: ${err instanceof Error ? err.message : 'request failed'}`,
      });
      setVaults([]);
    } finally {
      setLoadingVaults(false);
    }
  }, [auth.token, serverUrl]);

  // Load vaults once on first render when signed in.
  useEffect(() => {
    if (!didLoad.current && auth.isSignedIn && auth.token) {
      didLoad.current = true;
      void fetchVaults();
    }
  }, [auth.isSignedIn, auth.token, fetchVaults]);

  const registerVault = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newVaultName.trim();
    if (!name) return;
    if (!auth.token) return;
    setRegistering(true);
    setMsg(null);
    try {
      const client = new GraphVaultClient(serverUrl, auth.token);
      const result = await client.registerVault(name);
      // Persist the vault id to syncMeta so useSync picks it up.
      const meta = loadSyncMeta();
      saveSyncMeta({ ...meta, vaultId: result.vaultId });
      setActiveVaultId(result.vaultId);
      setMsg({ kind: 'ok', text: `Vault "${result.name}" registered (id: ${result.vaultId}).` });
      setNewVaultName('');
      // Refresh the vault list.
      await fetchVaults();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Registration failed.' });
    } finally {
      setRegistering(false);
    }
  };

  const adoptVault = (id: string) => {
    const meta = loadSyncMeta();
    saveSyncMeta({ ...meta, vaultId: id });
    setActiveVaultId(id);
    setMsg({ kind: 'ok', text: 'Vault adopted. "Sync now" on the Sync Status page to sync.' });
  };

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-200">Server vault</h2>
        <button
          type="button"
          onClick={() => void fetchVaults()}
          disabled={loadingVaults}
          className="text-xs text-neutral-500 hover:text-neutral-300 disabled:opacity-50"
        >
          {loadingVaults ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        A server vault holds your notes on the server. Register a new one or adopt an existing vault
        to start syncing. The active vault is stored locally and persists across sessions.
      </p>

      {activeVaultId && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
          <dt>Active vault</dt>
          <dd className="truncate text-emerald-400">{activeVaultId}</dd>
        </dl>
      )}

      {/* Existing vaults list */}
      {vaults !== null && vaults.length > 0 && (
        <ul className="mt-3 space-y-1">
          {vaults.map((v) => (
            <li
              key={v.id}
              className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-950/30 px-3 py-2 text-xs"
            >
              <div>
                <span className="text-neutral-200">{v.name}</span>
                <span className="ml-2 truncate text-neutral-600">{v.id}</span>
              </div>
              {v.id === activeVaultId ? (
                <span className="text-emerald-500">Active</span>
              ) : (
                <button
                  type="button"
                  onClick={() => adoptVault(v.id)}
                  className="text-neutral-400 hover:text-neutral-200"
                >
                  Use this
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {vaults !== null && vaults.length === 0 && !msg && (
        <p className="mt-2 text-xs text-neutral-500">
          No vaults on this server yet. Register one below.
        </p>
      )}

      {/* Register new vault */}
      <form onSubmit={(e) => void registerVault(e)} className="mt-4 flex gap-2">
        <input
          type="text"
          value={newVaultName}
          onChange={(e) => setNewVaultName(e.target.value)}
          placeholder="My vault"
          disabled={registering}
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={registering || !newVaultName.trim()}
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
        >
          {registering ? 'Registering…' : 'Register vault'}
        </button>
      </form>

      <div className="mt-2 min-h-4">{msg && <Msg kind={msg.kind} text={msg.text} />}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AI assistant settings section
// ---------------------------------------------------------------------------

function AIAssistantSection() {
  const { settings, update } = useAISettings();
  const [showKey, setShowKey] = useState(false);

  const handleKindChange = (kind: AISettings['kind']) => {
    update({ kind });
  };

  const handleByokBackendChange = (backend: ByokBackend) => {
    // When switching to Anthropic, default the model if it looks like an OpenAI model.
    const modelPatch: Partial<AISettings> = {};
    if (backend === 'anthropic' && settings.byokModel.startsWith('gpt-')) {
      modelPatch.byokModel = 'claude-sonnet-4-6';
    } else if (backend === 'openai-compatible' && settings.byokModel.startsWith('claude-')) {
      modelPatch.byokModel = 'gpt-4o-mini';
    }
    update({ byokBackend: backend, ...modelPatch });
  };

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">AI assistant</h2>

      {/* Unmissable privacy notice */}
      <div className="mt-2 rounded-md border border-amber-900/60 bg-amber-950/20 p-3 text-xs text-amber-300">
        <strong>Privacy notice:</strong> your notes leave your device only if you enable a cloud
        provider below. <strong>Local</strong> and <strong>Off</strong> modes keep everything
        on-device. API keys are stored in sessionStorage only and cleared when the tab closes — they
        are never logged, synced, or sent anywhere other than the provider you choose.
      </div>

      {/* Provider selector */}
      <fieldset className="mt-4">
        <legend className="mb-2 text-xs font-medium text-neutral-400">Provider</legend>
        <div className="space-y-1">
          {(
            [
              {
                kind: 'off' as const,
                label: 'Off (default)',
                desc: 'No AI, no network. All assistant features are disabled.',
              },
              {
                kind: 'local' as const,
                label: 'Local (Ollama / llama.cpp)',
                desc: 'Calls a localhost OpenAI-compatible endpoint. Notes never leave your machine.',
              },
              {
                kind: 'byok' as const,
                label: 'Bring your own key',
                desc: 'Send requests to your own Anthropic or OpenAI-compatible account.',
              },
            ] satisfies { kind: AISettings['kind']; label: string; desc: string }[]
          ).map(({ kind, label, desc }) => (
            <label
              key={kind}
              className={[
                'flex cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                settings.kind === kind
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200',
              ].join(' ')}
            >
              <input
                type="radio"
                name="ai-provider-kind"
                value={kind}
                checked={settings.kind === kind}
                onChange={() => handleKindChange(kind)}
                className="mt-0.5 accent-sky-500"
              />
              <span>
                <span className="font-medium">{label}</span>
                <span className="ml-1 text-xs text-neutral-500"> — {desc}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* Local config */}
      {settings.kind === 'local' && (
        <div className="mt-4 space-y-3">
          <div>
            <label
              className="mb-1 block text-xs font-medium text-neutral-400"
              htmlFor="ai-local-ep"
            >
              Endpoint
            </label>
            <input
              id="ai-local-ep"
              type="url"
              value={settings.localEndpoint}
              onChange={(e) => update({ localEndpoint: e.target.value })}
              placeholder="http://localhost:11434/v1"
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500"
            />
            <p className="mt-1 text-xs text-neutral-600">
              Ollama default: <code className="text-neutral-500">http://localhost:11434/v1</code>
            </p>
          </div>
          <div>
            <label
              className="mb-1 block text-xs font-medium text-neutral-400"
              htmlFor="ai-local-model"
            >
              Model
            </label>
            <input
              id="ai-local-model"
              type="text"
              value={settings.localModel}
              onChange={(e) => update({ localModel: e.target.value })}
              placeholder="llama3"
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500"
            />
          </div>
        </div>
      )}

      {/* BYOK config */}
      {settings.kind === 'byok' && (
        <div className="mt-4 space-y-3">
          {/* Backend selector */}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-400">Backend</label>
            <div className="flex gap-3 text-sm">
              {[
                { backend: 'anthropic' as ByokBackend, label: 'Anthropic (Claude)' },
                { backend: 'openai-compatible' as ByokBackend, label: 'OpenAI-compatible' },
              ].map(({ backend, label }) => (
                <label
                  key={backend}
                  className="flex cursor-pointer items-center gap-1.5 text-neutral-300"
                >
                  <input
                    type="radio"
                    name="byok-backend"
                    value={backend}
                    checked={settings.byokBackend === backend}
                    onChange={() => handleByokBackendChange(backend)}
                    className="accent-sky-500"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {/* API key */}
          <div>
            <label
              className="mb-1 block text-xs font-medium text-neutral-400"
              htmlFor="ai-byok-key"
            >
              API key
            </label>
            <div className="flex gap-2">
              <input
                id="ai-byok-key"
                type={showKey ? 'text' : 'password'}
                value={settings.byokKey}
                onChange={(e) => update({ byokKey: e.target.value })}
                autoComplete="off"
                spellCheck={false}
                placeholder={settings.byokBackend === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-neutral-400 hover:text-neutral-200"
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <p className="mt-1 text-xs text-neutral-600">
              Stored in sessionStorage only — cleared when the tab closes. Never logged.
            </p>
          </div>

          {/* Endpoint (OpenAI-compatible only) */}
          {settings.byokBackend === 'openai-compatible' && (
            <div>
              <label
                className="mb-1 block text-xs font-medium text-neutral-400"
                htmlFor="ai-byok-ep"
              >
                Endpoint
              </label>
              <input
                id="ai-byok-ep"
                type="url"
                value={settings.byokEndpoint}
                onChange={(e) => update({ byokEndpoint: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500"
              />
            </div>
          )}

          {/* Model */}
          <div>
            <label
              className="mb-1 block text-xs font-medium text-neutral-400"
              htmlFor="ai-byok-model"
            >
              Model
            </label>
            <input
              id="ai-byok-model"
              type="text"
              value={settings.byokModel}
              onChange={(e) => update({ byokModel: e.target.value })}
              placeholder={
                settings.byokBackend === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini'
              }
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500"
            />
            {settings.byokBackend === 'anthropic' && (
              <p className="mt-1 text-xs text-neutral-600">
                Default: <code className="text-neutral-500">claude-sonnet-4-6</code>. Any model your
                API key has access to works.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Status pill */}
      <div className="mt-4">
        <span
          className={[
            'inline-block rounded px-2 py-0.5 text-xs font-medium',
            settings.kind === 'off'
              ? 'bg-neutral-800 text-neutral-500'
              : settings.kind === 'local'
                ? 'bg-emerald-950 text-emerald-300'
                : 'bg-sky-950 text-sky-300',
          ].join(' ')}
        >
          {settings.kind === 'off'
            ? 'AI is off — no network calls will be made'
            : settings.kind === 'local'
              ? 'Local inference — notes stay on-device'
              : 'Cloud key — notes sent to your provider'}
        </span>
      </div>
    </section>
  );
}
