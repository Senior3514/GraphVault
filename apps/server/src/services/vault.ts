import type { RegisterVaultResponse, VaultRef } from '@graphvault/shared';
import { forbidden, notFound } from '../errors.js';
import type { Storage, VaultRecord } from '../store/types.js';
import { newId } from './crypto.js';

export class VaultService {
  constructor(private readonly storage: Storage) {}

  async create(userId: string, name: string): Promise<RegisterVaultResponse> {
    const vault = await this.storage.createVault({ id: newId(), userId, name });
    return { vaultId: vault.id, name: vault.name, revision: vault.headRevision };
  }

  async list(userId: string): Promise<VaultRef[]> {
    const vaults = await this.storage.listVaults(userId);
    return vaults.map((v) => ({ id: v.id, name: v.name }));
  }

  /**
   * Fetch a vault and assert the user owns it. Returns 404 if it does not
   * exist, 403 if it exists but belongs to someone else.
   */
  async requireOwned(userId: string, vaultId: string): Promise<VaultRecord> {
    const vault = await this.storage.getVault(vaultId);
    if (!vault) throw notFound('Vault not found');
    if (vault.userId !== userId) throw forbidden('You do not own this vault');
    return vault;
  }
}
