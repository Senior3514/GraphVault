import type { FileState } from '@graphvault/shared';
import type {
  AiConfigRecord,
  AzureConfigRecord,
  BlobRecord,
  ChangesPage,
  DeviceRecord,
  FileChange,
  FileRecord,
  GcsConfigRecord,
  S3ConfigRecord,
  Storage,
  TokenRecord,
  UserRecord,
  VaultRecord,
  WebDavConfigRecord,
} from './types.js';

/**
 * Prisma + PostgreSQL implementation of {@link Storage}.
 *
 * The generated Prisma client is loaded lazily via {@link createPrismaStorage}
 * so the default in-memory path never imports it. This keeps the project
 * building and running in environments where `prisma generate` has not been run
 * (e.g. no live database). The client is typed structurally here to avoid a
 * hard compile-time dependency on the generated module.
 */

// Minimal structural type for the slice of the generated PrismaClient we use.
// Using `any` for delegate args keeps us decoupled from the generated types
// without pulling them into the default build.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface PrismaLike {
  user: any;
  device: any;
  token: any;
  vault: any;
  file: any;
  fileVersion: any;
  revision: any;
  blob: any;
  $transaction<T>(fn: (tx: PrismaLike) => Promise<T>): Promise<T>;
  $disconnect(): Promise<void>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export class PrismaStorage implements Storage {
  constructor(private readonly db: PrismaLike) {}

  /**
   * In-process store for WebDAV configs.
   *
   * A full Prisma implementation would require a `WebDavConfig` table in the
   * schema (add a migration when operationalising this in production). For
   * now, the in-process map is sufficient for single-instance deployments —
   * the data survives for the process lifetime, which is fine because it is
   * re-entered via Settings whenever the server restarts without an
   * GRAPHVAULT_ENCRYPTION_KEY (process-lifetime key). When the server key is
   * configured, credentials should be persisted in a real DB table.
   *
   * TODO(M18-follow-up): add Prisma schema migration for `webdav_configs`.
   */
  private readonly _webdavConfigs = new Map<string, WebDavConfigRecord>();

  /**
   * In-process store for S3 configs.
   *
   * Same trade-off as WebDAV: sufficient for single-instance dev deployments.
   * TODO(M18-follow-up): add Prisma schema migration for `s3_configs`.
   */
  private readonly _s3Configs = new Map<string, S3ConfigRecord>();

  /**
   * In-process store for Azure Blob Storage configs.
   *
   * Same trade-off as WebDAV / S3: sufficient for single-instance dev deployments.
   * TODO(Wave16-follow-up): add Prisma schema migration for `azure_configs`.
   */
  private readonly _azureConfigs = new Map<string, AzureConfigRecord>();

  /**
   * In-process store for Google Cloud Storage configs.
   *
   * Same trade-off as WebDAV / S3.
   * TODO(Wave16-follow-up): add Prisma schema migration for `gcs_configs`.
   */
  private readonly _gcsConfigs = new Map<string, GcsConfigRecord>();

  /**
   * In-process store for AI proxy configs.
   *
   * Same trade-off as WebDAV / S3.
   * TODO(AI-follow-up): add Prisma schema migration for `ai_configs`.
   */
  private readonly _aiConfigs = new Map<string, AiConfigRecord>();

  async createUser(input: {
    id: string;
    email: string;
    passwordHash: string;
  }): Promise<UserRecord> {
    const u = await this.db.user.create({
      data: { id: input.id, email: input.email, passwordHash: input.passwordHash },
    });
    return mapUser(u);
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const u = await this.db.user.findUnique({ where: { email } });
    return u ? mapUser(u) : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const u = await this.db.user.findUnique({ where: { id } });
    return u ? mapUser(u) : null;
  }

  async createDevice(input: { id: string; userId: string; name: string }): Promise<DeviceRecord> {
    const d = await this.db.device.create({
      data: { id: input.id, userId: input.userId, name: input.name },
    });
    return mapDevice(d);
  }

  async getDevice(id: string): Promise<DeviceRecord | null> {
    const d = await this.db.device.findUnique({ where: { id } });
    return d ? mapDevice(d) : null;
  }

  async touchDevice(id: string): Promise<void> {
    await this.db.device.update({ where: { id }, data: { lastSeen: new Date() } });
  }

  async createToken(record: TokenRecord): Promise<void> {
    await this.db.token.create({
      data: {
        tokenHash: record.tokenHash,
        userId: record.userId,
        deviceId: record.deviceId,
        expiresAt: BigInt(record.expiresAt),
      },
    });
  }

  async getToken(tokenHash: string): Promise<TokenRecord | null> {
    const t = await this.db.token.findUnique({ where: { tokenHash } });
    if (!t) return null;
    return {
      tokenHash: t.tokenHash,
      userId: t.userId,
      deviceId: t.deviceId,
      expiresAt: Number(t.expiresAt),
      createdAt: toIso(t.createdAt),
    };
  }

  async createVault(input: { id: string; userId: string; name: string }): Promise<VaultRecord> {
    const v = await this.db.vault.create({
      data: { id: input.id, userId: input.userId, name: input.name },
    });
    return mapVault(v);
  }

  async getVault(id: string): Promise<VaultRecord | null> {
    const v = await this.db.vault.findUnique({ where: { id } });
    return v ? mapVault(v) : null;
  }

  async listVaults(userId: string): Promise<VaultRecord[]> {
    const vs = await this.db.vault.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return vs.map(mapVault);
  }

  async getFile(vaultId: string, path: string): Promise<FileRecord | null> {
    const file = await this.db.file.findUnique({
      where: { vaultId_path: { vaultId, path } },
      include: { currentVersion: true },
    });
    if (!file || !file.currentVersion) return null;
    return { state: mapFileState(path, file.currentVersion) };
  }

  async listChangesSince(vaultId: string, since: number, limit: number): Promise<ChangesPage> {
    const files = await this.db.file.findMany({
      where: { vaultId, currentVersion: { revision: { gt: since } } },
      include: { currentVersion: true },
    });
    const states: FileState[] = files
      .filter((f: { currentVersion: unknown }) => f.currentVersion)
      .map((f: { path: string; currentVersion: VersionRow }) =>
        mapFileState(f.path, f.currentVersion),
      )
      .sort((a: FileState, b: FileState) => a.revision - b.revision);
    return { changes: states.slice(0, limit), hasMore: states.length > limit };
  }

  async commitChanges(vaultId: string, changes: FileChange[]): Promise<number> {
    return this.db.$transaction(async (tx) => {
      const vault = await tx.vault.findUnique({ where: { id: vaultId } });
      if (!vault) throw new Error(`vault not found: ${vaultId}`);
      let head: number = vault.headRevision;

      for (const change of changes) {
        head += 1;
        await tx.revision.create({ data: { vaultId, seq: head } });

        const existing = await tx.file.findUnique({
          where: { vaultId_path: { vaultId, path: change.path } },
        });
        const file = existing
          ? existing
          : await tx.file.create({ data: { vaultId, path: change.path } });

        const version = await tx.fileVersion.create({
          data: {
            fileId: file.id,
            hash: change.hash,
            size: change.size,
            mtime: BigInt(change.mtime),
            deleted: change.deleted,
            revision: head,
          },
        });

        await tx.file.update({
          where: { id: file.id },
          data: { currentVersionId: version.id, isDeleted: change.deleted },
        });
      }

      await tx.vault.update({ where: { id: vaultId }, data: { headRevision: head } });
      return head;
    });
  }

  async hasBlob(hash: string): Promise<boolean> {
    const b = await this.db.blob.findUnique({ where: { hash } });
    return b !== null;
  }

  async putBlob(record: BlobRecord): Promise<void> {
    await this.db.blob.upsert({
      where: { hash: record.hash },
      create: { hash: record.hash, size: record.size },
      update: {},
    });
  }

  // ---- WebDAV config (in-process map; see TODO above) ----

  async getWebDavConfig(userId: string): Promise<WebDavConfigRecord | null> {
    return this._webdavConfigs.get(userId) ?? null;
  }

  async upsertWebDavConfig(record: WebDavConfigRecord): Promise<void> {
    this._webdavConfigs.set(record.userId, { ...record });
  }

  async deleteWebDavConfig(userId: string): Promise<void> {
    this._webdavConfigs.delete(userId);
  }

  // ---- S3 config (in-process map; see TODO above) ----

  async getS3Config(userId: string): Promise<S3ConfigRecord | null> {
    return this._s3Configs.get(userId) ?? null;
  }

  async upsertS3Config(record: S3ConfigRecord): Promise<void> {
    this._s3Configs.set(record.userId, { ...record });
  }

  async deleteS3Config(userId: string): Promise<void> {
    this._s3Configs.delete(userId);
  }

  // ---- Azure Blob Storage config (in-process map; see TODO above) ----

  async getAzureConfig(userId: string): Promise<AzureConfigRecord | null> {
    return this._azureConfigs.get(userId) ?? null;
  }

  async upsertAzureConfig(record: AzureConfigRecord): Promise<void> {
    this._azureConfigs.set(record.userId, { ...record });
  }

  async deleteAzureConfig(userId: string): Promise<void> {
    this._azureConfigs.delete(userId);
  }

  // ---- Google Cloud Storage config (in-process map; see TODO above) ----

  async getGcsConfig(userId: string): Promise<GcsConfigRecord | null> {
    return this._gcsConfigs.get(userId) ?? null;
  }

  async upsertGcsConfig(record: GcsConfigRecord): Promise<void> {
    this._gcsConfigs.set(record.userId, { ...record });
  }

  async deleteGcsConfig(userId: string): Promise<void> {
    this._gcsConfigs.delete(userId);
  }

  // ---- AI proxy config (in-process map; see TODO above) ----

  async getAiConfig(userId: string): Promise<AiConfigRecord | null> {
    return this._aiConfigs.get(userId) ?? null;
  }

  async upsertAiConfig(record: AiConfigRecord): Promise<void> {
    this._aiConfigs.set(record.userId, { ...record });
  }

  async deleteAiConfig(userId: string): Promise<void> {
    this._aiConfigs.delete(userId);
  }
}

