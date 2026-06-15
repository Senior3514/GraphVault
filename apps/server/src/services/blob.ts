import { isContentHash } from '@graphvault/shared';
import { badRequest } from '../errors.js';
import { BlobHashMismatchError, DiskBlobStore } from '../store/blob-store.js';
import type { Storage } from '../store/types.js';

/**
 * Blob upload/download (§5.5). Bytes live on disk (content-addressed); the
 * storage layer keeps lightweight metadata so we can report sizes without
 * touching disk. Uploads are idempotent and the hash is always re-verified.
 */
export class BlobService {
  constructor(
    private readonly storage: Storage,
    private readonly store: DiskBlobStore,
  ) {}

  private assertValidHash(hash: string): void {
    if (!isContentHash(hash)) {
      throw badRequest('Invalid blob hash; expected sha256:<64 hex>');
    }
  }

  async has(hash: string): Promise<boolean> {
    this.assertValidHash(hash);
    // Disk is authoritative for byte presence.
    return this.store.has(hash);
  }

  async get(hash: string): Promise<Buffer | null> {
    this.assertValidHash(hash);
    return this.store.read(hash);
  }

  async put(hash: string, bytes: Buffer): Promise<{ hash: string; size: number }> {
    this.assertValidHash(hash);
    try {
      const result = await this.store.write(bytes, hash);
      await this.storage.putBlob({
        hash: result.hash,
        size: result.size,
        createdAt: new Date().toISOString(),
      });
      return result;
    } catch (err) {
      if (err instanceof BlobHashMismatchError) {
        throw badRequest('Uploaded bytes do not match the requested hash', {
          expected: err.expected,
          actual: err.actual,
        });
      }
      throw err;
    }
  }
}
