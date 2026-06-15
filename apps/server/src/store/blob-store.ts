import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, access, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatContentHash, isContentHash, type ContentHash } from '@graphvault/shared';

/** AES-256-GCM on-disk framing: [12B nonce][16B auth tag][ciphertext]. */
const ENC_ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Content-addressed blob storage on disk.
 *
 * Bytes live under `<dataDir>/blobs/<ab>/<cd>/<sha256-hex>`, sharded by the
 * first two byte-pairs of the hex digest to keep directories small. The hash is
 * always recomputed from the bytes before a write commits, so a poisoned or
 * truncated upload can never be stored under the wrong name.
 *
 * When constructed with an `encryptionKey` (32 bytes), blob bytes are encrypted
 * at rest with AES-256-GCM (random nonce per blob, authenticated). The content
 * hash is always the hash of the *plaintext*, so dedupe and the wire protocol
 * are unaffected; only the bytes on disk differ. With no key, bytes are written
 * verbatim (unchanged legacy behavior).
 */
export class DiskBlobStore {
  private readonly root: string;
  private readonly encryptionKey: Buffer | undefined;

  constructor(dataDir: string, encryptionKey?: Buffer) {
    this.root = join(dataDir, 'blobs');
    this.encryptionKey = encryptionKey;
  }

  /** True when blobs are encrypted at rest. */
  get encryptsAtRest(): boolean {
    return this.encryptionKey !== undefined;
  }

  /** Encrypt plaintext into the on-disk frame. */
  private encrypt(plaintext: Buffer): Buffer {
    const key = this.encryptionKey;
    if (!key) return plaintext;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ENC_ALGORITHM, key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, tag, ciphertext]);
  }

  /** Decrypt an on-disk frame back to plaintext, verifying authenticity. */
  private decrypt(stored: Buffer): Buffer {
    const key = this.encryptionKey;
    if (!key) return stored;
    if (stored.length < NONCE_BYTES + TAG_BYTES) {
      throw new Error('encrypted blob is truncated');
    }
    const nonce = stored.subarray(0, NONCE_BYTES);
    const tag = stored.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const ciphertext = stored.subarray(NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ENC_ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /** Compute the canonical `sha256:<hex>` content hash of some bytes. */
  static hashBytes(bytes: Buffer): ContentHash {
    return formatContentHash(createHash('sha256').update(bytes).digest('hex'));
  }

  private pathFor(hash: string): string {
    // hash is `sha256:<64 hex>`; shard on the hex digest.
    const hex = hash.slice('sha256:'.length);
    return join(this.root, hex.slice(0, 2), hex.slice(2, 4), hex);
  }

  async has(hash: string): Promise<boolean> {
    try {
      await access(this.pathFor(hash));
      return true;
    } catch {
      return false;
    }
  }

  async read(hash: string): Promise<Buffer | null> {
    let stored: Buffer;
    try {
      stored = await readFile(this.pathFor(hash));
    } catch {
      return null;
    }
    // Decrypt outside the try/catch above so a key/tag failure surfaces as a
    // real error rather than being masked as "not found".
    return this.decrypt(stored);
  }

  /**
   * Write bytes addressed by their recomputed hash. Returns the verified hash
   * and size. Throws if the bytes do not hash to `expectedHash`.
   */
  async write(bytes: Buffer, expectedHash: string): Promise<{ hash: ContentHash; size: number }> {
    if (!isContentHash(expectedHash)) {
      throw new Error('invalid content hash format');
    }
    const actual = DiskBlobStore.hashBytes(bytes);
    if (actual !== expectedHash) {
      throw new BlobHashMismatchError(expectedHash, actual);
    }

    const dest = this.pathFor(actual);
    await mkdir(join(dest, '..'), { recursive: true });

    // Write to a temp file then atomically rename into place so a reader never
    // sees a partially-written blob. Idempotent: if it already exists, skip.
    if (await this.has(actual)) {
      return { hash: actual, size: bytes.length };
    }
    // `size` is the plaintext length (what the protocol records); only the
    // on-disk representation is encrypted/framed.
    const onDisk = this.encrypt(bytes);
    const tmp = join(
      tmpdir(),
      `gv-blob-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await writeFile(tmp, onDisk);
    try {
      await rename(tmp, dest);
    } catch (err) {
      // Cross-device rename fallback: copy via writeFile, then drop the temp.
      await writeFile(dest, onDisk);
      await unlink(tmp).catch(() => undefined);
      void err;
    }
    return { hash: actual, size: bytes.length };
  }
}

export class BlobHashMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`blob hash mismatch: expected ${expected}, got ${actual}`);
    this.name = 'BlobHashMismatchError';
  }
}
