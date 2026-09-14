'use client';

/**
 * BackupHistory modal.
 *
 * Lists all IndexedDB snapshots (timestamp, note count, optional label) and
 * lets the user restore or delete individual snapshots. Mounted once in
 * AppFrame; open/close is controlled by a custom event so CommandPalette can
 * trigger it without a prop-drilling chain.
 *
 * ## Safety
 * Restore is non-destructive: `useVault.restoreFromSnapshot` takes a
 * "pre-restore" snapshot first, then applies the collision-safe merge.
 * Identical notes are de-duped; colliding notes become "(imported)" copies.
 *
 * ## Durability notice
 * IndexedDB is more durable than localStorage but is still a browser store.
 * We remind the user to also export or enable sync.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { getBackupStore, type SnapshotMeta } from '../lib/vault/backups';
import { useVaultContext } from '../lib/vault/VaultProvider';

/** Custom event name used by CommandPalette to open the modal. */
export const OPEN_BACKUP_HISTORY_EVENT = 'graphvault:open-backup-history';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(epochMs: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toLocaleString();
  }
}

function relativeTime(epochMs: number): string {
  const diffS = Math.floor((Date.now() - epochMs) / 1000);
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BackupHistory() {
  const vault = useVaultContext();
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const headingId = useId();

  // -------------------------------------------------------------------------
  // Load snapshots whenever the modal opens
  // -------------------------------------------------------------------------

  const loadSnapshots = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getBackupStore().listSnapshots();
      setSnapshots(list);
    } finally {
      setLoading(false);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Open / close via custom event (from CommandPalette) or Escape key
  // -------------------------------------------------------------------------

  const close = useCallback(() => {
    setOpen(false);
    setFeedback(null);
    restoreFocusRef.current?.focus?.();
  }, []);

  useEffect(() => {
    const onOpen = () => {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    window.addEventListener(OPEN_BACKUP_HISTORY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_BACKUP_HISTORY_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadSnapshots();
  }, [open, loadSnapshots]);

  // Focus trap: keep Tab / Shift+Tab inside the dialog while open.
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const dialog = dialogRef.current;

    // Focus the dialog itself on open so screen readers announce it.
    dialog.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || document.activeElement === dialog) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  // Outside-click to close (scrim area).
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        close();
      }
    };
    // Use capture so the scrim click fires before child buttons.
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open, close]);

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  const handleRestore = useCallback(
    async (id: string) => {
      if (restoringId) return;
      setRestoringId(id);
      setFeedback(null);
      try {
        const ok = await vault.restoreFromSnapshot(id);
        if (ok) {
          setFeedback(
            'Snapshot restored. A "pre-restore" copy of your previous state was saved automatically.',
          );
          // Refresh the list so the new pre-restore snapshot appears.
          await loadSnapshots();
        } else {
          setFeedback('Snapshot not found - it may have been pruned.');
        }
      } catch (err) {
        setFeedback(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setRestoringId(null);
      }
    },
    [vault, restoringId, loadSnapshots],
  );

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  const handleDelete = useCallback(
    async (id: string) => {
      if (deletingId) return;
      setDeletingId(id);
      setFeedback(null);
      try {
        await getBackupStore().deleteSnapshot(id);
        setSnapshots((prev) => prev.filter((s) => s.id !== id));
      } catch (err) {
        setFeedback(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[8vh]"
      role="presentation"
    >
      {/* Scrim */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-neutral-950/70 backdrop-blur-sm motion-safe:animate-[fadeIn_120ms_ease-out]"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className="relative flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-neutral-700/80 bg-neutral-900/95 shadow-2xl shadow-black/50 ring-1 ring-white/5 motion-safe:animate-[paletteIn_140ms_ease-out] focus:outline-none"
        style={{ maxHeight: '80vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3.5">
          <div>
            <h2 id={headingId} className="text-sm font-semibold text-neutral-100">
              Version history
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Backups are stored locally in your browser (IndexedDB). For extra durability, also
              export your vault or enable sync.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close version history"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Feedback banner - aria-live so screen readers announce the result. */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={
            feedback
              ? 'border-b border-neutral-800 bg-accent-900/20 px-5 py-2.5 text-xs text-accent-300'
              : 'sr-only'
          }
        >
          {feedback ?? ''}
        </div>

        {/* Snapshot list */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-neutral-500">
              Loading…
            </div>
          ) : snapshots.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <span className="text-2xl text-neutral-600">&#9749;</span>
              <p className="text-sm text-neutral-500">No backups yet.</p>
              <p className="max-w-xs text-xs text-neutral-600">
                Snapshots are taken automatically after you edit notes. Make a change to create your
                first backup.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-neutral-800/60">
              {snapshots.map((snap) => {
                const isRestoring = restoringId === snap.id;
                const isDeleting = deletingId === snap.id;
                const busy = isRestoring || isDeleting;
                return (
                  <li
                    key={snap.id}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-neutral-800/30"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm text-neutral-200">
                          {formatDate(snap.takenAt)}
                        </span>
                        {snap.label && (
                          <span className="shrink-0 rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] font-medium text-accent-300">
                            {snap.label}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-neutral-500">
                        <span>
                          {snap.noteCount} note{snap.noteCount !== 1 ? 's' : ''}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{relativeTime(snap.takenAt)}</span>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleRestore(snap.id)}
                        aria-label={`Restore snapshot from ${formatDate(snap.takenAt)}`}
                        className="rounded-md border border-accent-700/50 bg-accent-600/10 px-2.5 py-1 text-xs font-medium text-accent-300 hover:bg-accent-600/20 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent-500"
                      >
                        {isRestoring ? 'Restoring…' : 'Restore'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleDelete(snap.id)}
                        aria-label={`Delete snapshot from ${formatDate(snap.takenAt)}`}
                        className="rounded-md border border-neutral-700/50 bg-neutral-800/40 px-2.5 py-1 text-xs font-medium text-neutral-400 hover:bg-red-900/20 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent-500"
                      >
                        {isDeleting ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-neutral-800 px-5 py-2.5 text-[11px] text-neutral-600">
          <span>
            {snapshots.length} snapshot{snapshots.length !== 1 ? 's' : ''} stored
            {snapshots.length > 0 ? ' · retention: 20 recent + 1/day for 30 days' : ''}
          </span>
          <button
            type="button"
            onClick={close}
            className="text-neutral-500 hover:text-neutral-300 focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
    </svg>
  );
}
