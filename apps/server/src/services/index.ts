import type { Storage } from '../store/types.js';
import { DiskBlobStore } from '../store/blob-store.js';
import { DiskSnapshotStore, type SnapshotStore } from '../store/snapshot-store.js';
import { AiService } from './ai.js';
import { AuthService } from './auth.js';
import { BlobService } from './blob.js';
import { ClipService } from './clip.js';
import { InboxService, type InboxServiceOptions } from './inbox.js';
import { AzureService } from './azure.js';
import { GcsService } from './gcs.js';
import { S3Service } from './s3.js';
import { SnapshotService, type SnapshotServiceOptions } from './snapshot.js';
import { SyncService } from './sync.js';
import { VaultService } from './vault.js';
import { WebDavService } from './webdav.js';

export { AiService } from './ai.js';
export { AuthService } from './auth.js';
export type { AuthContext } from './auth.js';
export { VaultService } from './vault.js';
export { SyncService } from './sync.js';
export { BlobService } from './blob.js';
export { WebDavService } from './webdav.js';
export { S3Service } from './s3.js';
export { AzureService } from './azure.js';
export { GcsService } from './gcs.js';
export { ClipService } from './clip.js';
export { InboxService } from './inbox.js';
export { SnapshotService } from './snapshot.js';

/** The service layer container, decoupled from Fastify and reusable. */
export interface Services {
  auth: AuthService;
  vault: VaultService;
  sync: SyncService;
  blob: BlobService;
  webdav: WebDavService;
  s3: S3Service;
  azure: AzureService;
  gcs: GcsService;
  clip: ClipService;
  ai: AiService;
  /**
   * Public graph-snapshot store. Only constructed when the feature is enabled;
   * undefined (and routes unregistered) when off so it's invisible by default.
   */
  snapshot?: SnapshotService;
  /**
   * "Connect anything" inbound webhook. Only constructed when enabled; undefined
   * (and routes unregistered) when off so `/v1/inbox*` is invisible.
   */
  inbox?: InboxService;
}

export interface CreateServicesOptions {
  encryptionKey?: Buffer;
  aiDailyCap?: number;
  /**
   * When provided, the public snapshot store is enabled and constructed. Omit to
   * leave the feature off (no snapshot service, routes unregistered).
   */
  snapshots?: SnapshotServiceOptions;
  /** Inject a snapshot store (tests use an in-memory one). Defaults to disk. */
  snapshotStore?: SnapshotStore;
  /**
   * When provided, the inbound webhook ("connect anything") is enabled and
   * constructed. Omit to leave the feature off (no inbox service, routes
   * unregistered).
   */
  inbox?: InboxServiceOptions;
}

export function createServices(
  storage: Storage,
  dataDir: string,
  options: CreateServicesOptions = {},
): Services {
  const { encryptionKey, aiDailyCap, snapshots, snapshotStore, inbox } = options;
  const blobStore = new DiskBlobStore(dataDir, encryptionKey);
  const services: Services = {
    auth: new AuthService(storage),
    vault: new VaultService(storage),
    sync: new SyncService(storage, blobStore),
    blob: new BlobService(storage, blobStore),
    webdav: new WebDavService(storage, encryptionKey),
    s3: new S3Service(storage, encryptionKey),
    azure: new AzureService(storage, encryptionKey),
    gcs: new GcsService(storage, encryptionKey),
    clip: new ClipService(),
    ai: new AiService(storage, encryptionKey, aiDailyCap),
  };
  if (snapshots) {
    const store = snapshotStore ?? new DiskSnapshotStore(dataDir);
    services.snapshot = new SnapshotService(store, snapshots);
  }
  if (inbox) {
    services.inbox = new InboxService(storage, services.vault, services.sync, services.blob, inbox);
  }
  return services;
}
