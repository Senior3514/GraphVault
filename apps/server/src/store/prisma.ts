import type { FileState } from '@graphvault/shared';
import type {
  AiConfigRecord,
  AiSpendWindowRecord,
  AzureConfigRecord,
  BlobRecord,
  ChangesPage,
  DeviceRecord,
  FileChange,
  FileRecord,
  GcsConfigRecord,
  InboxAuditRecord,
  InboxTokenRecord,
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
  webDavConfig: any;
  s3Config: any;
  azureConfig: any;
  gcsConfig: any;
  aiConfig: any;
  aiSpendWindow: any;
  inboxToken: any;
  inboxAuditEntry: any;
  $transaction<T>(fn: (tx: PrismaLike) => Promise<T>): Promise<T>;
  $disconnect(): Promise<void>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export class PrismaStorage implements Storage {
  constructor(private readonly db: PrismaLike) {}

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

  // ---- WebDAV config ----

  async getWebDavConfig(userId: string): Promise<WebDavConfigRecord | null> {
    const row = await this.db.webDavConfig.findUnique({ where: { userId } });
    if (!row) return null;
    return {
      userId: row.userId,
      url: row.url,
      username: row.username,
      encryptedPassword: row.encryptedPassword,
      updatedAt: toIso(row.updatedAt),
    };
  }

  async upsertWebDavConfig(record: WebDavConfigRecord): Promise<void> {
    const data = {
      url: record.url,
      username: record.username,
      encryptedPassword: record.encryptedPassword,
    };
    await this.db.webDavConfig.upsert({
      where: { userId: record.userId },
      create: { userId: record.userId, ...data },
      update: data,
    });
  }

  async deleteWebDavConfig(userId: string): Promise<void> {
    await this.db.webDavConfig.deleteMany({ where: { userId } });
  }

  // ---- S3 config ----

  async getS3Config(userId: string): Promise<S3ConfigRecord | null> {
    const row = await this.db.s3Config.findUnique({ where: { userId } });
    if (!row) return null;
    return {
      userId: row.userId,
      endpoint: row.endpoint ?? undefined,
      region: row.region,
      bucket: row.bucket,
      accessKeyId: row.accessKeyId,
      encryptedSecretAccessKey: row.encryptedSecretAccessKey,
      prefix: row.prefix ?? undefined,
      updatedAt: toIso(row.updatedAt),
    };
  }

  async upsertS3Config(record: S3ConfigRecord): Promise<void> {
    const data = {
      endpoint: record.endpoint ?? null,
      region: record.region,
      bucket: record.bucket,
      accessKeyId: record.accessKeyId,
      encryptedSecretAccessKey: record.encryptedSecretAccessKey,
      prefix: record.prefix ?? null,
    };
    await this.db.s3Config.upsert({
      where: { userId: record.userId },
      create: { userId: record.userId, ...data },
      update: data,
    });
  }

  async deleteS3Config(userId: string): Promise<void> {
    await this.db.s3Config.deleteMany({ where: { userId } });
  }

  // ---- Azure Blob Storage config ----

  async getAzureConfig(userId: string): Promise<AzureConfigRecord | null> {
    const row = await this.db.azureConfig.findUnique({ where: { userId } });
    if (!row) return null;
    return {
      userId: row.userId,
      account: row.account,
      container: row.container,
      encryptedAccountKey: row.encryptedAccountKey,
      endpoint: row.endpoint ?? undefined,
      updatedAt: toIso(row.updatedAt),
    };
  }

  async upsertAzureConfig(record: AzureConfigRecord): Promise<void> {
    const data = {
      account: record.account,
      container: record.container,
      encryptedAccountKey: record.encryptedAccountKey,
      endpoint: record.endpoint ?? null,
    };
    await this.db.azureConfig.upsert({
      where: { userId: record.userId },
      create: { userId: record.userId, ...data },
      update: data,
    });
  }

  async deleteAzureConfig(userId: string): Promise<void> {
    await this.db.azureConfig.deleteMany({ where: { userId } });
  }

  // ---- Google Cloud Storage config ----

  async getGcsConfig(userId: string): Promise<GcsConfigRecord | null> {
    const row = await this.db.gcsConfig.findUnique({ where: { userId } });
    if (!row) return null;
    return {
      userId: row.userId,
      bucket: row.bucket,
      accessId: row.accessId,
      encryptedSecret: row.encryptedSecret,
      prefix: row.prefix ?? undefined,
      updatedAt: toIso(row.updatedAt),
    };
  }

  async upsertGcsConfig(record: GcsConfigRecord): Promise<void> {
    const data = {
      bucket: record.bucket,
      accessId: record.accessId,
      encryptedSecret: record.encryptedSecret,
      prefix: record.prefix ?? null,
    };
    await this.db.gcsConfig.upsert({
      where: { userId: record.userId },
      create: { userId: record.userId, ...data },
      update: data,
    });
  }

  async deleteGcsConfig(userId: string): Promise<void> {
    await this.db.gcsConfig.deleteMany({ where: { userId } });
  }

  // ---- AI proxy config ----

  async getAiConfig(userId: string): Promise<AiConfigRecord | null> {
    const row = await this.db.aiConfig.findUnique({ where: { userId } });
    if (!row) return null;
    return {
      userId: row.userId,
      encryptedApiKey: row.encryptedApiKey,
      gateway: row.gateway as AiConfigRecord['gateway'],
      baseUrl: row.baseUrl ?? undefined,
      model: row.model ?? undefined,
      spendCapUsd: row.spendCapUsd ?? undefined,
      dailyRequestCap: row.dailyRequestCap ?? undefined,
      updatedAt: toIso(row.updatedAt),
    };
  }

  async upsertAiConfig(record: AiConfigRecord): Promise<void> {
    const data = {
      encryptedApiKey: record.encryptedApiKey,
      gateway: record.gateway,
      baseUrl: record.baseUrl ?? null,
      model: record.model ?? null,
      spendCapUsd: record.spendCapUsd ?? null,
      dailyRequestCap: record.dailyRequestCap ?? null,
    };
    await this.db.aiConfig.upsert({
      where: { userId: record.userId },
      create: { userId: record.userId, ...data },
      update: data,
    });
  }

  async deleteAiConfig(userId: string): Promise<void> {
    await this.db.aiConfig.deleteMany({ where: { userId } });
  }

  // ---- AI durable spend/request window ----

  async getAiSpendWindow(userId: string): Promise<AiSpendWindowRecord | null> {
    const row = await this.db.aiSpendWindow.findUnique({ where: { userId } });
    return row ? mapAiSpendWindow(row) : null;
  }

  async commitAiSpend(
    userId: string,
    addUsd: number,
    addRequests: number,
    today: string,
  ): Promise<AiSpendWindowRecord> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.aiSpendWindow.findUnique({ where: { userId } });
      // Lazy reset: a window from a previous day starts fresh.
      const base =
        existing && existing.windowDate === today
          ? { requests: existing.requests as number, spentUsd: existing.spentUsd as number }
          : { requests: 0, spentUsd: 0 };
      const data = {
        windowDate: today,
        requests: base.requests + addRequests,
        spentUsd: base.spentUsd + addUsd,
      };
      const row = await tx.aiSpendWindow.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });
      return mapAiSpendWindow(row);
    });
  }

  // ---- inbox tokens ----

  async createInboxToken(record: InboxTokenRecord): Promise<void> {
    await this.db.inboxToken.create({
      data: {
        id: record.id,
        userId: record.userId,
        vaultId: record.vaultId,
        label: record.label,
        tokenHash: record.tokenHash,
        createdAt: new Date(record.createdAt),
        lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt) : null,
      },
    });
  }

  async getInboxTokenByHash(tokenHash: string): Promise<InboxTokenRecord | null> {
    const row = await this.db.inboxToken.findUnique({ where: { tokenHash } });
    return row ? mapInboxToken(row) : null;
  }

  async listInboxTokens(userId: string): Promise<InboxTokenRecord[]> {
    const rows = await this.db.inboxToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(mapInboxToken);
  }

  async touchInboxToken(tokenHash: string, lastUsedAt: string): Promise<void> {
    await this.db.inboxToken.updateMany({
      where: { tokenHash },
      data: { lastUsedAt: new Date(lastUsedAt) },
    });
  }

  async deleteInboxToken(userId: string, tokenId: string): Promise<boolean> {
    const result = await this.db.inboxToken.deleteMany({ where: { id: tokenId, userId } });
    return result.count > 0;
  }

  // ---- inbox audit log (capped per user, oldest evicted) ----

  async appendInboxAudit(record: InboxAuditRecord, cap: number): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.inboxAuditEntry.create({
        data: {
          id: record.id,
          userId: record.userId,
          tokenId: record.tokenId,
          source: record.source,
          path: record.path,
          bytes: record.bytes,
          status: record.status,
          at: new Date(record.at),
        },
      });
      // Enforce the per-user cap: keep the newest `cap` entries, delete the rest.
      const overflow = await tx.inboxAuditEntry.findMany({
        where: { userId: record.userId },
        orderBy: { at: 'desc' },
        skip: cap,
        select: { id: true },
      });
      if (overflow.length > 0) {
        await tx.inboxAuditEntry.deleteMany({
          where: { id: { in: overflow.map((e: { id: string }) => e.id) } },
        });
      }
    });
  }

  async listInboxAudit(userId: string): Promise<InboxAuditRecord[]> {
    const rows = await this.db.inboxAuditEntry.findMany({
      where: { userId },
      orderBy: { at: 'desc' },
    });
    return rows.map(mapInboxAudit);
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

function mapAiSpendWindow(row: {
  userId: string;
  windowDate: string;
  requests: number;
  spentUsd: number;
  updatedAt: Date | string;
}): AiSpendWindowRecord {
  return {
    userId: row.userId,
    windowDate: row.windowDate,
    requests: row.requests,
    spentUsd: row.spentUsd,
    updatedAt: toIso(row.updatedAt),
  };
}

function mapInboxToken(row: {
  id: string;
  userId: string;
  vaultId: string;
  label: string;
  tokenHash: string;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
}): InboxTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    vaultId: row.vaultId,
    label: row.label,
    tokenHash: row.tokenHash,
    createdAt: toIso(row.createdAt),
    lastUsedAt: row.lastUsedAt ? toIso(row.lastUsedAt) : null,
  };
}

function mapInboxAudit(row: {
  id: string;
  userId: string;
  tokenId: string;
  source: string;
  path: string | null;
  bytes: number;
  status: string;
  at: Date | string;
}): InboxAuditRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenId: row.tokenId,
    source: row.source,
    path: row.path,
    bytes: row.bytes,
    status: row.status as InboxAuditRecord['status'],
    at: toIso(row.at),
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
