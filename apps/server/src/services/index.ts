import type { Storage } from '../store/types.js';
import { DiskBlobStore } from '../store/blob-store.js';
import { AuthService } from './auth.js';
import { BlobService } from './blob.js';
import { SyncService } from './sync.js';
import { VaultService } from './vault.js';

export { AuthService } from './auth.js';
export type { AuthContext } from './auth.js';
export { VaultService } from './vault.js';
export { SyncService } from './sync.js';
export { BlobService } from './blob.js';

/** The service layer container, decoupled from Fastify and reusable. */
export interface Services {
  auth: AuthService;
  vault: VaultService;
  sync: SyncService;
  blob: BlobService;
}

export function createServices(
  storage: Storage,
  dataDir: string,
  encryptionKey?: Buffer,
): Services {
  const blobStore = new DiskBlobStore(dataDir, encryptionKey);
  return {
    auth: new AuthService(storage),
    vault: new VaultService(storage),
    sync: new SyncService(storage, blobStore),
    blob: new BlobService(storage, blobStore),
  };
}
