'use client';

/**
 * Settings: configure the sync server URL and inspect / reset the local vault.
 * The server URL is persisted (Settings overrides the env default) and used by
 * the API client and the sync-status health check.
 *
 * New sections (M8 / security milestone):
 *  - Storage location: active adapter + switch to File System Access API.
 *  - Vault encryption: enable/disable AES-256-GCM at-rest encryption.
 *
 * New section (M22 / connectors):
 *  - Connectors: privacy-graded opt-in import connectors (phase 1: local only).
 *
 * New section (M20 / importers):
 *  - Import from another app: one-click importers for Obsidian, Notion,
 *    Logseq/Roam, and a generic fallback. All client-side, collision-safe.
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
  s3Adapter,
  webdavAdapter,
  azureAdapter,
  gcsAdapter,
} from '../../lib/vault/store';
import { migrateAdapter } from '../../lib/vault/encryption/migrationHelper';
import { exportToDirectory, isDirectoryExportSupported } from '../../lib/vault/exportToDirectory';
import { useAISettings } from '../../components/assistant/useAISettings';
import type { AISettings } from '../../lib/ai/types';
import { buildBudgetMeter } from '../../lib/ai/budget';
import type { AiConfigInfo } from '@graphvault/shared';
import { LOCAL_IMPORT_CONNECTORS } from '../../lib/connectors/registry';
import { emailConnector } from '../../lib/connectors/email';
import { rssOpmlConnector } from '../../lib/connectors/rssOpml';
import {
  PRIVACY_POSTURE_COLORS,
  PRIVACY_POSTURE_LABELS,
  ConnectorError,
} from '../../lib/connectors/types';
import type { LocalImportConnector } from '../../lib/connectors/types';
import { ALL_IMPORTERS, ImporterError, type Importer } from '../../lib/importers';
import { isValid, validateFields, type FieldErrors } from '../../lib/settings/validation';

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

/**
 * Inline validation error rendered beneath a form field. Announced to screen
 * readers (role="alert") and referenced from the input via `aria-describedby`
 * / `aria-invalid` by the caller.
 */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-400">
      {message}
    </p>
  );
}

