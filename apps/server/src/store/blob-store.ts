import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, access, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatContentHash, isContentHash, type ContentHash } from '@graphvault/shared';

/**
 * Content-addressed blob storage on disk.
 *
 * Bytes live under `<dataDir>/blobs/<ab>/<cd>/<sha256-hex>`, sharded by the
 * first two byte-pairs of the hex digest to keep directories small. The hash is
 * always recomputed from the bytes before a write commits, so a poisoned or
 * truncated upload can never be stored under the wrong name.
 */
export class DiskBlobStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'blobs');
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
    try {
      return await readFile(this.pathFor(hash));
    } catch {
      return null;
    }
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
    const tmp = join(tmpdir(), `gv-blob-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await writeFile(tmp, bytes);
    try {
      await rename(tmp, dest);
    } catch (err) {
      // Cross-device rename fallback: copy via writeFile, then drop the temp.
      await writeFile(dest, bytes);
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
