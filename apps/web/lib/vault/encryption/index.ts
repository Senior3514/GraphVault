/**
 * Barrel export for the vault encryption module.
 */

export {
  EncryptedVaultStore,
  VaultDecryptionError,
  isVaultEncryptedSentinel,
  ENCRYPTION_SENTINEL_KEY,
  type RawStorage,
} from './EncryptedVaultStore';

export { migrateAdapter, type MigrationResult } from './migrationHelper';
