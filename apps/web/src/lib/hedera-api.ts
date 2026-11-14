'use client';
import { getApi } from './api';

/** Validates a Hedera Account ID in shard.realm.num format. */
export function validateHederaAccountId(id: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(id);
}

export interface HederaDataSource {
  chain: 'testnet';
  getBalance(): Promise<bigint>;
}

/**
 * Creates a Hedera data source for the given Account ID on Testnet.
 * Balance is returned as bigint tinybars.
 */
export function createHederaDataSource(accountId: string): HederaDataSource {
  return {
    chain: 'testnet',

    async getBalance(): Promise<bigint> {
      const api = await getApi();
      const result = await api.hederaBalance(accountId);
      return BigInt(result.tinybars);
    },
  };
}
