/**
 * EncryptedVaultStore - at-rest AES-256-GCM encryption decorator for vault
 * storage.
 *
 * This module wraps any {@link RawStorage} backend (a minimal key/value
 * interface) and transparently encrypts the serialised notes blob on save and
 * decrypts it on load.
 *
 * ## Data-safety guarantees
 *
 * - The passphrase is held ONLY in memory. It is NEVER written to storage,
 *   logs, or error messages.
 * - Save:  notes → JSON → AES-256-GCM encrypt → Base64URL → write to storage.
 * - Load:  read → detect magic → Base64URL decode → decrypt → parse JSON.
 * - Wrong passphrase / tamper: throws {@link VaultDecryptionError}; no partial
 *   data is ever returned. The caller must surface the error and let the user
 *   retry.
 * - Enabling encryption (`encryptExisting`): encrypts the current plaintext
 *   blob in place, then marks the sentinel. The original plaintext is
 *   overwritten only AFTER a successful encrypt call - no window where both
 *   plaintext and ciphertext coexist in storage.
 * - Disabling encryption (`decryptExisting`): decrypts and writes back
 *   plaintext, then clears the sentinel.
 * - `lock()` wipes the in-memory passphrase so the vault is effectively locked
 *   until `setPassphrase()` is called again.
 *
 * ## Scope
 *
 * `EncryptedVaultStore` operates over a single serialised JSON blob (the
 * localStorage pattern). The File System adapter stores individual `.md` files,
 * not a single blob; per-file encryption of FS-backed vaults is a future
 * feature. Settings therefore only offers encryption when the active adapter is
 * localStorage.
 */

import {
  decryptVault,
  encryptVault,
  envelopeFromBase64,
  envelopeToBase64,
} from '../../crypto/vaultCrypto';
import type { Note } from '../types';

// ---------------------------------------------------------------------------
// Public constants / types
// ---------------------------------------------------------------------------

/** localStorage key used to persist the "vault is encrypted" flag. */
export const ENCRYPTION_SENTINEL_KEY = 'graphvault:vault:encrypted';

/**
 * Minimal key/value storage interface.
 *
 * Kept as a thin abstraction so the class is testable without a real browser
 * `window.localStorage` object.
 */
export interface RawStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Thrown when decryption fails (wrong passphrase or tampered data). Never
 * exposes whether it was a passphrase error vs. a tamper error - they look
 * identical to the caller so an attacker cannot distinguish them.
 */
