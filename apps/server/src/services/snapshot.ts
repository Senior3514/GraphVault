import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, badRequest, notFound } from '../errors.js';
import {
  isValidSnapshotId,
  type SnapshotRecord,
  type SnapshotStore,
} from '../store/snapshot-store.js';

/** What `GET /v1/snapshots/:id` returns to the public. */
export interface SnapshotView {
  id: string;
  data: string;
  createdAt: string;
}

/** What `POST /v1/snapshots` returns: the short id plus a one-time delete token. */
export interface SnapshotCreated {
  id: string;
  deleteToken: string;
}

export interface SnapshotServiceOptions {
  maxBytes: number;
  maxCount: number;
  /** TTL in days; 0 = no expiry. */
  ttlDays: number;
  /**
   * Injectable clock (ms since epoch) so tests can age entries deterministically.
   * Defaults to `Date.now`.
   */
  now?: () => number;
}

/**
 * Public, opt-in graph-snapshot store (Wave 18).
 *
 * Snapshots are unauthenticated, read-only shares: anyone with the short id can
 * read the snapshot. The payload (`data`) is an OPAQUE, already-encoded string
 * (gzip+base64url of a graph JSON) the web client produced; the server treats it
 * as opaque text and never parses or executes it beyond size validation.
 *
 * Abuse resistance:
 *  - payload size is capped (`maxBytes`) - oversize is rejected (413);
 *  - total count is capped (`maxCount`) with oldest-first eviction so disk can't
 *    grow unbounded;
 *  - entries expire after `ttlDays` (swept on read) so stale shares disappear;
 *  - DELETE requires a `deleteToken` returned (only) from POST, so a third party
 *    who only knows the share id cannot delete (or grief) someone else's
 *    snapshot. The token is stored hashed; we never persist it in the clear.
 */
export class SnapshotService {
  private readonly maxBytes: number;
  private readonly maxCount: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: SnapshotStore,
    options: SnapshotServiceOptions,
  ) {
    this.maxBytes = options.maxBytes;
    this.maxCount = options.maxCount;
    this.ttlMs = options.ttlDays > 0 ? options.ttlDays * 24 * 60 * 60 * 1000 : 0;
    this.now = options.now ?? Date.now;
  }

  /** Generate a URL-safe id: 16 random bytes → ~22 base64url chars. */
  private generateId(): string {
    return randomBytes(16).toString('base64url');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** True when a record created at `createdAt` has expired under the TTL. */
  private isExpired(createdAt: string): boolean {
    if (this.ttlMs === 0) return false;
    const created = Date.parse(createdAt);
    if (Number.isNaN(created)) return false;
    return this.now() - created > this.ttlMs;
  }

  /**
   * Create a snapshot from an opaque encoded `data` string. Rejects empty (400)
   * and oversize (413) payloads. Returns the short id and a delete token.
   */
  async create(data: string): Promise<SnapshotCreated> {
    if (typeof data !== 'string' || data.length === 0) {
      throw badRequest('Snapshot data must be a non-empty string');
    }
    // Cap on the encoded byte length (UTF-8), not the JS string length.
    const byteLength = Buffer.byteLength(data, 'utf8');
    if (byteLength > this.maxBytes) {
      throw new AppError(
        413,
        'PAYLOAD_TOO_LARGE',
        `Snapshot exceeds the ${this.maxBytes}-byte limit`,
      );
    }

    // Enforce the count cap with oldest-first eviction BEFORE inserting, so the
    // store never exceeds maxCount. Sweep expired entries opportunistically too.
    await this.evictForCapacity();

    const deleteToken = randomBytes(24).toString('base64url');
    const id = this.generateId();
    const record: SnapshotRecord & { deleteTokenHash: string } = {
      id,
      data,
      createdAt: new Date(this.now()).toISOString(),
      deleteTokenHash: this.hashToken(deleteToken),
    };
    await this.store.put(record);
    return { id, deleteToken };
  }

  /**
   * Read a snapshot by id. Validates the id format (path-traversal guard),
   * returns null for unknown or expired entries (expired ones are swept).
   */
  async get(id: string): Promise<SnapshotView | null> {
    if (!isValidSnapshotId(id)) return null;
    const record = await this.store.get(id);
    if (!record) return null;
    if (this.isExpired(record.createdAt)) {
      await this.store.delete(id);
      return null;
    }
    return { id: record.id, data: record.data, createdAt: record.createdAt };
  }

  /**
   * Delete a snapshot. Requires the `deleteToken` returned from `create`. A
   * wrong/missing token → 403; an unknown id → 404. Token comparison is
   * constant-time. Records created before delete tokens existed (none, in this
   * release) would be undeletable, which is the safe failure mode.
   */
  async delete(id: string, deleteToken: string): Promise<void> {
    if (!isValidSnapshotId(id)) throw notFound('Snapshot not found');
    const record = (await this.store.get(id)) as
      | (SnapshotRecord & {
          deleteTokenHash?: string;
        })
      | null;
    if (!record || this.isExpired(record.createdAt)) {
      // Sweep an expired record if present, then report not-found.
      if (record) await this.store.delete(id);
      throw notFound('Snapshot not found');
    }
    const provided = typeof deleteToken === 'string' ? deleteToken : '';
    if (!record.deleteTokenHash || !this.tokenMatches(record.deleteTokenHash, provided)) {
      throw new AppError(403, 'FORBIDDEN', 'Invalid delete token');
    }
    await this.store.delete(id);
  }

  private tokenMatches(storedHash: string, provided: string): boolean {
    const providedHash = this.hashToken(provided);
    const a = Buffer.from(storedHash, 'hex');
    const b = Buffer.from(providedHash, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Sweep expired entries, then evict oldest-first until the store is below
   * `maxCount` (leaving room for one new insert).
   */
  private async evictForCapacity(): Promise<void> {
    const byAge = await this.store.listByAge();
    // 1. Sweep expired entries.
    const live: { id: string; createdAt: string }[] = [];
    for (const entry of byAge) {
      if (this.isExpired(entry.createdAt)) {
        await this.store.delete(entry.id);
      } else {
        live.push(entry);
      }
    }
    // 2. Oldest-first eviction so that after inserting one more we stay <= maxCount.
    //    `live` is already sorted oldest-first by the store.
    const surplus = live.length - (this.maxCount - 1);
    if (surplus > 0) {
      for (const entry of live.slice(0, surplus)) {
        await this.store.delete(entry.id);
      }
    }
  }
}
