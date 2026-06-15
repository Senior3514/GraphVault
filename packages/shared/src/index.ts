/**
 * @graphvault/shared
 *
 * Shared types, validation schemas, and utilities used across the
 * GraphVault server, web client, and desktop client.
 *
 * The sync-protocol types in `./sync` are the canonical wire format and
 * mirror the spec in `docs/sync-protocol.md`.
 */

export const GRAPHVAULT_API_VERSION = 'v1' as const;
export const SYNC_PROTOCOL_VERSION = 1 as const;

export * from './auth.js';
export * from './sync/index.js';
export * from './util/hash.js';
export * from './webdav.js';
export * from './s3.js';
export * from './clip.js';
export * from './ai.js';