export class VaultDecryptionError extends Error {
  constructor(cause?: unknown) {
    super('Vault decryption failed - wrong passphrase or corrupted data.');
    this.name = 'VaultDecryptionError';
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

// ---------------------------------------------------------------------------
// EncryptedVaultStore
// ---------------------------------------------------------------------------

/**
 * Encrypts and decrypts the vault JSON blob stored at `storageKey` in the
 * provided `RawStorage` (typically `window.localStorage`).
 *
 * Usage:
 * ```ts
 * const store = new EncryptedVaultStore(
 *   window.localStorage,
 *   'graphvault:vault:v1',
 *   passphrase,
 * );
 * await store.save(notes);         // writes encrypted blob
 * const notes = await store.load(); // decrypts on load
 * ```
 */
export class EncryptedVaultStore {
  private readonly _storage: RawStorage;
  private readonly _key: string;
  private readonly _sentinelKey: string;
  private _passphrase: string;

  constructor(storage: RawStorage, storageKey: string, passphrase: string) {
    if (!passphrase) {
      throw new TypeError('EncryptedVaultStore: passphrase must be a non-empty string.');
    }
    this._storage = storage;
    this._key = storageKey;
    this._sentinelKey = ENCRYPTION_SENTINEL_KEY;
    this._passphrase = passphrase;
  }

  /** Replace the in-memory passphrase. Does NOT re-encrypt stored data. */
  setPassphrase(passphrase: string): void {
    if (!passphrase) throw new TypeError('Passphrase must not be empty.');
    this._passphrase = passphrase;
  }

  /**
   * Wipe the in-memory passphrase so the vault is effectively locked.
   * After this, `load()` and `save()` will throw until `setPassphrase()` is
   * called.
   */
  lock(): void {
    this._passphrase = '';
  }

  get isLocked(): boolean {
    return this._passphrase === '';
  }

  // ---------------------------------------------------------------------------
  // Core load / save
  // ---------------------------------------------------------------------------

  /**
   * Load and decrypt notes.
   *
   * Throws {@link VaultDecryptionError} on wrong passphrase or tampered data.
   * Never returns partial data.
   *
   * Returns `[]` when no data has been stored yet (first run).
   *
   * Detection: the stored value is a Base64URL string when encrypted (produced
   * by `envelopeToBase64`). We try to decode it as a Base64URL envelope; if
   * the decoded binary starts with the GVE1 magic bytes we treat it as
   * encrypted. If decoding fails or the magic is absent, we fall back to
   * treating it as plaintext JSON.
   */
  async load(): Promise<Note[]> {
    if (!this._passphrase) throw new VaultDecryptionError();

    const raw = this._storage.getItem(this._key);
    if (raw === null) return [];

    // Attempt to decode as a Base64URL-encoded encrypted envelope.
    const maybeEnvelope = tryDecodeEnvelope(raw);

    if (!maybeEnvelope) {
      // Not an encrypted envelope - treat as plaintext JSON.
      return parseNotesJson(raw);
    }

    // It is an encrypted envelope - decrypt it.
    let plaintext: string;
    try {
      plaintext = await decryptVault(maybeEnvelope, this._passphrase);
    } catch (err) {
      throw new VaultDecryptionError(err);
    }

    return parseNotesJson(plaintext);
  }

  /**
   * Encrypt notes and write to storage.
   *
   * Throws if the store is locked.
   */
  async save(notes: Note[]): Promise<void> {
    if (!this._passphrase) throw new VaultDecryptionError();

    const json = JSON.stringify(notes);
    const envelope = await encryptVault(json, this._passphrase);
    const b64 = envelopeToBase64(envelope);
    this._storage.setItem(this._key, b64);
    this._setSentinel(true);
  }

  /**
   * Remove the stored blob and clear the sentinel.
   */
  clear(): void {
    this._storage.removeItem(this._key);
    this._setSentinel(false);
  }

  // ---------------------------------------------------------------------------
  // Enable / disable encryption
  // ---------------------------------------------------------------------------

  /**
   * Enable encryption: encrypt the existing plaintext blob in place.
   *
   * - If the blob is already encrypted: validates it decrypts correctly with
   *   the current passphrase and returns the notes (idempotent).
   * - If no blob exists: marks the sentinel and returns `[]`.
   * - Otherwise: encrypts the plaintext blob and writes back the ciphertext.
   *
   * Returns the notes that were encrypted (for UI confirmation).
   * Throws {@link VaultDecryptionError} if the passphrase is not set.
   */
  async encryptExisting(): Promise<Note[]> {
    if (!this._passphrase) throw new VaultDecryptionError();

    const raw = this._storage.getItem(this._key);

    if (raw === null) {
      this._setSentinel(true);
      return [];
    }

    if (tryDecodeEnvelope(raw)) {
      // Already encrypted - verify we can decrypt it (wrong passphrase guard).
      return this.load();
    }

    // Parse first to return to the caller, validate the data.
    const notes = parseNotesJson(raw);

    // Encrypt and write back. The plaintext is overwritten only on success.
    const envelope = await encryptVault(raw, this._passphrase);
    const b64 = envelopeToBase64(envelope);
    this._storage.setItem(this._key, b64);
    this._setSentinel(true);

    return notes;
  }

  /**
   * Disable encryption: decrypt the stored blob and write back as plaintext.
   *
   * - If the blob is already plaintext: clears the sentinel and returns the
   *   notes (idempotent).
   * - If no blob exists: clears the sentinel and returns `[]`.
   * - Otherwise: decrypts and writes back as plaintext.
   *
   * Throws {@link VaultDecryptionError} on wrong passphrase or tampered data.
   */
  async decryptExisting(): Promise<Note[]> {
    if (!this._passphrase) throw new VaultDecryptionError();

    const raw = this._storage.getItem(this._key);

    if (raw === null) {
      this._setSentinel(false);
      return [];
    }

    const maybeEnvelope = tryDecodeEnvelope(raw);

    if (!maybeEnvelope) {
      this._setSentinel(false);
      return parseNotesJson(raw);
    }

    let plaintext: string;
    try {
      plaintext = await decryptVault(maybeEnvelope, this._passphrase);
    } catch (err) {
      throw new VaultDecryptionError(err);
    }

    const notes = parseNotesJson(plaintext);

    // Write back as plaintext only after a successful decrypt.
    this._storage.setItem(this._key, plaintext);
    this._setSentinel(false);

    return notes;
  }

  // ---------------------------------------------------------------------------
  // Sentinel
  // ---------------------------------------------------------------------------

  private _setSentinel(encrypted: boolean): void {
    if (encrypted) {
      this._storage.setItem(this._sentinelKey, '1');
    } else {
      this._storage.removeItem(this._sentinelKey);
    }
  }

  /** Read the sentinel from this instance's storage. */
  isEncryptedSentinel(): boolean {
    return this._storage.getItem(this._sentinelKey) === '1';
  }
}

// ---------------------------------------------------------------------------
// Module-level sentinel helpers (use window.localStorage directly)
// ---------------------------------------------------------------------------

/**
 * Return `true` if the vault's `localStorage` blob is flagged as encrypted.
 *
 * This is a cheap sync check safe to call before any decryption attempt,
 * e.g. to decide whether to show the passphrase gate on startup.
 */
export function isVaultEncryptedSentinel(): boolean {
  try {
    return (
      typeof window !== 'undefined' && window.localStorage.getItem(ENCRYPTION_SENTINEL_KEY) === '1'
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Narrow-cast guard: checks a value has the shape of {@link Note}. */
function isNote(value: unknown): value is Note {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === 'string' &&
    typeof v.content === 'string' &&
    typeof v.mtime === 'number' &&
    typeof v.ctime === 'number'
  );
}

function parseNotesJson(raw: string): Note[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isNote);
  } catch {
    return [];
  }
}

/**
 * Attempt to decode `raw` as a Base64URL-encoded `VaultEnvelope`.
 *
 * Returns the envelope if the decoded binary starts with the GVE1 magic bytes;
 * returns `null` if the string is not a valid Base64URL envelope (e.g. it is
 * plaintext JSON).
 *
 * We use `envelopeFromBase64` which already validates the magic bytes and
 * throws on failure - we catch and return `null`.
 */
function tryDecodeEnvelope(raw: string): import('../../crypto/vaultCrypto').VaultEnvelope | null {
  try {
    return envelopeFromBase64(raw);
  } catch {
    return null;
  }
}