interface VersionRow {
  hash: string | null;
  size: number;
  mtime: bigint;
  deleted: boolean;
  revision: number;
}

function mapFileState(path: string, v: VersionRow): FileState {
  return {
    path,
    hash: v.hash,
    size: v.size,
    mtime: Number(v.mtime),
    deleted: v.deleted,
    revision: v.revision,
  };
}

function mapUser(u: {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date | string;
}): UserRecord {
  return { id: u.id, email: u.email, passwordHash: u.passwordHash, createdAt: toIso(u.createdAt) };
}

function mapDevice(d: {
  id: string;
  userId: string;
  name: string;
  createdAt: Date | string;
  lastSeen: Date | string;
}): DeviceRecord {
  return {
    id: d.id,
    userId: d.userId,
    name: d.name,
    createdAt: toIso(d.createdAt),
    lastSeen: toIso(d.lastSeen),
  };
}

function mapVault(v: {
  id: string;
  userId: string;
  name: string;
  headRevision: number;
  createdAt: Date | string;
}): VaultRecord {
  return {
    id: v.id,
    userId: v.userId,
    name: v.name,
    headRevision: v.headRevision,
    createdAt: toIso(v.createdAt),
  };
}

/**
 * Construct a {@link PrismaStorage} by dynamically importing the generated
 * Prisma client. Throws a clear error if the client has not been generated.
 */
export async function createPrismaStorage(databaseUrl: string): Promise<{
  storage: PrismaStorage;
  disconnect: () => Promise<void>;
}> {
  let mod: { PrismaClient: new (opts?: unknown) => PrismaLike };
  try {
    // Generated by `prisma generate` (see prisma/schema.prisma `output`).
    // The specifier is built at runtime so the TypeScript compiler does not
    // try to resolve the (possibly ungenerated) module during the default build.
    const generated = new URL('./generated/prisma/index.js', import.meta.url).href;
    mod = (await import(generated)) as unknown as {
      PrismaClient: new (opts?: unknown) => PrismaLike;
    };
  } catch {
    throw new Error(
      'GRAPHVAULT_STORAGE=postgres requires the generated Prisma client. ' +
        'Run `pnpm --filter @graphvault/server prisma:generate` (with a reachable DATABASE_URL).',
    );
  }
  const client = new mod.PrismaClient({ datasources: { db: { url: databaseUrl } } });
  return {
    storage: new PrismaStorage(client),
    disconnect: () => client.$disconnect(),
  };
}