export default function SettingsPage() {
  const { serverUrl, setServerUrl, loaded } = useServerSettings();
  const vault = useVaultContext();
  const auth = useAuth();
  const [draftUrl, setDraftUrl] = useState('');
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<string | null>(null);
  const [urlError, setUrlError] = useState('');

  useEffect(() => {
    if (loaded) setDraftUrl(serverUrl);
  }, [loaded, serverUrl]);

  const save = () => {
    // A blank URL clears the override back to the env default; only a non-empty
    // value must be a well-formed http(s) URL.
    const errors = validateFields({
      serverUrl: { value: draftUrl, url: true, label: 'Server URL' },
    });
    if (!isValid(errors)) {
      setUrlError(errors.serverUrl);
      return;
    }
    setUrlError('');
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
            aria-invalid={Boolean(urlError)}
            aria-describedby={urlError ? 'sync-url-error' : undefined}
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
        <FieldError id="sync-url-error" message={urlError} />
        <div className="mt-2 h-4 text-xs" role="status" aria-live="polite">
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

      {/* ------------------------------------------------------------------ */}
      {/* WebDAV storage (M18)                                                */}
      {/* ------------------------------------------------------------------ */}
      <WebDavSection auth={auth} serverUrl={serverUrl} />

      {/* ------------------------------------------------------------------ */}
      {/* S3-compatible storage (M18)                                         */}
      {/* ------------------------------------------------------------------ */}
      <S3Section auth={auth} serverUrl={serverUrl} />

      {/* ------------------------------------------------------------------ */}
      {/* Azure Blob Storage (M18)                                            */}
      {/* ------------------------------------------------------------------ */}
      <AzureSection auth={auth} serverUrl={serverUrl} />

      {/* ------------------------------------------------------------------ */}
      {/* Google Cloud Storage (M18)                                          */}
      {/* ------------------------------------------------------------------ */}
      <GcsSection auth={auth} serverUrl={serverUrl} />

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
        <div className="mt-2 min-h-4 text-xs" role="status" aria-live="polite">
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

      {/* ------------------------------------------------------------------ */}
      {/* Connectors (M22)                                                    */}
      {/* ------------------------------------------------------------------ */}
      <ConnectorsSection vault={vault} auth={auth} serverUrl={serverUrl} />

      {/* ------------------------------------------------------------------ */}
      {/* App importers (M20)                                                 */}
      {/* ------------------------------------------------------------------ */}
      <AppImporterSection vault={vault} />

      <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5 text-xs text-neutral-500">
        <h2 className="text-sm font-semibold text-neutral-200">Privacy</h2>
        <p className="mt-2">
          No telemetry. The app only contacts the sync server URL you configure above, the AI
          provider you explicitly enable (if any), and no third-party URLs in the browser —
          connectors in phase 1 are 100% client-side (user-provided content only).
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
  // True when a folder was selected in a previous session (persisted handle in
  // IndexedDB) but it is not currently reconnected — so we surface a banner
  // prompting the user to re-grant access rather than silently writing edits to
  // localStorage and looking like data loss.
  const [folderDisconnected, setFolderDisconnected] = useState(false);

  const fsApiAvailable = FileSystemAdapter.isApiAvailable();
  const adapters = listAdapters();
  const vault = useVaultContext();

  // On mount, try to silently reconnect a previously-selected folder (only
  // succeeds when permission is still granted). If a handle is persisted but we
  // can't reconnect silently, flag it so the banner appears.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!FileSystemAdapter.isApiAvailable()) return;
      try {
        const restored = await FileSystemAdapter.restore(false);
        if (cancelled) return;
        if (restored && restored.directory) {
          fileSystemAdapter.setDirectory(
            restored.directory as Parameters<typeof fileSystemAdapter.setDirectory>[0],
          );
          setActiveId('fileSystem');
          setFolderDisconnected(false);
        } else if (await FileSystemAdapter.hasPersistedHandle()) {
          if (!cancelled) setFolderDisconnected(true);
        }
      } catch {
        /* best-effort reconnect — ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-grant access to the persisted folder. Must run from a click (user
  // gesture) so requestPermission can prompt.
  const reconnectFolder = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const restored = await FileSystemAdapter.restore(true);
      if (restored && restored.directory) {
        fileSystemAdapter.setDirectory(
          restored.directory as Parameters<typeof fileSystemAdapter.setDirectory>[0],
        );
        setActiveId('fileSystem');
        setFolderDisconnected(false);
        setMsg({ kind: 'ok', text: 'Reconnected to your folder.' });
        await vault.resetVault();
      } else {
        setMsg({
          kind: 'err',
          text: 'Could not reconnect. Pick the folder again to restore access.',
        });
      }
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to reconnect to the folder.',
      });
    } finally {
      setBusy(false);
    }
  };

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
      setFolderDisconnected(false);
      setMsg({
        kind: 'ok',
        text: `Moved ${result.noteCount} note${result.noteCount !== 1 ? 's' : ''} to "${result.to}". Source (${result.from}) preserved as backup — clear it manually when satisfied.`,
      });

      // Reload vault notes from the new adapter (non-destructive — the source
      // adapter's notes are preserved as promised by the migration).
      await vault.reload();
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
    // Forget the persisted handle so we don't show the reconnect banner after
    // the user has deliberately chosen browser storage.
    void FileSystemAdapter.forgetPersistedHandle();
    setFolderDisconnected(false);
    // Also deactivate WebDAV if it was active.
    setActiveId('localStorage');
    setMsg({ kind: 'ok', text: 'Switched back to browser storage (localStorage).' });
    // Non-destructively surface the localStorage adapter's notes (previously
    // this skipped reload entirely, leaving stale notes from the old backend).
    void vault.reload();
  };

  const switchToWebDav = async () => {
    setMsg(null);
    setBusy(true);
    try {
      // Verify the WebDAV adapter is available (i.e., user is signed in).
      if (!webdavAdapter.isAvailable()) {
        setMsg({
          kind: 'err',
          text: 'Sign in to your GraphVault server first, then configure WebDAV below.',
        });
        return;
      }
      // Migrate notes: copy → verify → activate (copy-verify-switch pattern).
      const source = getActiveAdapter();
      const result = await migrateAdapter(source, webdavAdapter);
      setActiveId('webdav');
      setMsg({
        kind: 'ok',
        text: `Migrated ${result.noteCount} note${result.noteCount !== 1 ? 's' : ''} to WebDAV. Source (${result.from}) preserved — clear it manually when satisfied.`,
      });
      await vault.reload();
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to switch to WebDAV storage.',
      });
    } finally {
      setBusy(false);
    }
  };

  const switchToS3 = async () => {
    setMsg(null);
    setBusy(true);
    try {
      if (!s3Adapter.isAvailable()) {
        setMsg({
          kind: 'err',
          text: 'Sign in to your GraphVault server first, then configure S3 storage below.',
        });
        return;
      }
      // Migrate notes: copy → verify → activate (copy-verify-switch pattern).
      const source = getActiveAdapter();
      const result = await migrateAdapter(source, s3Adapter);
      setActiveId('s3');
      setMsg({
        kind: 'ok',
        text: `Migrated ${result.noteCount} note${result.noteCount !== 1 ? 's' : ''} to S3. Source (${result.from}) preserved — clear it manually when satisfied.`,
      });
      await vault.reload();
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to switch to S3 storage.',
      });
    } finally {
      setBusy(false);
    }
  };

  const switchToAzure = async () => {
    setMsg(null);
    setBusy(true);
    try {
      if (!azureAdapter.isAvailable()) {
        setMsg({
          kind: 'err',
          text: 'Sign in to your GraphVault server first, then configure Azure Blob Storage below.',
        });
        return;
      }
      // Migrate notes: copy → verify → activate (copy-verify-switch pattern).
      const source = getActiveAdapter();
      const result = await migrateAdapter(source, azureAdapter);
      setActiveId('azure');
      setMsg({
        kind: 'ok',
        text: `Migrated ${result.noteCount} note${result.noteCount !== 1 ? 's' : ''} to Azure Blob Storage. Source (${result.from}) preserved — clear it manually when satisfied.`,
      });
      await vault.reload();
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to switch to Azure Blob Storage.',
      });
    } finally {
      setBusy(false);
    }
  };

  const switchToGcs = async () => {
    setMsg(null);
    setBusy(true);
    try {
      if (!gcsAdapter.isAvailable()) {
        setMsg({
          kind: 'err',
          text: 'Sign in to your GraphVault server first, then configure Google Cloud Storage below.',
        });
        return;
      }
      // Migrate notes: copy → verify → activate (copy-verify-switch pattern).
      const source = getActiveAdapter();
      const result = await migrateAdapter(source, gcsAdapter);
      setActiveId('gcs');
      setMsg({
        kind: 'ok',
        text: `Migrated ${result.noteCount} note${result.noteCount !== 1 ? 's' : ''} to Google Cloud Storage. Source (${result.from}) preserved — clear it manually when satisfied.`,
      });
      await vault.reload();
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to switch to Google Cloud Storage.',
      });
    } finally {
      setBusy(false);
    }
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

      {/* Folder-disconnected banner: a folder was selected previously but the
          browser hasn't re-granted access this session. Without this the app
          would silently fall back to localStorage and look like data loss. */}
      {folderDisconnected && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-amber-700/60 bg-amber-950/30 p-3 text-xs text-amber-200"
        >
          <strong>Your local folder is disconnected.</strong> You previously chose a folder on disk,
          but this browser session hasn&apos;t re-granted access. Until you reconnect, edits are
          written to browser storage — not your folder.
          <div className="mt-2">
            <button
              type="button"
              onClick={() => void reconnectFolder()}
              disabled={busy}
              className="rounded-md border border-amber-600/70 bg-amber-900/40 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-800/50 disabled:opacity-40"
            >
              {busy ? 'Reconnecting…' : 'Reconnect folder'}
            </button>
          </div>
        </div>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
        <dt>Active backend</dt>
        <dd className="text-neutral-200">{activeLabel}</dd>
      </dl>

      <div className="mt-3 flex flex-wrap gap-2">
        {/* WebDAV option — requires sign-in + server WebDAV config */}
        <button
          type="button"
          disabled={activeId === 'webdav' || busy}
          onClick={() => void switchToWebDav()}
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          title="Store notes on your WebDAV server (Nextcloud / ownCloud). Configure below."
        >
          {busy && activeId !== 'webdav' ? 'Migrating…' : 'Use WebDAV (server)'}
        </button>

        {/* S3 option — requires sign-in + server S3 config */}
        <button
          type="button"
          disabled={activeId === 's3' || busy}
          onClick={() => void switchToS3()}
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          title="Store notes in S3-compatible storage (AWS S3, MinIO, R2, B2). Configure below."
        >
          {busy && activeId !== 's3' ? 'Migrating…' : 'Use S3 storage (server)'}
        </button>

        {/* Azure option — requires sign-in + server Azure config */}
        <button
          type="button"
          disabled={activeId === 'azure' || busy}
          onClick={() => void switchToAzure()}
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          title="Store notes in Azure Blob Storage. Configure below."
        >
          {busy && activeId !== 'azure' ? 'Migrating…' : 'Use Azure Blob (server)'}
        </button>

        {/* GCS option — requires sign-in + server GCS config */}
        <button
          type="button"
          disabled={activeId === 'gcs' || busy}
          onClick={() => void switchToGcs()}
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          title="Store notes in Google Cloud Storage. Configure below."
        >
          {busy && activeId !== 'gcs' ? 'Migrating…' : 'Use Google Cloud Storage (server)'}
        </button>

        {fsApiAvailable ? (
          <>
            <button
              type="button"
              disabled={activeId === 'fileSystem' || busy}
              onClick={() => void switchToFileSystem()}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            >
              {busy && activeId !== 'fileSystem' ? 'Migrating…' : 'Use local folder (File System)'}
            </button>
          </>
        ) : null}

        <button
          type="button"
          disabled={activeId === 'localStorage' || busy}
          onClick={switchToLocalStorage}
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
        >
          Use browser storage
        </button>

        {!fsApiAvailable && (
          <p className="mt-1 w-full text-xs text-neutral-600">
            File System Access API is not available in this browser (requires Chrome / Edge 86+).
          </p>
        )}
      </div>

      <div className="mt-2 min-h-4 text-xs" role="status" aria-live="polite">
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
// WebDAV section (M18)
// ---------------------------------------------------------------------------

/**
 * WebDAV configuration section.
 *
 * Shows:
 *   1. Current config status (URL + username, never password).
 *   2. A form to set/update credentials (only shown when signed in).
 *   3. A delete button to remove the config.
 *   4. A clear note that credentials live on the server, not in the browser.
 *
 * The form sends credentials to the server over TLS; they are encrypted at
 * rest on the server. The client never stores or retrieves the WebDAV password.
 */
function WebDavSection({
  auth,
  serverUrl,
}: {
  auth: ReturnType<typeof useAuth>;
  serverUrl: string;
}) {
  const [configInfo, setConfigInfo] = useState<{
    url: string;
    username: string;
    updatedAt: string;
  } | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const didLoad = useRef(false);

  const fetchConfig = useCallback(async () => {
    if (!auth.token) return;
    setLoadingConfig(true);
    setMsg(null);
    try {
      const client = new GraphVaultClient(serverUrl, auth.token);
      const info = await client.getWebDavConfig();
      setConfigInfo(info);
    } catch {
      setConfigInfo(null);
    } finally {
      setLoadingConfig(false);
    }
  }, [auth.token, serverUrl]);

  useEffect(() => {
    if (!didLoad.current && auth.isSignedIn && auth.token) {
      didLoad.current = true;
      void fetchConfig();
    }
  }, [auth.isSignedIn, auth.token, fetchConfig]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.token) return;
    const fieldErrors = validateFields({
      url: { value: url, required: true, url: true, label: 'WebDAV URL' },
      username: { value: username, required: true, label: 'Username' },
      password: { value: password, required: true, label: 'Password' },
    });
    setErrors(fieldErrors);
    if (!isValid(fieldErrors)) {
      setMsg({ kind: 'err', text: 'Please fix the highlighted fields.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const client = new GraphVaultClient(serverUrl, auth.token);
      await client.saveWebDavConfig({ url, username, password });
      setMsg({
        kind: 'ok',
        text: 'WebDAV configuration saved. Credentials are stored encrypted on the server.',
      });
      setShowForm(false);
      setPassword('');
      await fetchConfig();
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to save WebDAV config.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!auth.token) return;
    if (!window.confirm('Remove WebDAV configuration? Notes stored on WebDAV will not be deleted.'))
      return;
    setBusy(true);
    setMsg(null);
    try {
      const client = new GraphVaultClient(serverUrl, auth.token);
      await client.deleteWebDavConfig();
      setConfigInfo(null);
      setMsg({ kind: 'ok', text: 'WebDAV configuration removed.' });
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to remove config.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-200">WebDAV storage</h2>
        {auth.isSignedIn && (
          <button
            type="button"
            onClick={() => void fetchConfig()}
            disabled={loadingConfig}
            className="text-xs text-neutral-500 hover:text-neutral-300 disabled:opacity-50"
          >
            {loadingConfig ? 'Loading…' : 'Refresh'}
          </button>
        )}
      </div>

      <p className="mt-1 text-xs text-neutral-500">
        Store your vault on a WebDAV server (Nextcloud, ownCloud, or any WebDAV-compatible host).
        The browser talks only to your GraphVault server, which proxies to WebDAV — no CORS issues,
        and your WebDAV credentials never leave the server.
      </p>

      {/* Security notice */}
      <div className="mt-3 rounded-md border border-sky-900/40 bg-sky-950/20 p-3 text-xs text-sky-300">
        <strong>Credentials stay on the server.</strong> Your WebDAV URL and password are encrypted
        at rest on your GraphVault server and are never sent to the browser. The client uses only
        its normal GraphVault bearer token to proxy through.
      </div>

      {!auth.isSignedIn ? (
        <p className="mt-3 text-xs text-neutral-500">
          Sign in to your GraphVault server (Account section above) to configure WebDAV.
        </p>
      ) : (
        <>
          {/* Current config display */}
          {configInfo ? (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
              <dt>Status</dt>
              <dd className="text-emerald-400">Configured</dd>
              <dt>WebDAV URL</dt>
              <dd className="truncate text-neutral-200">{configInfo.url}</dd>
              <dt>Username</dt>
              <dd className="text-neutral-200">{configInfo.username}</dd>
              <dt>Password</dt>
              <dd className="text-neutral-600 italic">stored encrypted on server</dd>
              <dt>Last updated</dt>
              <dd className="text-neutral-200">
                {new Date(configInfo.updatedAt).toLocaleString()}
              </dd>
            </dl>
          ) : (
            <p className="mt-3 text-xs text-neutral-500">
              No WebDAV backend configured yet. Add one below.
            </p>
          )}

          {/* Action buttons */}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setShowForm((s) => !s);
                setMsg(null);
                if (configInfo) {
                  setUrl(configInfo.url);
                  setUsername(configInfo.username);
                  setPassword('');
                }
              }}
              disabled={busy}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            >
              {configInfo ? 'Update WebDAV config' : 'Configure WebDAV'}
            </button>
            {configInfo && (
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy}
                className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/60 disabled:opacity-40"
              >
                Remove config
              </button>
            )}
          </div>

          {/* Config form */}
          {showForm && (
            <form onSubmit={(e) => void handleSave(e)} className="mt-4 space-y-3" noValidate>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="dav-url"
                >
                  WebDAV URL
                </label>
                <input
                  id="dav-url"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={busy}
                  aria-invalid={Boolean(errors.url)}
                  aria-describedby={errors.url ? 'dav-url-error' : undefined}
                  placeholder="https://cloud.example.com/remote.php/dav/files/alice/"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
                <FieldError id="dav-url-error" message={errors.url} />
                <p className="mt-1 text-xs text-neutral-600">
                  Nextcloud:{' '}
                  <code className="text-neutral-500">
                    https://your-cloud/remote.php/dav/files/username/
                  </code>
                </p>
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="dav-user"
                >
                  Username
                </label>
                <input
                  id="dav-user"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={busy}
                  placeholder="your WebDAV username"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="dav-pass"
                >
                  Password / App password
                </label>
                <input
                  id="dav-pass"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  placeholder={
                    configInfo
                      ? 'Enter new password to update…'
                      : 'Your WebDAV password or app password'
                  }
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
                <p className="mt-1 text-xs text-neutral-600">
                  Tip: use an app password (Nextcloud: Settings → Security → App passwords). The
                  password is sent to your server over TLS and stored encrypted — it is never
                  returned to the browser.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={busy || !url || !username || !password}
                  className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
                >
                  {busy ? 'Saving…' : 'Save WebDAV config'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    setPassword('');
                    setMsg(null);
                  }}
                  disabled={busy}
                  className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <div className="mt-2 min-h-4 text-xs" role="status" aria-live="polite">
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// S3-compatible storage section (M18)
// ---------------------------------------------------------------------------

/**
 * S3-compatible storage configuration section.
 *
 * Shows:
 *   1. Current config status (endpoint, region, bucket, accessKeyId — never the secret key).
 *   2. A form to set/update credentials (only shown when signed in).
 *   3. A delete button to remove the config.
 *   4. A clear note that credentials live on the server, not in the browser.
 *
 * The form sends the secretAccessKey to the server over TLS; it is encrypted at
 * rest. The client never stores or retrieves the secret key.
 */
function S3Section({ auth, serverUrl }: { auth: ReturnType<typeof useAuth>; serverUrl: string }) {
  const [configInfo, setConfigInfo] = useState<{
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    prefix?: string;
    updatedAt: string;
  } | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('');
  const [bucket, setBucket] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const didLoad = useRef(false);

  const fetchConfig = useCallback(async () => {
    if (!auth.token) return;
    setLoadingConfig(true);
    setMsg(null);
    try {
      const client = new GraphVaultClient(serverUrl, auth.token);
      const info = await client.getS3Config();
      setConfigInfo(info);
    } catch {
      setConfigInfo(null);
    } finally {
      setLoadingConfig(false);
    }
  }, [auth.token, serverUrl]);

  useEffect(() => {
    if (!didLoad.current && auth.isSignedIn && auth.token) {
      didLoad.current = true;
      void fetchConfig();
    }
  }, [auth.isSignedIn, auth.token, fetchConfig]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.token) return;
    const fieldErrors = validateFields({
      endpoint: { value: endpoint, url: true, label: 'Endpoint URL' },
      region: { value: region, required: true, label: 'Region' },
      bucket: { value: bucket, required: true, label: 'Bucket name' },
      accessKeyId: { value: accessKeyId, required: true, label: 'Access key ID' },
      secretAccessKey: { value: secretAccessKey, required: true, label: 'Secret access key' },
      prefix: { value: prefix, endsWithSlash: true, label: 'Key prefix' },
    });
    setErrors(fieldErrors);
    if (!isValid(fieldErrors)) {
      setMsg({ kind: 'err', text: 'Please fix the highlighted fields.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const client = new GraphVaultClient(serverUrl, auth.token);
      await client.saveS3Config({
        endpoint: endpoint.trim() || undefined,
        region: region.trim(),
        bucket: bucket.trim(),
        accessKeyId: accessKeyId.trim(),
        secretAccessKey,
        prefix: prefix.trim() || undefined,
      });
      setMsg({
        kind: 'ok',
        text: 'S3 configuration saved. Credentials are stored encrypted on the server.',
      });
      setShowForm(false);
      setSecretAccessKey('');
      await fetchConfig();
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to save S3 config.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!auth.token) return;
    if (!window.confirm('Remove S3 configuration? Notes stored in S3 will not be deleted.')) return;
    setBusy(true);
    setMsg(null);
    try {
      const client = new GraphVaultClient(serverUrl, auth.token);
      await client.deleteS3Config();
      setConfigInfo(null);
      setMsg({ kind: 'ok', text: 'S3 configuration removed.' });
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to remove config.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-200">S3-compatible storage</h2>
        {auth.isSignedIn && (
          <button
            type="button"
            onClick={() => void fetchConfig()}
            disabled={loadingConfig}
            className="text-xs text-neutral-500 hover:text-neutral-300 disabled:opacity-50"
          >
            {loadingConfig ? 'Loading…' : 'Refresh'}
          </button>
        )}
      </div>

      <p className="mt-1 text-xs text-neutral-500">
        Store your vault in an S3-compatible bucket (AWS S3, MinIO, Cloudflare R2, Backblaze B2, …).
        The browser talks only to your GraphVault server, which proxies to S3 and signs requests
        using AWS SigV4 — your credentials and secret key never leave the server.
      </p>

      {/* Security notice */}
      <div className="mt-3 rounded-md border border-sky-900/40 bg-sky-950/20 p-3 text-xs text-sky-300">
        <strong>Credentials stay on the server.</strong> Your S3 access key and secret are encrypted
        at rest on your GraphVault server using AES-256-GCM. AWS SigV4 request signing happens
        server-side — the browser handles only its normal GraphVault bearer token.
      </div>

      {!auth.isSignedIn ? (
        <p className="mt-3 text-xs text-neutral-500">
          Sign in to your GraphVault server (Account section above) to configure S3 storage.
        </p>
      ) : (
        <>
          {/* Current config display */}
          {configInfo ? (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
              <dt>Status</dt>
              <dd className="text-emerald-400">Configured</dd>
              {configInfo.endpoint && (
                <>
                  <dt>Endpoint</dt>
                  <dd className="truncate text-neutral-200">{configInfo.endpoint}</dd>
                </>
              )}
              <dt>Region</dt>
              <dd className="text-neutral-200">{configInfo.region}</dd>
              <dt>Bucket</dt>
              <dd className="text-neutral-200">{configInfo.bucket}</dd>
              <dt>Access key ID</dt>
              <dd className="truncate text-neutral-200">{configInfo.accessKeyId}</dd>
              <dt>Secret access key</dt>
              <dd className="text-neutral-600 italic">stored encrypted on server</dd>
              {configInfo.prefix && (
                <>
                  <dt>Key prefix</dt>
                  <dd className="text-neutral-200">{configInfo.prefix}</dd>
                </>
              )}
              <dt>Last updated</dt>
              <dd className="text-neutral-200">
                {new Date(configInfo.updatedAt).toLocaleString()}
              </dd>
            </dl>
          ) : (
            <p className="mt-3 text-xs text-neutral-500">
              No S3 backend configured yet. Add one below.
            </p>
          )}

          {/* Action buttons */}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setShowForm((s) => !s);
                setMsg(null);
                if (configInfo) {
                  setEndpoint(configInfo.endpoint ?? '');
                  setRegion(configInfo.region);
                  setBucket(configInfo.bucket);
                  setAccessKeyId(configInfo.accessKeyId);
                  setPrefix(configInfo.prefix ?? '');
                  setSecretAccessKey('');
                }
              }}
              disabled={busy}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            >
              {configInfo ? 'Update S3 config' : 'Configure S3'}
            </button>
            {configInfo && (
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy}
                className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/60 disabled:opacity-40"
              >
                Remove config
              </button>
            )}
          </div>

          {/* Config form */}
          {showForm && (
            <form onSubmit={(e) => void handleSave(e)} className="mt-4 space-y-3" noValidate>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="s3-endpoint"
                >
                  Endpoint URL <span className="text-neutral-600">(leave blank for AWS S3)</span>
                </label>
                <input
                  id="s3-endpoint"
                  type="url"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  disabled={busy}
                  aria-invalid={Boolean(errors.endpoint)}
                  aria-describedby={errors.endpoint ? 's3-endpoint-error' : undefined}
                  placeholder="https://account-id.r2.cloudflarestorage.com"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
                <FieldError id="s3-endpoint-error" message={errors.endpoint} />
                <p className="mt-1 text-xs text-neutral-600">
                  MinIO: <code className="text-neutral-500">http://minio.local:9000</code>
                  {' · '}Cloudflare R2:{' '}
                  <code className="text-neutral-500">
                    https://&lt;account-id&gt;.r2.cloudflarestorage.com
                  </code>
                </p>
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="s3-region"
                >
                  Region
                </label>
                <input
                  id="s3-region"
                  type="text"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  disabled={busy}
                  placeholder="us-east-1"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
                <p className="mt-1 text-xs text-neutral-600">
                  R2: <code className="text-neutral-500">auto</code>
                  {' · '}B2: <code className="text-neutral-500">us-east-005</code> (check your B2
                  bucket)
                </p>
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="s3-bucket"
                >
                  Bucket name
                </label>
                <input
                  id="s3-bucket"
                  type="text"
                  value={bucket}
                  onChange={(e) => setBucket(e.target.value)}
                  disabled={busy}
                  placeholder="my-graphvault-bucket"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="s3-akid"
                >
                  Access key ID
                </label>
                <input
                  id="s3-akid"
                  type="text"
                  autoComplete="username"
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                  disabled={busy}
                  placeholder="AKIAIOSFODNN7EXAMPLE"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="s3-secret"
                >
                  Secret access key
                </label>
                <input
                  id="s3-secret"
                  type="password"
                  autoComplete="new-password"
                  value={secretAccessKey}
                  onChange={(e) => setSecretAccessKey(e.target.value)}
                  disabled={busy}
                  placeholder={
                    configInfo ? 'Enter new secret key to update…' : 'Your S3 secret access key'
                  }
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
                <p className="mt-1 text-xs text-neutral-600">
                  Sent to your server over TLS and stored encrypted — never returned to the browser.
                </p>
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="s3-prefix"
                >
                  Key prefix <span className="text-neutral-600">(optional, must end with /)</span>
                </label>
                <input
                  id="s3-prefix"
                  type="text"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  disabled={busy}
                  aria-invalid={Boolean(errors.prefix)}
                  aria-describedby={errors.prefix ? 's3-prefix-error' : undefined}
                  placeholder="graphvault/"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
                <FieldError id="s3-prefix-error" message={errors.prefix} />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={busy || !region || !bucket || !accessKeyId || !secretAccessKey}
                  className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
                >
                  {busy ? 'Saving…' : 'Save S3 config'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    setSecretAccessKey('');
                    setMsg(null);
                  }}
                  disabled={busy}
                  className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <div className="mt-2 min-h-4 text-xs" role="status" aria-live="polite">
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Azure / GCS config helpers (M18)
//
// These two providers were added server-side in Wave 16 with locally-defined
// schemas (not in @graphvault/shared), so the typed GraphVaultClient has no
// generated methods for them. We POST/GET/DELETE their config directly with a
// bearer-token fetch — mirroring the storage adapters, which proxy the same way.
// Secrets live only in the in-flight request body; nothing is stored in the
// browser.
// ---------------------------------------------------------------------------

function storageConfigBase(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/v1/storage`;
}

/** POST a provider config (secrets included) to the server over TLS. */
async function postStorageConfig(
  serverUrl: string,
  token: string,
  provider: 'azure' | 'gcs',
  body: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${storageConfigBase(serverUrl)}/${provider}/config`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: { message?: string } };
      if (data.error?.message) message = data.error.message;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
}

/** GET non-secret provider config info, or `null` when not configured (404). */
async function getStorageConfig<T>(
  serverUrl: string,
  token: string,
  provider: 'azure' | 'gcs',
): Promise<T | null> {
  const res = await fetch(`${storageConfigBase(serverUrl)}/${provider}/config`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

/** DELETE the provider config. */
async function deleteStorageConfig(
  serverUrl: string,
  token: string,
  provider: 'azure' | 'gcs',
): Promise<void> {
  const res = await fetch(`${storageConfigBase(serverUrl)}/${provider}/config`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Request failed (${res.status})`);
}

// ---------------------------------------------------------------------------
// Azure Blob Storage section (M18)
// ---------------------------------------------------------------------------

/** Non-secret Azure config info returned by GET /v1/storage/azure/config. */
interface AzureConfigInfo {
  account: string;
  container: string;
  endpoint?: string;
  updatedAt: string;
}

/**
 * Azure Blob Storage configuration section.
 *
 * Shows the current config status (account, container, endpoint — never the
 * account key), a form to set/update credentials, and a remove button. The
 * account key is sent to the server over TLS and stored encrypted at rest; it
 * is never returned to or stored by the browser.
 */
function AzureSection({
  auth,
  serverUrl,
}: {
  auth: ReturnType<typeof useAuth>;
  serverUrl: string;
}) {
  const [configInfo, setConfigInfo] = useState<AzureConfigInfo | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [account, setAccount] = useState('');
  const [container, setContainer] = useState('');
  const [accountKey, setAccountKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const didLoad = useRef(false);

  const fetchConfig = useCallback(async () => {
    if (!auth.token) return;
    setLoadingConfig(true);
    setMsg(null);
    try {
      const info = await getStorageConfig<AzureConfigInfo>(serverUrl, auth.token, 'azure');
      setConfigInfo(info);
    } catch {
      setConfigInfo(null);
    } finally {
      setLoadingConfig(false);
    }
  }, [auth.token, serverUrl]);

  useEffect(() => {
    if (!didLoad.current && auth.isSignedIn && auth.token) {
      didLoad.current = true;
      void fetchConfig();
    }
  }, [auth.isSignedIn, auth.token, fetchConfig]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.token) return;
    const fieldErrors = validateFields({
      account: { value: account, required: true, label: 'Storage account name' },
      container: { value: container, required: true, label: 'Container name' },
      accountKey: { value: accountKey, required: true, label: 'Account key' },
      endpoint: { value: endpoint, url: true, label: 'Endpoint URL' },
    });
    setErrors(fieldErrors);
    if (!isValid(fieldErrors)) {
      setMsg({ kind: 'err', text: 'Please fix the highlighted fields.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await postStorageConfig(serverUrl, auth.token, 'azure', {
        account: account.trim(),
        container: container.trim(),
        accountKey,
        endpoint: endpoint.trim() || undefined,
      });
      setMsg({
        kind: 'ok',
        text: 'Azure configuration saved. The account key is stored encrypted on the server.',
      });
      setShowForm(false);
      setAccountKey('');
      await fetchConfig();
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to save Azure config.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!auth.token) return;
    if (!window.confirm('Remove Azure configuration? Notes stored in Azure will not be deleted.'))
      return;
    setBusy(true);
    setMsg(null);
    try {
      await deleteStorageConfig(serverUrl, auth.token, 'azure');
      setConfigInfo(null);
      setMsg({ kind: 'ok', text: 'Azure configuration removed.' });
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to remove config.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-200">Azure Blob Storage</h2>
        {auth.isSignedIn && (
          <button
            type="button"
            onClick={() => void fetchConfig()}
            disabled={loadingConfig}
            className="text-xs text-neutral-500 hover:text-neutral-300 disabled:opacity-50"
          >
            {loadingConfig ? 'Loading…' : 'Refresh'}
          </button>
        )}
      </div>

      <p className="mt-1 text-xs text-neutral-500">
        Store your vault in an Azure Blob Storage container. The browser talks only to your
        GraphVault server, which proxies to Azure and signs requests server-side — your account key
        never leaves the server.
      </p>

      {/* Security notice */}
      <div className="mt-3 rounded-md border border-sky-900/40 bg-sky-950/20 p-3 text-xs text-sky-300">
        <strong>Credentials stay on the server.</strong> Your Azure account key is encrypted at rest
        on your GraphVault server using AES-256-GCM. Request signing happens server-side — the
        browser handles only its normal GraphVault bearer token.
      </div>

      {!auth.isSignedIn ? (
        <p className="mt-3 text-xs text-neutral-500">
          Sign in to your GraphVault server (Account section above) to configure Azure Blob Storage.
        </p>
      ) : (
        <>
          {/* Current config display */}
          {configInfo ? (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
              <dt>Status</dt>
              <dd className="text-emerald-400">Configured</dd>
              <dt>Account</dt>
              <dd className="truncate text-neutral-200">{configInfo.account}</dd>
              <dt>Container</dt>
              <dd className="text-neutral-200">{configInfo.container}</dd>
              {configInfo.endpoint && (
                <>
                  <dt>Endpoint</dt>
                  <dd className="truncate text-neutral-200">{configInfo.endpoint}</dd>
                </>
              )}
              <dt>Account key</dt>
              <dd className="text-neutral-600 italic">stored encrypted on server</dd>
              <dt>Last updated</dt>
              <dd className="text-neutral-200">
                {new Date(configInfo.updatedAt).toLocaleString()}
              </dd>
            </dl>
          ) : (
            <p className="mt-3 text-xs text-neutral-500">
              No Azure backend configured yet. Add one below.
            </p>
          )}

          {/* Action buttons */}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setShowForm((s) => !s);
                setMsg(null);
                if (configInfo) {
                  setAccount(configInfo.account);
                  setContainer(configInfo.container);
                  setEndpoint(configInfo.endpoint ?? '');
                  setAccountKey('');
                }
              }}
              disabled={busy}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            >
              {configInfo ? 'Update Azure config' : 'Configure Azure'}
            </button>
            {configInfo && (
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy}
                className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/60 disabled:opacity-40"
              >
                Remove config
              </button>
            )}
          </div>

          {/* Config form */}
          {showForm && (
            <form onSubmit={(e) => void handleSave(e)} className="mt-4 space-y-3" noValidate>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="azure-account"
                >
                  Storage account name
                </label>
                <input
                  id="azure-account"
                  type="text"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  disabled={busy}
                  placeholder="mystorageaccount"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="azure-container"
                >
                  Container name
                </label>
                <input
                  id="azure-container"
                  type="text"
                  value={container}
                  onChange={(e) => setContainer(e.target.value)}
                  disabled={busy}
                  placeholder="graphvault"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="azure-key"
                >
                  Account key
                </label>
                <input
                  id="azure-key"
                  type="password"
                  autoComplete="new-password"
                  value={accountKey}
                  onChange={(e) => setAccountKey(e.target.value)}
                  disabled={busy}
                  placeholder={
                    configInfo
                      ? 'Enter new account key to update…'
                      : 'Your Azure account key (base64)'
                  }
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
                <p className="mt-1 text-xs text-neutral-600">
                  Found under Storage account → Access keys (key1 or key2). Sent to your server over
                  TLS and stored encrypted — never returned to the browser.
                </p>
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="azure-endpoint"
                >
                  Endpoint URL{' '}
                  <span className="text-neutral-600">(optional, for Azurite / emulators)</span>
                </label>
                <input
                  id="azure-endpoint"
                  type="url"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  disabled={busy}
                  aria-invalid={Boolean(errors.endpoint)}
                  aria-describedby={errors.endpoint ? 'azure-endpoint-error' : undefined}
                  placeholder="http://127.0.0.1:10000/devstoreaccount1"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
                <FieldError id="azure-endpoint-error" message={errors.endpoint} />
                <p className="mt-1 text-xs text-neutral-600">
                  Leave blank for Azure (uses{' '}
                  <code className="text-neutral-500">
                    https://&lt;account&gt;.blob.core.windows.net
                  </code>
                  ).
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={busy || !account || !container || !accountKey}
                  className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
                >
                  {busy ? 'Saving…' : 'Save Azure config'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    setAccountKey('');
                    setMsg(null);
                  }}
                  disabled={busy}
                  className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <div className="mt-2 min-h-4 text-xs" role="status" aria-live="polite">
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Google Cloud Storage section (M18)
// ---------------------------------------------------------------------------

/** Non-secret GCS config info returned by GET /v1/storage/gcs/config. */
interface GcsConfigInfo {
  bucket: string;
  accessId: string;
  prefix?: string;
  updatedAt: string;
}

/**
 * Google Cloud Storage configuration section.
 *
 * Shows the current config status (bucket, HMAC access ID, prefix — never the
 * secret), a form to set/update credentials, and a remove button. The HMAC
 * interop secret is sent to the server over TLS and stored encrypted at rest;
 * it is never returned to or stored by the browser.
 */
function GcsSection({ auth, serverUrl }: { auth: ReturnType<typeof useAuth>; serverUrl: string }) {
  const [configInfo, setConfigInfo] = useState<GcsConfigInfo | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [bucket, setBucket] = useState('');
  const [accessId, setAccessId] = useState('');
  const [secret, setSecret] = useState('');
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const didLoad = useRef(false);

  const fetchConfig = useCallback(async () => {
    if (!auth.token) return;
    setLoadingConfig(true);
    setMsg(null);
    try {
      const info = await getStorageConfig<GcsConfigInfo>(serverUrl, auth.token, 'gcs');
      setConfigInfo(info);
    } catch {
      setConfigInfo(null);
    } finally {
      setLoadingConfig(false);
    }
  }, [auth.token, serverUrl]);

  useEffect(() => {
    if (!didLoad.current && auth.isSignedIn && auth.token) {
      didLoad.current = true;
      void fetchConfig();
    }
  }, [auth.isSignedIn, auth.token, fetchConfig]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.token) return;
    const fieldErrors = validateFields({
      bucket: { value: bucket, required: true, label: 'Bucket name' },
      accessId: { value: accessId, required: true, label: 'HMAC access ID' },
      secret: { value: secret, required: true, label: 'HMAC secret' },
      prefix: { value: prefix, endsWithSlash: true, label: 'Key prefix' },
    });
    setErrors(fieldErrors);
    if (!isValid(fieldErrors)) {
      setMsg({ kind: 'err', text: 'Please fix the highlighted fields.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await postStorageConfig(serverUrl, auth.token, 'gcs', {
        bucket: bucket.trim(),
        accessId: accessId.trim(),
        secret,
        prefix: prefix.trim() || undefined,
      });
      setMsg({
        kind: 'ok',
        text: 'GCS configuration saved. The HMAC secret is stored encrypted on the server.',
      });
      setShowForm(false);
      setSecret('');
      await fetchConfig();
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to save GCS config.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!auth.token) return;
    if (!window.confirm('Remove GCS configuration? Notes stored in GCS will not be deleted.'))
      return;
    setBusy(true);
    setMsg(null);
    try {
      await deleteStorageConfig(serverUrl, auth.token, 'gcs');
      setConfigInfo(null);
      setMsg({ kind: 'ok', text: 'GCS configuration removed.' });
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to remove config.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-200">Google Cloud Storage</h2>
        {auth.isSignedIn && (
          <button
            type="button"
            onClick={() => void fetchConfig()}
            disabled={loadingConfig}
            className="text-xs text-neutral-500 hover:text-neutral-300 disabled:opacity-50"
          >
            {loadingConfig ? 'Loading…' : 'Refresh'}
          </button>
        )}
      </div>

      <p className="mt-1 text-xs text-neutral-500">
        Store your vault in a Google Cloud Storage bucket via HMAC interop credentials. The browser
        talks only to your GraphVault server, which proxies to GCS and signs requests server-side —
        your HMAC secret never leaves the server.
      </p>

      {/* Security notice */}
      <div className="mt-3 rounded-md border border-sky-900/40 bg-sky-950/20 p-3 text-xs text-sky-300">
        <strong>Credentials stay on the server.</strong> Your GCS HMAC secret is encrypted at rest
        on your GraphVault server using AES-256-GCM. Request signing happens server-side — the
        browser handles only its normal GraphVault bearer token.
      </div>

      {!auth.isSignedIn ? (
        <p className="mt-3 text-xs text-neutral-500">
          Sign in to your GraphVault server (Account section above) to configure Google Cloud
          Storage.
        </p>
      ) : (
        <>
          {/* Current config display */}
          {configInfo ? (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
              <dt>Status</dt>
              <dd className="text-emerald-400">Configured</dd>
              <dt>Bucket</dt>
              <dd className="text-neutral-200">{configInfo.bucket}</dd>
              <dt>HMAC access ID</dt>
              <dd className="truncate text-neutral-200">{configInfo.accessId}</dd>
              <dt>HMAC secret</dt>
              <dd className="text-neutral-600 italic">stored encrypted on server</dd>
              {configInfo.prefix && (
                <>
                  <dt>Key prefix</dt>
                  <dd className="text-neutral-200">{configInfo.prefix}</dd>
                </>
              )}
              <dt>Last updated</dt>
              <dd className="text-neutral-200">
                {new Date(configInfo.updatedAt).toLocaleString()}
              </dd>
            </dl>
          ) : (
            <p className="mt-3 text-xs text-neutral-500">
              No GCS backend configured yet. Add one below.
            </p>
          )}

          {/* Action buttons */}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setShowForm((s) => !s);
                setMsg(null);
                if (configInfo) {
                  setBucket(configInfo.bucket);
                  setAccessId(configInfo.accessId);
                  setPrefix(configInfo.prefix ?? '');
                  setSecret('');
                }
              }}
              disabled={busy}
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            >
              {configInfo ? 'Update GCS config' : 'Configure GCS'}
            </button>
            {configInfo && (
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy}
                className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/60 disabled:opacity-40"
              >
                Remove config
              </button>
            )}
          </div>

          {/* Config form */}
          {showForm && (
            <form onSubmit={(e) => void handleSave(e)} className="mt-4 space-y-3" noValidate>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="gcs-bucket"
                >
                  Bucket name
                </label>
                <input
                  id="gcs-bucket"
                  type="text"
                  value={bucket}
                  onChange={(e) => setBucket(e.target.value)}
                  disabled={busy}
                  placeholder="my-graphvault-bucket"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="gcs-access-id"
                >
                  HMAC access ID
                </label>
                <input
                  id="gcs-access-id"
                  type="text"
                  autoComplete="username"
                  value={accessId}
                  onChange={(e) => setAccessId(e.target.value)}
                  disabled={busy}
                  placeholder="GOOG1EXAMPLE..."
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
                <p className="mt-1 text-xs text-neutral-600">
                  Create one under Cloud Storage → Settings → Interoperability → HMAC keys.
                </p>
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="gcs-secret"
                >
                  HMAC secret
                </label>
                <input
                  id="gcs-secret"
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  disabled={busy}
                  placeholder={configInfo ? 'Enter new secret to update…' : 'Your GCS HMAC secret'}
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
                <p className="mt-1 text-xs text-neutral-600">
                  Sent to your server over TLS and stored encrypted — never returned to the browser.
                </p>
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-400"
                  htmlFor="gcs-prefix"
                >
                  Key prefix <span className="text-neutral-600">(optional, must end with /)</span>
                </label>
                <input
                  id="gcs-prefix"
                  type="text"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  disabled={busy}
                  aria-invalid={Boolean(errors.prefix)}
                  aria-describedby={errors.prefix ? 'gcs-prefix-error' : undefined}
                  placeholder="graphvault/"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
                <FieldError id="gcs-prefix-error" message={errors.prefix} />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={busy || !bucket || !accessId || !secret}
                  className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
                >
                  {busy ? 'Saving…' : 'Save GCS config'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    setSecret('');
                    setMsg(null);
                  }}
                  disabled={busy}
                  className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <div className="mt-2 min-h-4 text-xs" role="status" aria-live="polite">
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
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

  // Encryption is only safe over the localStorage backend: EncryptedVaultStore
  // operates on a single serialised blob in localStorage, NOT through the active
  // storage adapter. Enabling it while a cloud/FS backend is active would write
  // ciphertext to localStorage while the cloud copy stays stale plaintext — a
  // split vault. So we offer "enable encryption" only when localStorage is the
  // active backend (matches the documented scope in EncryptedVaultStore.ts).
  // Disabling stays available regardless so an already-encrypted vault can
  // always be turned off.
  const activeAdapterId = (() => {
    try {
      return getActiveAdapter().id;
    } catch {
      return 'localStorage';
    }
  })();
  const encryptionSupported = activeAdapterId === 'localStorage';

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
          ) : encryptionSupported ? (
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
          ) : (
            <div className="rounded-md border border-neutral-800 bg-neutral-900/60 p-3 text-xs text-neutral-500">
              At-rest encryption is available only on the{' '}
              <strong className="text-neutral-400">browser storage (localStorage)</strong> backend.
              Your active backend is <strong className="text-neutral-400">{activeAdapterId}</strong>
              . Switch back to browser storage (Storage location, above) to enable encryption — this
              prevents writing encrypted data to one backend while another holds stale plaintext.
            </div>
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

      <div className="mt-2 min-h-4 text-xs" role="status" aria-live="polite">
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

/**
 * AI assistant section with three modes:
 *  - Off (default): no AI, no network.
 *  - Local (Ollama): notes never leave the machine.
 *  - Server (BYO-key via server proxy): API key stored on YOUR server encrypted
 *    at rest. The browser sends only the prompt — never the key.
 *
 * The key entry + save form for server mode mirrors the WebDAV / S3 pattern:
 *  - User enters the key in a form field (masked by default).
 *  - On submit the key is sent to POST /v1/ai/config over TLS.
 *  - The server encrypts it at rest with AES-256-GCM + per-user HKDF.
 *  - GET /v1/ai/config returns only a `keySet: boolean` — never the key value.
 *  - The key is cleared from the form on submit; it never lives in state longer
 *    than needed, and is never written to sessionStorage or localStorage.
 */
/**
 * Budget / spend meter for the AI server proxy. Renders the live spend window
 * (accrued $ + request count for the current UTC day) as a coloured progress
 * bar. Driven entirely by `spendCapState` from GET /v1/ai/config — the client
 * never computes spend itself.
 */
function BudgetMeter({
  state,
  spendCapUsd,
}: {
  state: NonNullable<AiConfigInfo['spendCapState']>;
  spendCapUsd: number | undefined;
}) {
  const meter = buildBudgetMeter(state, spendCapUsd);
  const barColor =
    meter.state === 'exceeded'
      ? 'bg-red-500'
      : meter.state === 'warning'
        ? 'bg-amber-500'
        : 'bg-emerald-500';
  const resetsAt = (() => {
    const d = new Date(state.windowResetsAt);
    return Number.isNaN(d.getTime()) ? state.windowResetsAt : d.toLocaleString();
  })();
  return (
    <div className="mt-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-neutral-300">Today&apos;s usage</span>
        <span
          className={[
            'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            meter.state === 'exceeded'
              ? 'bg-red-950 text-red-300'
              : meter.state === 'warning'
                ? 'bg-amber-950 text-amber-300'
                : 'bg-emerald-950 text-emerald-300',
          ].join(' ')}
        >
          {meter.state}
        </span>
      </div>
      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-800"
        role="progressbar"
        aria-valuenow={Math.round(meter.percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="AI daily spend budget used"
      >
        <div
          className={['h-full rounded-full transition-all', barColor].join(' ')}
          style={{ width: `${meter.percent}%` }}
        />
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-neutral-400">
        <dt>Spend</dt>
        <dd className="text-right text-neutral-200">{meter.spendLabel}</dd>
        <dt>Requests</dt>
        <dd className="text-right text-neutral-200">{meter.requestLabel}</dd>
      </dl>
      {meter.exhausted && (
        <p className="mt-2 text-xs text-red-300">
          Daily cap reached — further requests are refused until the window resets ({resetsAt}).
          Raise the cap above or wait for the reset.
        </p>
      )}
    </div>
  );
}

function AIAssistantSection() {
  const { settings, update } = useAISettings();
  const auth = useAuth();
  const { serverUrl } = useServerSettings();

  // --- server key management ---
  const [keyInput, setKeyInput] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [gateway, setGateway] = useState<'openrouter' | 'custom'>('openrouter');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [serverAiModel, setServerAiModel] = useState('');
  const [spendCapInput, setSpendCapInput] = useState('');
  const [dailyCapInput, setDailyCapInput] = useState('');
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyConfigInfo, setKeyConfigInfo] = useState<AiConfigInfo | null>(null);
  const [loadingKeyConfig, setLoadingKeyConfig] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyErrors, setKeyErrors] = useState<FieldErrors>({});
  const keyConfigLoaded = useRef(false);

  const fetchKeyConfig = useCallback(async () => {
    if (!auth.token) return;
    setLoadingKeyConfig(true);
    setKeyMsg(null);
    try {
      const { GraphVaultClient } = await import('../../lib/api/client');
      const client = new GraphVaultClient(serverUrl, auth.token);
      const info = await client.getAiConfig();
      setKeyConfigInfo(info);
    } catch {
      setKeyConfigInfo(null);
    } finally {
      setLoadingKeyConfig(false);
    }
  }, [auth.token, serverUrl]);

  useEffect(() => {
    if (!keyConfigLoaded.current && auth.isSignedIn && auth.token) {
      keyConfigLoaded.current = true;
      void fetchKeyConfig();
    }
  }, [auth.isSignedIn, auth.token, fetchKeyConfig]);

  const handleSaveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.token) return;
    if (!keyInput.trim()) {
      setKeyMsg({ kind: 'err', text: 'Please enter an API key.' });
      return;
    }
    // For the custom gateway the base URL is required and must be a valid
    // http(s) URL; OpenRouter uses a built-in endpoint, so no URL to check.
    if (gateway === 'custom') {
      const fieldErrors = validateFields({
        customBaseUrl: { value: customBaseUrl, required: true, url: true, label: 'Base URL' },
      });
      setKeyErrors(fieldErrors);
      if (!isValid(fieldErrors)) {
        setKeyMsg({ kind: 'err', text: 'Please fix the highlighted fields.' });
        return;
      }
    } else {
      setKeyErrors({});
    }
    // Parse the optional caps. Empty = leave unset (no cap of that kind).
    let spendCapUsd: number | undefined;
    if (spendCapInput.trim()) {
      const n = Number(spendCapInput.trim());
      if (!Number.isFinite(n) || n < 0) {
        setKeyMsg({ kind: 'err', text: 'Spend cap must be a non-negative number.' });
        return;
      }
      spendCapUsd = n;
    }
    let dailyRequestCap: number | undefined;
    if (dailyCapInput.trim()) {
      const n = Number(dailyCapInput.trim());
      if (!Number.isInteger(n) || n < 0) {
        setKeyMsg({ kind: 'err', text: 'Daily request cap must be a non-negative whole number.' });
        return;
      }
      dailyRequestCap = n;
    }
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      const { GraphVaultClient } = await import('../../lib/api/client');
      const client = new GraphVaultClient(serverUrl, auth.token);
      await client.saveAiConfig({
        apiKey: keyInput,
        gateway,
        baseUrl: gateway === 'custom' ? customBaseUrl.trim() : undefined,
        model: serverAiModel.trim() || undefined,
        spendCapUsd,
        dailyRequestCap,
      });
      setKeyMsg({
        kind: 'ok',
        text: 'API key saved to your server. It is encrypted at rest and never returned to this browser.',
      });
      setKeyInput('');
      setShowKeyForm(false);
      await fetchKeyConfig();
    } catch (err) {
      setKeyMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to save AI key.',
      });
    } finally {
      setKeyBusy(false);
    }
  };

  const handleDeleteKey = async () => {
    if (!auth.token) return;
    if (
      !window.confirm(
        'Remove the AI key from your server? The assistant will stop working until you add a new key.',
      )
    )
      return;
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      const { GraphVaultClient } = await import('../../lib/api/client');
      const client = new GraphVaultClient(serverUrl, auth.token);
      await client.deleteAiConfig();
      setKeyConfigInfo(null);
      setKeyMsg({ kind: 'ok', text: 'AI key removed from the server.' });
    } catch (err) {
      setKeyMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to remove AI key.',
      });
    } finally {
      setKeyBusy(false);
    }
  };

  const handleKindChange = (kind: AISettings['kind']) => {
    update({ kind });
  };

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">AI assistant</h2>

      {/* Unmissable privacy notice */}
      <div className="mt-2 rounded-md border border-amber-900/60 bg-amber-950/20 p-3 text-xs text-amber-300">
        <strong>Privacy notice:</strong> your notes leave your device only if you enable a cloud
        provider. <strong>Local</strong> and <strong>Off</strong> modes keep everything on-device.
        The <strong>Server</strong> mode proxies your prompt through your self-hosted server — your
        API key is stored on <em>your server</em>, encrypted at rest, and is never sent to this
        browser at any point.
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
                kind: 'server' as const,
                label: 'Server (BYO-key, OpenRouter default)',
                desc: 'Your key lives on your server — the browser only sends the prompt, never a key.',
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

      {/* Server (BYO-key proxy) config */}
      {settings.kind === 'server' && (
        <div className="mt-4 space-y-3">
          {/* Security notice — unmissable */}
          <div className="rounded-md border border-sky-900/40 bg-sky-950/20 p-3 text-xs text-sky-300">
            <strong>Your key stays on your server.</strong> The API key you enter below is sent once
            over TLS to your GraphVault server and stored encrypted with AES-256-GCM. It is never
            returned to this browser, never stored in the browser, and never logged. When you run
            the assistant, your prompt (which includes note content) goes to{' '}
            <em>your server → your chosen gateway</em>; your server adds the key for the outbound
            call. The server records only request counts and cost for the spend cap — never your
            prompts or the responses.
          </div>

          {/* Optional model override for local panel */}
          <div>
            <label
              className="mb-1 block text-xs font-medium text-neutral-400"
              htmlFor="ai-server-model"
            >
              Model override{' '}
              <span className="text-neutral-600">
                (optional — leave blank to use server default)
              </span>
            </label>
            <input
              id="ai-server-model"
              type="text"
              value={settings.serverModel}
              onChange={(e) => update({ serverModel: e.target.value })}
              placeholder="openai/gpt-4o-mini"
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500"
            />
            <p className="mt-1 text-xs text-neutral-600">
              OpenRouter model strings: <code className="text-neutral-500">openai/gpt-4o-mini</code>
              , <code className="text-neutral-500">anthropic/claude-sonnet-4-5</code>, etc.
            </p>
          </div>

          {/* Key management — sign-in guard */}
          {!auth.isSignedIn ? (
            <p className="text-xs text-neutral-500">
              Sign in to your GraphVault server (Account section above) to configure the AI key.
            </p>
          ) : (
            <>
              {/* Current key status */}
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium text-neutral-400">Server-side API key</h3>
                <button
                  type="button"
                  onClick={() => void fetchKeyConfig()}
                  disabled={loadingKeyConfig}
                  className="text-xs text-neutral-500 hover:text-neutral-300 disabled:opacity-50"
                >
                  {loadingKeyConfig ? 'Loading…' : 'Refresh'}
                </button>
              </div>

              {keyConfigInfo ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
                  <dt>Status</dt>
                  <dd className="text-emerald-400">Key configured</dd>
                  <dt>Gateway</dt>
                  <dd className="text-neutral-200">
                    {keyConfigInfo.gateway === 'openrouter' ? 'OpenRouter' : 'Custom'}
                  </dd>
                  {keyConfigInfo.model && (
                    <>
                      <dt>Default model</dt>
                      <dd className="truncate text-neutral-200">{keyConfigInfo.model}</dd>
                    </>
                  )}
                  <dt>API key</dt>
                  <dd className="text-neutral-600 italic">stored encrypted on server</dd>
                  <dt>Last updated</dt>
                  <dd className="text-neutral-200">
                    {new Date(keyConfigInfo.updatedAt).toLocaleString()}
                  </dd>
                </dl>
              ) : (
                <></>
              )}

              {/* Budget / spend meter — driven by the live spendCapState from
                  GET /v1/ai/config. Shows accrued spend + request count for the
                  current UTC day and a coloured progress bar. */}
              {keyConfigInfo?.spendCapState && (
                <BudgetMeter
                  state={keyConfigInfo.spendCapState}
                  spendCapUsd={keyConfigInfo.spendCapUsd}
                />
              )}

              {!keyConfigInfo && (
                <p className="text-xs text-neutral-500">
                  No AI key configured on the server yet. Add one below.
                </p>
              )}

              {/* Action buttons */}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowKeyForm((s) => {
                      const next = !s;
                      if (next && keyConfigInfo) {
                        // Pre-fill non-secret fields from the stored config so an
                        // "Update" preserves them. The key itself is NEVER
                        // pre-filled — it is write-only and never returned.
                        setGateway(keyConfigInfo.gateway);
                        setCustomBaseUrl(keyConfigInfo.baseUrl ?? '');
                        setServerAiModel(keyConfigInfo.model ?? '');
                        setSpendCapInput(
                          keyConfigInfo.spendCapUsd != null
                            ? String(keyConfigInfo.spendCapUsd)
                            : '',
                        );
                      }
                      return next;
                    });
                    setKeyMsg(null);
                    setKeyInput('');
                  }}
                  disabled={keyBusy}
                  className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                >
                  {keyConfigInfo ? 'Update key' : 'Add API key'}
                </button>
                {keyConfigInfo && (
                  <button
                    type="button"
                    onClick={() => void handleDeleteKey()}
                    disabled={keyBusy}
                    className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/60 disabled:opacity-40"
                  >
                    Remove key
                  </button>
                )}
              </div>

              {/* Key entry form */}
              {showKeyForm && (
                <form onSubmit={(e) => void handleSaveKey(e)} className="mt-3 space-y-3" noValidate>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-400">
                      Gateway
                    </label>
                    <div className="flex gap-3 text-sm">
                      {[
                        {
                          value: 'openrouter' as const,
                          label: 'OpenRouter (400+ models, recommended)',
                        },
                        { value: 'custom' as const, label: 'Custom base URL' },
                      ].map(({ value, label }) => (
                        <label
                          key={value}
                          className="flex cursor-pointer items-center gap-1.5 text-neutral-300"
                        >
                          <input
                            type="radio"
                            name="ai-gateway"
                            value={value}
                            checked={gateway === value}
                            onChange={() => setGateway(value)}
                            className="accent-sky-500"
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>

                  {gateway === 'custom' && (
                    <div>
                      <label
                        className="mb-1 block text-xs font-medium text-neutral-400"
                        htmlFor="ai-custom-url"
                      >
                        Base URL
                      </label>
                      <input
                        id="ai-custom-url"
                        type="url"
                        value={customBaseUrl}
                        onChange={(e) => setCustomBaseUrl(e.target.value)}
                        disabled={keyBusy}
                        aria-invalid={Boolean(keyErrors.customBaseUrl)}
                        aria-describedby={
                          keyErrors.customBaseUrl ? 'ai-custom-url-error' : undefined
                        }
                        placeholder="https://api.openai.com/v1"
                        className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                      />
                      <FieldError id="ai-custom-url-error" message={keyErrors.customBaseUrl} />
                      <p className="mt-1 text-xs text-neutral-600">
                        Any OpenAI-compatible endpoint (Anthropic, OpenAI, Together, etc.)
                      </p>
                    </div>
                  )}

                  <div>
                    <label
                      className="mb-1 block text-xs font-medium text-neutral-400"
                      htmlFor="ai-server-default-model"
                    >
                      Default model on server <span className="text-neutral-600">(optional)</span>
                    </label>
                    <input
                      id="ai-server-default-model"
                      type="text"
                      value={serverAiModel}
                      onChange={(e) => setServerAiModel(e.target.value)}
                      disabled={keyBusy}
                      placeholder={gateway === 'openrouter' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini'}
                      className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                    />
                  </div>

                  {/* Spend / request caps — durable, per-user/day, reset at UTC
                      midnight. Empty = no cap of that kind. See docs/ai-bff.md §4. */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        className="mb-1 block text-xs font-medium text-neutral-400"
                        htmlFor="ai-spend-cap"
                      >
                        Daily spend cap (USD)
                      </label>
                      <input
                        id="ai-spend-cap"
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={spendCapInput}
                        onChange={(e) => setSpendCapInput(e.target.value)}
                        disabled={keyBusy}
                        placeholder="e.g. 5.00"
                        className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                      />
                      <p className="mt-1 text-xs text-neutral-600">Blank = no $ cap.</p>
                    </div>
                    <div>
                      <label
                        className="mb-1 block text-xs font-medium text-neutral-400"
                        htmlFor="ai-daily-cap"
                      >
                        Daily request cap
                      </label>
                      <input
                        id="ai-daily-cap"
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        value={dailyCapInput}
                        onChange={(e) => setDailyCapInput(e.target.value)}
                        disabled={keyBusy}
                        placeholder="server default"
                        className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                      />
                      <p className="mt-1 text-xs text-neutral-600">Blank = server default.</p>
                    </div>
                  </div>

                  <div>
                    <label
                      className="mb-1 block text-xs font-medium text-neutral-400"
                      htmlFor="ai-key-input"
                    >
                      API key
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="ai-key-input"
                        type={showKeyInput ? 'text' : 'password'}
                        value={keyInput}
                        onChange={(e) => setKeyInput(e.target.value)}
                        autoComplete="new-password"
                        spellCheck={false}
                        disabled={keyBusy}
                        placeholder={gateway === 'openrouter' ? 'sk-or-…' : 'sk-…'}
                        className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm font-mono text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKeyInput((s) => !s)}
                        className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-neutral-400 hover:text-neutral-200"
                        aria-label={showKeyInput ? 'Hide key' : 'Show key'}
                      >
                        {showKeyInput ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-neutral-600">
                      Sent to your server over TLS and stored encrypted — never returned to this
                      browser. Your key is stored on <em>your</em> server, not GraphVault&apos;s
                      infrastructure.
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={keyBusy || !keyInput.trim()}
                      className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
                    >
                      {keyBusy ? 'Saving…' : 'Save key to server'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowKeyForm(false);
                        setKeyInput('');
                        setKeyMsg(null);
                      }}
                      disabled={keyBusy}
                      className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              <div className="mt-1 min-h-4 text-xs" role="status" aria-live="polite">
                {keyMsg && (
                  <span className={keyMsg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
                    {keyMsg.text}
                  </span>
                )}
              </div>
            </>
          )}
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
              : 'Server proxy — key on your server, never in this browser'}
        </span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Connectors section (M22 — phase 1: local-only)
// ---------------------------------------------------------------------------

/** Privacy posture badge shown before a connector runs. */
function PostureBadge({ posture }: { posture: 'local' | 'server' | 'byo' }) {
  const colors = PRIVACY_POSTURE_COLORS[posture];
  return (
    <span
      className={[
        'inline-block rounded border px-2 py-0.5 text-xs font-medium',
        colors.bg,
        colors.text,
        colors.border,
      ].join(' ')}
    >
      {posture === 'local' ? 'On-device' : posture === 'server' ? 'Via your server' : 'BYO cred'}
    </span>
  );
}

/**
 * The RSS / Atom / OPML import sub-panel. Shown inside ConnectorsSection when
 * the user chooses to use the RSS connector.
 */
function RssImportPanel({ vault }: { vault: ReturnType<typeof useVaultContext> }) {
  const [xmlInput, setXmlInput] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const connector: LocalImportConnector = rssOpmlConnector;

  const runImport = async (source: string, sourceName?: string) => {
    if (!source.trim()) {
      setMsg({ kind: 'err', text: 'Paste XML content or upload a file first.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const connectorNotes = connector.parse(source);
      const summary = vault.importNotes(connectorNotes);
      const parts: string[] = [];
      if (summary.added) parts.push(`${summary.added} note${summary.added !== 1 ? 's' : ''} added`);
      if (summary.renamed.length)
        parts.push(`${summary.renamed.length} kept as copies (no overwrite)`);
      if (summary.unchanged) parts.push(`${summary.unchanged} unchanged`);
      const label = sourceName ? `"${sourceName}"` : 'feed';
      setMsg({
        kind: 'ok',
        text: `Imported from ${label}: ${parts.join(', ') || 'nothing new'}.`,
      });
      setXmlInput('');
    } catch (err) {
      setMsg({
        kind: 'err',
        text:
          err instanceof ConnectorError || err instanceof Error ? err.message : 'Import failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File) => {
    try {
      const text = await file.text();
      await runImport(text, file.name);
    } catch {
      setMsg({ kind: 'err', text: 'Could not read file.' });
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  };

  return (
    <div className="mt-4 space-y-4">
      {/* Instructions */}
      <p className="text-xs text-neutral-500">
        Paste RSS 2.0, Atom, or OPML XML below, or upload a{' '}
        <code className="text-neutral-400">.xml</code> /{' '}
        <code className="text-neutral-400">.opml</code> file. Each feed item becomes one note under{' '}
        <code className="text-neutral-400">connectors/rss/</code>. Import is collision-safe —
        existing notes are never overwritten.
      </p>

      {/* Paste area */}
      <div>
        <label className="mb-1 block text-xs font-medium text-neutral-400" htmlFor="rss-xml-input">
          Paste XML
        </label>
        <textarea
          id="rss-xml-input"
          rows={6}
          value={xmlInput}
          onChange={(e) => setXmlInput(e.target.value)}
          disabled={busy}
          placeholder={'<?xml version="1.0"?>\n<rss version="2.0">\n  ...\n</rss>'}
          spellCheck={false}
          className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 font-mono text-xs text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void runImport(xmlInput)}
          disabled={busy || !xmlInput.trim()}
          className="mt-2 rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
        >
          {busy ? 'Importing…' : 'Import from pasted XML'}
        </button>
      </div>

      {/* File upload drag-and-drop */}
      <div>
        <p className="mb-2 text-xs text-neutral-500">Or upload a file:</p>
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          aria-label="Drop RSS/OPML file here to import"
          className={[
            'flex min-h-[5rem] flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors',
            dragOver
              ? 'border-neutral-400 bg-neutral-800/60'
              : 'border-neutral-700 bg-neutral-900/20 hover:border-neutral-600',
          ].join(' ')}
        >
          <p className="select-none text-xs text-neutral-500">
            {dragOver ? 'Drop to import' : 'Drop .xml / .opml here'}
          </p>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          >
            Upload file…
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={connector.acceptedExtensions.join(',')}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = '';
          }}
        />
      </div>

      {/* Result message */}
      <div className="min-h-4 text-xs" role="status" aria-live="polite">
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Email import panel — file upload for .eml and .mbox files.
 *
 * Processes files entirely in the browser; no network calls. Uses the
 * emailConnector's parse() method and vault.importNotes() for collision-safe
 * import.
 */
function EmailImportPanel({ vault }: { vault: ReturnType<typeof useVaultContext> }) {
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const connector: LocalImportConnector = emailConnector;

  const runImport = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setMsg(null);

    let totalAdded = 0;
    let totalRenamed = 0;
    let totalUnchanged = 0;
    const errors: string[] = [];

    for (const file of files) {
      try {
        const text = await file.text();
        const connectorNotes = connector.parse(text);
        const summary = vault.importNotes(connectorNotes);
        totalAdded += summary.added;
        totalRenamed += summary.renamed.length;
        totalUnchanged += summary.unchanged;
      } catch (err) {
        errors.push(
          `${file.name}: ${err instanceof ConnectorError || err instanceof Error ? err.message : 'Import failed.'}`,
        );
      }
    }

    setBusy(false);

    if (errors.length > 0 && totalAdded === 0 && totalRenamed === 0 && totalUnchanged === 0) {
      setMsg({ kind: 'err', text: errors.slice(0, 2).join(' ') });
      return;
    }

    const parts: string[] = [];
    if (totalAdded) parts.push(`${totalAdded} note${totalAdded !== 1 ? 's' : ''} added`);
    if (totalRenamed) parts.push(`${totalRenamed} kept as copies (no overwrite)`);
    if (totalUnchanged) parts.push(`${totalUnchanged} unchanged`);
    if (errors.length) parts.push(`${errors.length} file(s) failed`);
    setMsg({
      kind: 'ok',
      text: `Imported: ${parts.join(', ') || 'nothing new'}.`,
    });
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      void runImport(Array.from(e.dataTransfer.files));
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <p className="text-xs text-neutral-500">
        Upload <code className="text-neutral-400">.eml</code> files (one message each) or{' '}
        <code className="text-neutral-400">.mbox</code> archives (multiple messages). Each message
        becomes one note under <code className="text-neutral-400">connectors/email/</code>. Import
        is collision-safe — existing notes are never overwritten.
      </p>

      <div className="rounded-md border border-emerald-900/40 bg-emerald-950/20 p-3 text-xs text-emerald-300">
        <strong>On-device only.</strong> Your email files are parsed entirely in the browser.
        Nothing is uploaded or sent anywhere. Supports text/plain and text/html bodies, with
        quoted-printable and base64 transfer encodings.
      </div>

      {/* Drop zone */}
      <div>
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          aria-label="Drop .eml or .mbox files here to import"
          className={[
            'flex min-h-[5rem] flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors',
            dragOver
              ? 'border-neutral-400 bg-neutral-800/60'
              : busy
                ? 'border-neutral-700 bg-neutral-900/20 opacity-60'
                : 'border-neutral-700 bg-neutral-900/20 hover:border-neutral-600',
          ].join(' ')}
        >
          <p className="select-none text-xs text-neutral-500">
            {dragOver ? 'Drop to import' : busy ? 'Importing…' : 'Drop .eml / .mbox here'}
          </p>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          >
            {busy ? 'Importing…' : 'Upload files…'}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={connector.acceptedExtensions.join(',')}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              void runImport(Array.from(e.target.files));
            }
            e.target.value = '';
          }}
        />
      </div>

      <p className="text-xs text-neutral-600">
        Tip: export emails from your mail client as .eml (individual messages) or .mbox (folder
        export). Most clients support one or both formats.
      </p>

      {/* Result message */}
      <div className="min-h-4 text-xs" role="status" aria-live="polite">
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Web-clipper panel — paste a URL, the server fetches it and converts to Markdown.
 *
 * Privacy posture: `server` — the server makes the outbound HTTP request,
 * sidestepping browser CORS. An SSRF guard on the server blocks private/loopback
 * addresses. Requires a signed-in GraphVault server session.
 */
function WebClipPanel({
  vault,
  auth,
  serverUrl,
}: {
  vault: ReturnType<typeof useVaultContext>;
  auth: ReturnType<typeof useAuth>;
  serverUrl: string;
}) {
  const [urlInput, setUrlInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [urlError, setUrlError] = useState('');

  const handleClip = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = urlInput.trim();
    const fieldErrors = validateFields({
      url: { value: urlInput, required: true, url: true, label: 'URL' },
    });
    setUrlError(fieldErrors.url ?? '');
    if (!isValid(fieldErrors)) {
      setMsg({ kind: 'err', text: 'Please enter a valid http(s) URL.' });
      return;
    }
    if (!auth.token) {
      setMsg({ kind: 'err', text: 'Sign in to your GraphVault server first.' });
      return;
    }

    setBusy(true);
    setMsg(null);

    try {
      const client = new GraphVaultClient(serverUrl, auth.token);
      const result = await client.clipUrl(url);

      // Build a collision-safe vault path for the clipped note.
      // Path: connectors/webclip/<hostname>/<title>.md
      let hostname = 'unknown';
      try {
        hostname = new URL(result.sourceUrl).hostname.replace(/^www\./, '');
      } catch {
        // keep 'unknown'
      }

      // Sanitise title for use as a filename.
      const safeTitle =
        result.title
          .replace(/[/\\:*?"<>|]/g, '-')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120) || 'Untitled Page';

      const path = `connectors/webclip/${hostname}/${safeTitle}.md`;

      // Build Markdown content with frontmatter.
      const now = new Date().toISOString();
      const content = [
        '---',
        `title: ${JSON.stringify(result.title)}`,
        `source: ${JSON.stringify(result.sourceUrl)}`,
        `clipped: ${JSON.stringify(now)}`,
        'tags: [web-clip]',
        '---',
        '',
        `# ${result.title}`,
        '',
        `> Clipped from [${result.sourceUrl}](${result.sourceUrl}) on ${now.slice(0, 10)}`,
        '',
        result.markdown,
      ].join('\n');

      const summary = vault.importNotes([{ path, content }]);
      const parts: string[] = [];
      if (summary.added) parts.push(`${summary.added} note added`);
      if (summary.renamed.length) parts.push('kept as copy (already exists)');
      if (summary.unchanged) parts.push('unchanged (already clipped)');

      setMsg({
        kind: 'ok',
        text: `Clipped "${result.title}" — ${parts.join(', ')}.`,
      });
      setUrlInput('');
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Clip failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <p className="text-xs text-neutral-500">
        Paste a public URL. Your GraphVault server fetches the page (no CORS issues), extracts the
        main content, converts it to Markdown, and saves it as a note under{' '}
        <code className="text-neutral-400">connectors/webclip/</code>. Import is collision-safe.
      </p>

      {/* Security notice */}
      <div className="rounded-md border border-sky-900/40 bg-sky-950/20 p-3 text-xs text-sky-300">
        <strong>Via your server.</strong> The HTTP request goes through your self-hosted GraphVault
        server, not the browser. Private and loopback addresses (10.x, 192.168.x, 127.x,
        169.254.169.254) are blocked server-side. The URL is fetched once and is not stored
        permanently by the server.
      </div>

      {!auth.isSignedIn ? (
        <p className="text-xs text-neutral-500">
          Sign in to your GraphVault server (Account section above) to use the web clipper.
        </p>
      ) : (
        <form onSubmit={(e) => void handleClip(e)} className="space-y-3" noValidate>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-400" htmlFor="clip-url">
              URL to clip
            </label>
            <input
              id="clip-url"
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              disabled={busy}
              aria-invalid={Boolean(urlError)}
              aria-describedby={urlError ? 'clip-url-error' : undefined}
              placeholder="https://example.com/article"
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
            />
            <FieldError id="clip-url-error" message={urlError} />
          </div>
          <button
            type="submit"
            disabled={busy || !urlInput.trim()}
            className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
          >
            {busy ? 'Clipping…' : 'Clip page'}
          </button>
        </form>
      )}

      <div className="min-h-4 text-xs" role="status" aria-live="polite">
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The full Connectors settings section. Lists all available connectors with
 * their privacy posture, description, and an expand/collapse panel per connector.
 *
 * Phase 1: local-only connectors (RSS/OPML, email).
 * Phase 2: server-posture connectors (web clipper — fetches via the self-hosted
 *   GraphVault server, no credentials needed beyond a session token).
 */
function ConnectorsSection({
  vault,
  auth,
  serverUrl,
}: {
  vault: ReturnType<typeof useVaultContext>;
  auth: ReturnType<typeof useAuth>;
  serverUrl: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  const toggle = (id: string) => setOpenId((prev) => (prev === id ? null : id));

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">Connectors</h2>

      {/* Privacy preamble */}
      <div className="mt-2 rounded-md border border-sky-900/40 bg-sky-950/20 p-3 text-xs text-sky-300">
        <strong>Privacy model:</strong> connectors are opt-in and off by default. Each connector
        shows its privacy posture before it runs. Phase 1 connectors are{' '}
        <strong>on-device only</strong> — no network calls, no credentials. Phase 2 connectors route
        through your self-hosted GraphVault server — credentials never reach the browser.
      </div>

      {/* Connector list */}
      <ul className="mt-4 space-y-3">
        {/* ---- Phase 1: local-import connectors ---- */}
        {LOCAL_IMPORT_CONNECTORS.filter((c) => c.isAvailable()).map((c) => (
          <li
            key={c.id}
            className="rounded-lg border border-neutral-800 bg-neutral-950/30 px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-neutral-200">{c.name}</span>
                  <PostureBadge posture={c.privacyPosture} />
                </div>
                <p className="mt-1 text-xs text-neutral-500">{c.description}</p>
                <p className="mt-1 text-xs text-neutral-600">
                  {PRIVACY_POSTURE_LABELS[c.privacyPosture]}
                </p>
              </div>
              <button
                type="button"
                onClick={() => toggle(c.id)}
                className={[
                  'shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors',
                  openId === c.id
                    ? 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'
                    : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700',
                ].join(' ')}
                aria-expanded={openId === c.id}
              >
                {openId === c.id ? 'Close' : 'Use'}
              </button>
            </div>

            {/* Expand the import UI for this connector */}
            {openId === c.id && c.id === 'rss-opml-import' && <RssImportPanel vault={vault} />}
            {openId === c.id && c.id === 'email-import' && <EmailImportPanel vault={vault} />}
          </li>
        ))}

        {/* ---- Phase 2: server-posture connector — web clipper ---- */}
        <li className="rounded-lg border border-neutral-800 bg-neutral-950/30 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-neutral-200">Clip a web page (URL)</span>
                <PostureBadge posture="server" />
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                Paste a URL and your GraphVault server fetches it, extracts the main content, and
                creates a Markdown note. No browser CORS — the request goes through your server.
                Requires a signed-in server session.
              </p>
              <p className="mt-1 text-xs text-neutral-600">{PRIVACY_POSTURE_LABELS['server']}</p>
            </div>
            <button
              type="button"
              onClick={() => toggle('web-clip')}
              className={[
                'shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors',
                openId === 'web-clip'
                  ? 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'
                  : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700',
              ].join(' ')}
              aria-expanded={openId === 'web-clip'}
            >
              {openId === 'web-clip' ? 'Close' : 'Use'}
            </button>
          </div>

          {openId === 'web-clip' && (
            <WebClipPanel vault={vault} auth={auth} serverUrl={serverUrl} />
          )}
        </li>
      </ul>

      <p className="mt-4 text-xs text-neutral-600">
        Phase 2 will add live email connectors (IMAP, Gmail, Outlook) that route through your
        self-hosted GraphVault server — credentials never touch the browser.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// App importer section (M20 — one-click importers)
// ---------------------------------------------------------------------------

/**
 * Settings section: "Import from another app".
 *
 * Lets the user pick a source app (Obsidian, Notion, Logseq/Roam, or the
 * generic GraphVault backup importer), then drop or upload their export file.
 * After conversion the summary (added / conflict copies / unchanged) is shown.
 *
 * All processing is client-side. Every import goes through the same
 * collision-safe `vault.importNotes` path as the existing Import section.
 */
function AppImporterSection({ vault }: { vault: ReturnType<typeof useVaultContext> }) {
  const [selectedId, setSelectedId] = useState<string>(ALL_IMPORTERS[0].id);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const selectedImporter: Importer =
    ALL_IMPORTERS.find((imp) => imp.id === selectedId) ?? ALL_IMPORTERS[0];

  const handleConvert = async (file: File) => {
    setBusy(true);
    setMsg(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const entries = await selectedImporter.convert(bytes, file.name);
      if (entries.length === 0) {
        setMsg({ kind: 'err', text: 'No importable notes found in the file.' });
        return;
      }
      const summary = vault.importNotes(entries);
      const parts: string[] = [`${summary.added} added`];
      if (summary.renamed.length)
        parts.push(`${summary.renamed.length} kept as copies (no overwrite)`);
      if (summary.unchanged) parts.push(`${summary.unchanged} unchanged`);
      setMsg({
        kind: 'ok',
        text: `Imported from "${file.name}": ${parts.join(', ')}.`,
      });
    } catch (err) {
      const msg =
        err instanceof ImporterError || err instanceof Error ? err.message : 'Import failed.';
      setMsg({ kind: 'err', text: msg });
    } finally {
      setBusy(false);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleConvert(file);
  };

  const acceptAttr = selectedImporter.acceptedExtensions.join(',');

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">Import from another app</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Switch to GraphVault in seconds. Pick your source app, then drop or upload your export.
        Everything runs in your browser — no data leaves your device.
      </p>

      {/* Source app picker */}
      <fieldset className="mt-4">
        <legend className="mb-2 text-xs font-medium text-neutral-400">Source app</legend>
        <div className="space-y-1">
          {ALL_IMPORTERS.map((imp) => (
            <label
              key={imp.id}
              className={[
                'flex cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                selectedId === imp.id
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200',
              ].join(' ')}
            >
              <input
                type="radio"
                name="importer-source"
                value={imp.id}
                checked={selectedId === imp.id}
                onChange={() => {
                  setSelectedId(imp.id);
                  setMsg(null);
                }}
                className="mt-0.5 accent-sky-500"
              />
              <span>
                <span className="font-medium">{imp.name}</span>
                <span className="ml-1 text-xs text-neutral-500"> — {imp.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* Accepted file types note */}
      <p className="mt-3 text-xs text-neutral-600">
        Accepted:{' '}
        {selectedImporter.acceptedExtensions.map((ext, i) => (
          <span key={ext}>
            {i > 0 && ', '}
            <code className="text-neutral-500">{ext}</code>
          </span>
        ))}
      </p>

      {/* Drop zone */}
      <div className="mt-3">
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          aria-label={`Drop ${selectedImporter.name} export here`}
          className={[
            'flex min-h-[6rem] flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors',
            dragOver
              ? 'border-neutral-400 bg-neutral-800/60'
              : busy
                ? 'border-neutral-700 bg-neutral-900/20 opacity-60'
                : 'border-neutral-700 bg-neutral-900/20 hover:border-neutral-600',
          ].join(' ')}
        >
          <p className="select-none text-xs text-neutral-500">
            {dragOver
              ? 'Drop to import'
              : busy
                ? 'Importing…'
                : `Drop your ${selectedImporter.name} export here`}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          >
            {busy ? 'Importing…' : 'Choose file…'}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={acceptAttr}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleConvert(file);
            e.target.value = '';
          }}
        />
      </div>

      <p className="mt-2 text-xs text-neutral-500">
        Import never overwrites: if a note already exists with different content, your copy is kept
        alongside the imported one.
      </p>

      <div className="mt-2 min-h-4 text-xs" role="status" aria-live="polite">
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}
