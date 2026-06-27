'use client';

/**
 * PassphraseGate - shown when the vault is encrypted and the user has not yet
 * provided the passphrase for this session.
 *
 * Design:
 *  - Renders a full-screen blocking overlay so the encrypted vault cannot be
 *    accessed until unlocked.
 *  - Never stores, logs, or transmits the passphrase.
 *  - Wrong passphrase: shows an error and clears the input. The encrypted blob
 *    is NEVER mutated on a failed attempt - data-loss is impossible from this
 *    component.
 *  - The `onUnlock` callback receives the validated passphrase; the parent is
 *    responsible for decryption.
 */

import { useRef, useState } from 'react';

export interface PassphraseGateProps {
  /**
   * Called when the user submits a passphrase. The callback should attempt
   * decryption and either resolve (unlocking the gate) or reject with an error
   * (the gate will display it and let the user retry).
   */
  onUnlock: (passphrase: string) => Promise<void>;
  /** Set to true while the parent is attempting decryption. */
  loading?: boolean;
}

/**
 * Full-screen passphrase entry overlay.
 *
 * Mount this component when `isVaultEncryptedSentinel()` returns true and the
 * in-memory passphrase is not yet set. Unmount (replace with the app) once
 * `onUnlock` resolves successfully.
 */
export function PassphraseGate({ onUnlock, loading = false }: PassphraseGateProps) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase || busy || loading) return;

    setError(null);
    setBusy(true);

    try {
      await onUnlock(passphrase);
      // On success the parent unmounts this component - no state cleanup needed.
    } catch {
      // Do NOT reveal whether it was a wrong passphrase or tampered data.
      setError('Incorrect passphrase - please try again.');
      setPassphrase('');
      // Re-focus for retry convenience.
      setTimeout(() => inputRef.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  };

  const isWorking = busy || loading;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950">
      <div className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900 p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-neutral-700 bg-neutral-800">
            {/* Lock icon (inline SVG - zero deps) */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6 text-neutral-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.5 10.5V7.5a4.5 4.5 0 10-9 0v3m-1.5 0h12a1.5 1.5 0 011.5 1.5v7a1.5 1.5 0 01-1.5 1.5h-12A1.5 1.5 0 014.5 19v-7A1.5 1.5 0 016 10.5z"
              />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-neutral-100">Vault locked</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Enter your passphrase to unlock this vault.
          </p>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} noValidate>
          <label className="mb-1 block text-xs font-medium text-neutral-400" htmlFor="passphrase">
            Passphrase
          </label>
          <input
            ref={inputRef}
            id="passphrase"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            disabled={isWorking}
            placeholder="Enter passphrase…"
            className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-50"
          />

          {error && (
            <p className="mt-2 text-xs text-red-400" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!passphrase || isWorking}
            className="mt-4 w-full rounded-md bg-neutral-200 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
          >
            {isWorking ? 'Unlocking…' : 'Unlock vault'}
          </button>
        </form>
      </div>
    </div>
  );
}
