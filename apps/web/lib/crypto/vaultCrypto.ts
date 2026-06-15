/**
 * Client-side end-to-end vault encryption.
 *
 * Uses the WebCrypto API (`globalThis.crypto.subtle`) only — zero external
 * dependencies. Runs in modern browsers and Node.js 22+.
 *
 * Design:
 *  - Key derivation: PBKDF2-SHA-256, 310 000 iterations (NIST SP 800-132 /
 *    OWASP 2023 recommendation), 32-byte salt, derives a 256-bit AES-GCM key.
 *  - Encryption: AES-256-GCM with a random 12-byte IV per encrypt call.
 *    The GCM tag (16 bytes) authenticates every byte of ciphertext + AAD.
 *  - Authenticated Additional Data (AAD): the envelope version byte, so a
 *    downgrade/version-swap attack causes decryption to fail.
 *  - Envelope: a self-describing, versioned binary blob (magic 4-byte prefix +
 *    version 1 byte + salt 32 bytes + IV 12 bytes + ciphertext + GCM tag).
 *    Parameters are readable without decryption so the implementation can
 *    evolve iteration counts or algorithms in future envelope versions.
 *  - Invariant: the content hash (for sync / dedupe) is always computed over
 *    the **plaintext** — the encrypted envelope is a local-storage detail only.
 *  - Wrong passphrase / tamper: always throws; never returns partial data.
 */

/** 4-byte magic that starts every encrypted vault blob. */
const MAGIC = new Uint8Array([0x47, 0x56, 0x45, 0x31]); // "GVE1"

/** Envelope format version (1 byte). Increment on breaking schema changes. */
const ENVELOPE_VERSION = 1;

/**
 * Byte layout of the binary envelope (version 1):
 *
 *  offset  len   field
 *  ------  ---   -----
 *  0       4     magic ("GVE1")
 *  4       1     version (0x01)
 *  5       32    PBKDF2 salt
 *  37      12    AES-GCM IV
 *  49      *     ciphertext + 16-byte GCM authentication tag
 */
const HEADER_SIZE = 4 + 1 + 32 + 12; // 49 bytes

const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const KEY_BITS = 256;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the SubtleCrypto instance from the global, or throws. */
function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('WebCrypto SubtleCrypto is not available in this environment.');
  }
  return c.subtle;
}

/** Fill a new buffer with cryptographically-random bytes. */
function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(n));
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

/** Encode a passphrase string as raw UTF-8 bytes for key import. */
function passphraseBytes(passphrase: string): ArrayBuffer {
  return new TextEncoder().encode(passphrase).buffer as ArrayBuffer;
}

/**
 * Derive an AES-256-GCM CryptoKey from a passphrase + salt via PBKDF2.
 * The key is extractable=false so it never leaves the crypto engine.
 */
async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const rawKey = await subtle().importKey(
    'raw',
    passphraseBytes(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return subtle().deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    rawKey,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * The single byte that encodes the envelope version, used as AES-GCM AAD.
 * Binding the version into authenticated data means a version-swap tamper
 * causes AES-GCM to reject decryption.
 */
function versionAAD(): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(1);
  new DataView(buf).setUint8(0, ENVELOPE_VERSION);
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * An opaque, self-describing encrypted vault envelope.
 * The `data` field holds the raw binary; `version` and `algorithm` describe
 * the crypto parameters for human/programmatic inspection without decrypting.
 */
export interface VaultEnvelope {
  /** Magic + version + salt + IV + ciphertext. Binary blob. */
  readonly data: Uint8Array;
  /** Envelope format version (currently 1). */
  readonly version: number;
  /** Human-readable algorithm string for inspection/debug. */
  readonly algorithm: string;
}

/**
 * Encrypt a vault blob (string or bytes) with the given passphrase.
 *
 * Generates a fresh random salt and IV on every call — two encryptions of the
 * same plaintext produce distinct ciphertexts. The GCM tag authenticates both
 * the ciphertext and the envelope version (AAD).
 *
 * @param plaintext  The vault content to encrypt (string or raw bytes).
 * @param passphrase User-supplied passphrase; never stored or logged.
 * @returns          A `VaultEnvelope` with a self-describing binary blob.
 */
export async function encryptVault(
  plaintext: string | Uint8Array,
  passphrase: string,
): Promise<VaultEnvelope> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new TypeError('Passphrase must be a non-empty string.');
  }

  // Normalize to a Uint8Array with an owned ArrayBuffer so WebCrypto accepts it.
  const rawBytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
  const plaintextBytes: Uint8Array<ArrayBuffer> =
    rawBytes.buffer instanceof ArrayBuffer &&
    rawBytes.byteOffset === 0 &&
    rawBytes.byteLength === rawBytes.buffer.byteLength
      ? (rawBytes as Uint8Array<ArrayBuffer>)
      : new Uint8Array(rawBytes);

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt);

  const ciphertextBuf = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: versionAAD() },
    key,
    plaintextBytes,
  );

  // Assemble the envelope: magic (4) + version (1) + salt (32) + iv (12) + ciphertext+tag
  const ciphertext = new Uint8Array(ciphertextBuf);
  const envelope = new Uint8Array(HEADER_SIZE + ciphertext.length);
  let offset = 0;

  envelope.set(MAGIC, offset);
  offset += MAGIC.length;

  envelope[offset] = ENVELOPE_VERSION;
  offset += 1;

  envelope.set(salt, offset);
  offset += SALT_BYTES;

  envelope.set(iv, offset);
  // offset += IV_BYTES; // not needed after final field in header

  envelope.set(ciphertext, HEADER_SIZE);

  return {
    data: envelope,
    version: ENVELOPE_VERSION,
    algorithm: `PBKDF2-SHA256-${PBKDF2_ITERATIONS}/AES-256-GCM`,
  };
}

