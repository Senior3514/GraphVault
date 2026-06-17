import { mkdir, readFile, readdir, rename, writeFile, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stored graph snapshot. `data` is an OPAQUE, already-encoded string the web
 * client produced (gzip+base64url of a graph JSON). The server never parses or
 * executes it beyond size validation; it is stored and returned verbatim.
 */
export interface SnapshotRecord {
  id: string;
  data: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/**
 * Snapshot id format: URL-safe base64url, 16–32 chars. Validated on every read
 * so an id can never be used for path traversal or to escape the store dir.
 */
export const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9_-]{16,32}$/;

export function isValidSnapshotId(id: string): boolean {
  return SNAPSHOT_ID_PATTERN.test(id);
}

/**
 * Storage interface for the snapshot store. Two implementations exist: a disk
 * store (production, modeled on {@link DiskBlobStore}) and an in-memory store
 * (injected by unit tests). Decoupled from Fastify and the rest of the app.
 */
export interface SnapshotStore {
  /** Persist a record (id is already generated + validated by the caller). */
  put(record: SnapshotRecord): Promise<void>;
  /** Read a record by id, or null if absent. Does NOT apply TTL. */
  get(id: string): Promise<SnapshotRecord | null>;
  /** Delete a record by id. No-op if absent. */
  delete(id: string): Promise<void>;
  /** Current number of stored records. */
  count(): Promise<number>;
  /**
   * List record ids and their createdAt timestamps, oldest-first. Used for TTL
   * sweeping and oldest-first eviction.
   */
  listByAge(): Promise<{ id: string; createdAt: string }[]>;
}

/**
 * Snapshot storage on disk.
 *
 * Each snapshot is one JSON file at `<dataDir>/snapshots/<id>.json` holding the
 * full {@link SnapshotRecord}. The id is validated against
 * {@link SNAPSHOT_ID_PATTERN} before any path is built, so a hostile id can
 * never traverse out of the store directory. Writes go to a temp file then
 * atomically rename into place so a reader never sees a partial file.
 */
export class DiskSnapshotStore implements SnapshotStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'snapshots');
  }

  private pathFor(id: string): string {
    if (!isValidSnapshotId(id)) {
      // Defense in depth: callers validate, but never build a path from an
      // unvalidated id.
      throw new Error('invalid snapshot id');
    }
    return join(this.root, `${id}.json`);
  }

  async put(record: SnapshotRecord): Promise<void> {
    const dest = this.pathFor(record.id);
    await mkdir(this.root, { recursive: true });
    const tmp = join(
      tmpdir(),
      `gv-snapshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    await writeFile(tmp, bytes);
    try {
      await rename(tmp, dest);
    } catch (err) {
      // Cross-device rename fallback: copy then drop the temp.
      await writeFile(dest, bytes);
      await unlink(tmp).catch(() => undefined);
      void err;
    }
  }

  async get(id: string): Promise<SnapshotRecord | null> {
    if (!isValidSnapshotId(id)) return null;
    let raw: Buffer;
    try {
      raw = await readFile(this.pathFor(id));
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as SnapshotRecord;
      if (typeof parsed.id !== 'string' || typeof parsed.data !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    if (!isValidSnapshotId(id)) return;
    await unlink(this.pathFor(id)).catch(() => undefined);
  }

  private async ids(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter(isValidSnapshotId);
  }

  async count(): Promise<number> {
    return (await this.ids()).length;
  }

  async listByAge(): Promise<{ id: string; createdAt: string }[]> {
    const ids = await this.ids();
    const records: { id: string; createdAt: string }[] = [];
    for (const id of ids) {
      try {
        const raw = await readFile(this.pathFor(id), 'utf8');
        const parsed = JSON.parse(raw) as SnapshotRecord;
        const createdAt =
          typeof parsed.createdAt === 'string'
            ? parsed.createdAt
            : (await stat(this.pathFor(id))).mtime.toISOString();
        records.push({ id, createdAt });
      } catch {
        // Unreadable file: skip (it won't be returned by get() either).
      }
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return records;
  }
}

/**
 * In-memory snapshot store for tests. Same contract as {@link DiskSnapshotStore}
 * with no disk dependency.
 */
export class InMemorySnapshotStore implements SnapshotStore {
  private readonly records = new Map<string, SnapshotRecord>();

  async put(record: SnapshotRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async get(id: string): Promise<SnapshotRecord | null> {
    if (!isValidSnapshotId(id)) return null;
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async count(): Promise<number> {
    return this.records.size;
  }

  async listByAge(): Promise<{ id: string; createdAt: string }[]> {
    return [...this.records.values()]
      .map((r) => ({ id: r.id, createdAt: r.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
