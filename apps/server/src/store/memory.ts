import type { FileState } from '@graphvault/shared';
import type {
  AiConfigRecord,
  BlobRecord,
  ChangesPage,
  DeviceRecord,
  FileChange,
  FileRecord,
  S3ConfigRecord,
  Storage,
  TokenRecord,
  UserRecord,
  VaultRecord,
  WebDavConfigRecord,
} from './types.js';

/**
 * In-memory {@link Storage} implementation. Primary backend for development and
 * tests; data is lost on restart. All operations are synchronous under the hood
 * but presented as async to match the interface, and the single-threaded Node
 * event loop gives us atomicity for {@link commitChanges} for free.
 */
export class InMemoryStorage implements Storage {
  private readonly users = new Map<string, UserRecord>();
  private readonly usersByEmail = new Map<string, string>(); // lowercased email -> id
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly vaults = new Map<string, VaultRecord>();
  /** vaultId -> (path -> file state). */
  private readonly files = new Map<string, Map<string, FileState>>();
  private readonly blobs = new Map<string, BlobRecord>();
  private readonly webdavConfigs = new Map<string, WebDavConfigRecord>();
  private readonly s3Configs = new Map<string, S3ConfigRecord>();
  private readonly aiConfigs = new Map<string, AiConfigRecord>();

  private static now(): string {
    return new Date().toISOString();
  }

  async createUser(input: {
    id: string;
    email: string;
    passwordHash: string;
  }): Promise<UserRecord> {
    const record: UserRecord = {
      id: input.id,
      email: input.email,
      passwordHash: input.passwordHash,
      createdAt: InMemoryStorage.now(),
    };
    this.users.set(record.id, record);
    this.usersByEmail.set(input.email.toLowerCase(), record.id);
    return record;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const id = this.usersByEmail.get(email.toLowerCase());
    return id ? (this.users.get(id) ?? null) : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async createDevice(input: { id: string; userId: string; name: string }): Promise<DeviceRecord> {
    const now = InMemoryStorage.now();
    const record: DeviceRecord = {
      id: input.id,
      userId: input.userId,
      name: input.name,
      createdAt: now,
      lastSeen: now,
    };
    this.devices.set(record.id, record);
    return record;
  }

  async getDevice(id: string): Promise<DeviceRecord | null> {
    return this.devices.get(id) ?? null;
  }

  async touchDevice(id: string): Promise<void> {
    const device = this.devices.get(id);
    if (device) device.lastSeen = InMemoryStorage.now();
  }

  async createToken(record: TokenRecord): Promise<void> {
    this.tokens.set(record.tokenHash, record);
  }

  async getToken(tokenHash: string): Promise<TokenRecord | null> {
    return this.tokens.get(tokenHash) ?? null;
  }

  async createVault(input: { id: string; userId: string; name: string }): Promise<VaultRecord> {
    const record: VaultRecord = {
      id: input.id,
      userId: input.userId,
      name: input.name,
      headRevision: 0,
      createdAt: InMemoryStorage.now(),
    };
    this.vaults.set(record.id, record);
    this.files.set(record.id, new Map());
    return record;
  }

  async getVault(id: string): Promise<VaultRecord | null> {
    return this.vaults.get(id) ?? null;
  }

  async listVaults(userId: string): Promise<VaultRecord[]> {
    return [...this.vaults.values()]
      .filter((v) => v.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getFile(vaultId: string, path: string): Promise<FileRecord | null> {
    const state = this.files.get(vaultId)?.get(path);
    return state ? { state: { ...state } } : null;
  }

  async listChangesSince(vaultId: string, since: number, limit: number): Promise<ChangesPage> {
    const states = [...(this.files.get(vaultId)?.values() ?? [])]
      .filter((s) => s.revision > since)
      .sort((a, b) => a.revision - b.revision);
    const page = states.slice(0, limit).map((s) => ({ ...s }));
    return { changes: page, hasMore: states.length > limit };
  }

  async commitChanges(vaultId: string, changes: FileChange[]): Promise<number> {
    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error(`vault not found: ${vaultId}`);
    const fileMap = this.files.get(vaultId);
    if (!fileMap) throw new Error(`vault files not initialised: ${vaultId}`);

    let head = vault.headRevision;
    for (const change of changes) {
      head += 1;
      const state: FileState = {
        path: change.path,
        hash: change.hash,
        size: change.size,
        mtime: change.mtime,
        deleted: change.deleted,
        revision: head,
      };
      fileMap.set(change.path, state);
    }
    vault.headRevision = head;
    return head;
  }

  async hasBlob(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }

  async putBlob(record: BlobRecord): Promise<void> {
    if (!this.blobs.has(record.hash)) this.blobs.set(record.hash, record);
  }

  async getWebDavConfig(userId: string): Promise<WebDavConfigRecord | null> {
    return this.webdavConfigs.get(userId) ?? null;
  }

  async upsertWebDavConfig(record: WebDavConfigRecord): Promise<void> {
    this.webdavConfigs.set(record.userId, { ...record });
  }

  async deleteWebDavConfig(userId: string): Promise<void> {
    this.webdavConfigs.delete(userId);
  }

  async getS3Config(userId: string): Promise<S3ConfigRecord | null> {
    return this.s3Configs.get(userId) ?? null;
  }

  async upsertS3Config(record: S3ConfigRecord): Promise<void> {
    this.s3Configs.set(record.userId, { ...record });
  }

  async deleteS3Config(userId: string): Promise<void> {
    this.s3Configs.delete(userId);
  }

  async getAiConfig(userId: string): Promise<AiConfigRecord | null> {
    return this.aiConfigs.get(userId) ?? null;
  }

  async upsertAiConfig(record: AiConfigRecord): Promise<void> {
    this.aiConfigs.set(record.userId, { ...record });
  }

  async deleteAiConfig(userId: string): Promise<void> {
    this.aiConfigs.delete(userId);
  }
}