/**
 * Decrypt a `VaultEnvelope` previously produced by {@link encryptVault}.
 *
 * Throws on wrong passphrase, tampered ciphertext, or a malformed envelope —
 * never returns partial data. The error message does NOT reveal whether the
 * passphrase was wrong vs. the ciphertext was tampered (same error class).
 *
 * @param envelope   The encrypted envelope (from `encryptVault` or storage).
 * @param passphrase The passphrase used at encryption time.
 * @returns          The original plaintext as a UTF-8 string.
 */
export async function decryptVault(
  envelope: VaultEnvelope | Uint8Array,
  passphrase: string,
): Promise<string> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new TypeError('Passphrase must be a non-empty string.');
  }

  // Accept either the struct or the raw binary directly.
  const data = envelope instanceof Uint8Array ? envelope : envelope.data;

  if (data.length < HEADER_SIZE + 16 /* min GCM tag */) {
    throw new Error('Decryption failed: envelope is too short.');
  }

  // Validate magic.
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC[i]) {
      throw new Error('Decryption failed: not a GraphVault encrypted envelope.');
    }
  }

  const version = data[4];
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Decryption failed: unsupported envelope version ${version}.`);
  }

  const salt = new Uint8Array(
    data.buffer,
    data.byteOffset + 5,
    SALT_BYTES,
  ) as Uint8Array<ArrayBuffer>;
  const iv = new Uint8Array(
    data.buffer,
    data.byteOffset + 5 + SALT_BYTES,
    IV_BYTES,
  ) as Uint8Array<ArrayBuffer>;
  const ciphertext = new Uint8Array(
    data.buffer,
    data.byteOffset + HEADER_SIZE,
    data.byteLength - HEADER_SIZE,
  ) as Uint8Array<ArrayBuffer>;

  const key = await deriveKey(passphrase, salt);

  let plaintextBuf: ArrayBuffer;
  try {
    plaintextBuf = await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: versionAAD() },
      key,
      ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength),
    );
  } catch {
    // AES-GCM throws on auth failure. Normalize to a single opaque error so
    // callers cannot distinguish wrong-passphrase from tampered-ciphertext —
    // both are "decryption failed."
    throw new Error('Decryption failed: wrong passphrase or tampered data.');
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(plaintextBuf);
}

/**
 * Return `true` if `blob` looks like an encrypted vault envelope produced by
 * this module (magic-byte check only — does NOT attempt decryption).
 *
 * Safe to call on arbitrary untrusted bytes.
 */
export function isEncrypted(blob: Uint8Array | string): boolean {
  if (typeof blob === 'string') {
    // Cheap ASCII check: the magic bytes are all printable ASCII "GVE1"
    return (
      blob.length >= 4 &&
      blob.charCodeAt(0) === MAGIC[0] &&
      blob.charCodeAt(1) === MAGIC[1] &&
      blob.charCodeAt(2) === MAGIC[2] &&
      blob.charCodeAt(3) === MAGIC[3]
    );
  }
  if (blob.length < HEADER_SIZE) return false;
  return (
    blob[0] === MAGIC[0] && blob[1] === MAGIC[1] && blob[2] === MAGIC[2] && blob[3] === MAGIC[3]
  );
}

/**
 * Serialize a `VaultEnvelope` to a Base64URL string for JSON-safe storage
 * (e.g. in localStorage or a JSON export file).
 */
export function envelopeToBase64(envelope: VaultEnvelope): string {
  // Convert to base64 via browser-safe btoa.
  let binary = '';
  for (let i = 0; i < envelope.data.length; i++) {
    binary += String.fromCharCode(envelope.data[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Deserialize a Base64URL string back into a `VaultEnvelope`.
 * Throws on invalid Base64 or a malformed/unsupported envelope header.
 */
export function envelopeFromBase64(b64: string): VaultEnvelope {
  // Restore standard base64 from base64url.
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    data[i] = binary.charCodeAt(i);
  }

  if (!isEncrypted(data)) {
    throw new Error('Not a GraphVault encrypted envelope.');
  }
  const version = data[4];
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope version ${version}.`);
  }
  return {
    data,
    version,
    algorithm: `PBKDF2-SHA256-${PBKDF2_ITERATIONS}/AES-256-GCM`,
  };
}

// Re-export constants that callers may need for display / tooling.
export { PBKDF2_ITERATIONS, ENVELOPE_VERSION };
