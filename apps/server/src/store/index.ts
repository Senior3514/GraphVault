import type { ServerConfig } from '../config.js';
import { InMemoryStorage } from './memory.js';
import type { Storage } from './types.js';

export * from './types.js';
export { InMemoryStorage } from './memory.js';
export { DiskBlobStore } from './blob-store.js';

export interface StorageHandle {
  storage: Storage;
  /** Release any underlying resources (DB connections). No-op for memory. */
  close: () => Promise<void>;
}

/**
 * Build the configured {@link Storage} backend. The Prisma/PostgreSQL adapter
 * is loaded via dynamic import so the default in-memory path never requires the
 * generated Prisma client to be present.
 */
export async function createStorage(config: ServerConfig): Promise<StorageHandle> {
  if (config.storage === 'postgres') {
    if (!config.databaseUrl) {
      throw new Error('GRAPHVAULT_STORAGE=postgres requires DATABASE_URL to be set');
    }
    const { createPrismaStorage } = await import('./prisma.js');
    const { storage, disconnect } = await createPrismaStorage(config.databaseUrl);
    return { storage, close: disconnect };
  }

  return { storage: new InMemoryStorage(), close: async () => undefined };
}
