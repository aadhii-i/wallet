'use client';
import {
  nativeAsset,
  WalletError,
  type BlockchainAdapter,
  type HederaNetwork,
  type Page,
  type ReviewSummary,
  type SignedTx,
  type TransferIntent,
  type TxLookup,
  type FeeOption,
  type FeeQuote,
  type Asset,
  type AddressValidation,
} from '@qd/blockchain';
import type { ActivityItem } from '@qd/shared-types';
import { getApi } from './api';

/** Validates a Hedera Account ID in shard.realm.num format. */
export function validateHederaAccountId(id: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(id);
}

/**
 * A single Hedera transaction activity entry, classified relative to the
 * queried account. Mirrors `ApiHederaActivityItem` from `@qd/shared-types` (and
 * the Go `HederaActivityItem`); amounts are tinybars (1 HBAR = 100,000,000) and
 * the backend supplies the pre-formatted `hbar` display string, so no
 * floating-point conversion is needed client-side.
 */
export interface HederaActivityItem {
  transactionId: string;
  timestamp: string;
  type: string;
  direction: 'in' | 'out' | 'self';
  from: string;
  to: string;
  amountTinybars: number;
  hbar: string;
  feeTinybars: number;
  status: 'confirmed' | 'failed';
  networkId: string;
}

export interface HederaDataSource {
  chain: 'testnet';
  getBalance(): Promise<bigint>;
  getHistory(cursor?: string): Promise<{ items: HederaActivityItem[]; nextCursor?: string }>;
}

/**
 * Creates a Hedera data source for the given Account ID on Testnet.
 * Balance is returned as bigint tinybars; history items are passed through with
 * the backend's HBAR display string intact.
 */
export function createHederaDataSource(accountId: string): HederaDataSource {
  return {
    chain: 'testnet',

    async getBalance(): Promise<bigint> {
      const api = await getApi();
      const result = await api.hederaBalance(accountId);
      return BigInt(result.tinybars);
    },

    async getHistory(cursor?: string): Promise<{ items: HederaActivityItem[]; nextCursor?: string }> {
      const api = await getApi();
      const res = await api.hederaHistory(accountId, cursor);
      return { items: res.items, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}) };
    },
  };
}

/**
 * Minimal BlockchainAdapter for Hedera Testnet. Supports balance and history
 * queries. Transfers (Phase 2B Part 2) are not yet implemented.
 */
export function createHederaAdapter(
  network: HederaNetwork,
  accountId?: string,
): BlockchainAdapter {
  const assets: readonly Asset[] = [nativeAsset(network)];

  const unsupported = (msg: string) =>
    new WalletError({
      code: 'UNSUPPORTED',
      userTitle: 'Not supported',
      userMessage: msg,
      fundsMoved: 'no',
      retryable: false,
    });

  return {
    family: 'hedera' as const,
    network,

    listAssets(): readonly Asset[] {
      return assets;
    },

    validateAddress(input: string): AddressValidation {
      const trimmed = input.trim();
      if (validateHederaAccountId(trimmed)) return { valid: true, normalized: trimmed };
      return { valid: false, reason: 'format' };
    },

    async getBalance(_address: string): Promise<bigint> {
      if (!accountId) return 0n;
      const ds = createHederaDataSource(accountId);
      return ds.getBalance();
    },

    async getTokenBalance(_address: string, _asset: Asset): Promise<bigint> {
      return 0n;
    },

    async getAllBalances(_address: string): Promise<Map<string, bigint | null>> {
      const asset = assets[0]!;
      const bal = accountId ? await createHederaDataSource(accountId).getBalance() : 0n;
      return new Map([[asset.id, bal]]);
    },

    async getChainStatus(): Promise<{ blockNumber: bigint }> {
      // Mirror Node is the source; return a stub block number.
      // This satisfies the connectivity check the UI performs.
      return { blockNumber: 0n };
    },

    async getTransaction(_hash: string): Promise<TxLookup | null> {
      return null;
    },

    async getTransactionHistory(_address: string, cursor?: string): Promise<Page<ActivityItem>> {
      if (!accountId) return { items: [] };
      const ds = createHederaDataSource(accountId);
      const res = await ds.getHistory(cursor);
      // Map HederaActivityItem → shared ActivityItem shape.
      const items: ActivityItem[] = res.items.map((i) => ({
        hash: i.transactionId,
        networkId: i.networkId,
        direction: i.direction,
        from: i.from,
        to: i.to,
        assetId: `${network.id}:native`,
        amount: String(i.amountTinybars),
        fee: String(i.feeTinybars),
        status: i.status,
        timestamp: i.timestamp,
        flags: [] as 'suspected_poisoning'[],
      }));
      return { items, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}) };
    },

    async estimateFee(_intent: TransferIntent): Promise<FeeQuote<Record<string, never>>> {
      throw unsupported('HBAR transfers are not yet available.');
    },

    async buildTransaction(
      _intent: TransferIntent,
      _fee: FeeOption & { params: Record<string, never> },
    ): Promise<never> {
      throw unsupported('HBAR transfers are not yet available.');
    },

    describe(_unsigned: never): ReviewSummary {
      throw unsupported('HBAR transfers are not yet available.');
    },

    async broadcastTransaction(_signed: SignedTx): Promise<string> {
      throw unsupported('HBAR transfers are not yet available.');
    },

    async waitForFinal(_hash: string): Promise<TxLookup> {
      throw unsupported('HBAR transfers are not yet available.');
    },
  };
}
