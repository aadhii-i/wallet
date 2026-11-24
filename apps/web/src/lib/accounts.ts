'use client';
import { discoverAccounts } from '@qd/evm';
import { indexesToVerify, makeAccountMeta, nextAccountIndex, reconcileAccounts, type HDAccountMeta } from '@qd/wallet-core';
import { getEvmAdapter, registry } from './chains';
import { useMeta } from './store';
import { vault } from './vault-client';
import { createBitcoinDataSource } from './bitcoin-api';
import { ApiError } from '@qd/rpc';

/** Legacy receive history identifies accounts even after all value moved to change. */
async function discoverBitcoinIndexes(): Promise<{ indexes: number[]; complete: boolean }> {
  const indexes = new Set<number>();
  let complete = true;
  const deadline = Date.now() + 30_000;
  for (const network of ['mainnet', 'testnet4'] as const) {
    const source = createBitcoinDataSource(network);
    try { await source.getFees(); }
    catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) complete = false;
      continue;
    }
    for (let index = 0; index < DISCOVERY_SCAN; index++) {
      for (const addressType of ['p2wpkh', 'p2tr'] as const) {
        if (Date.now() > deadline) return { indexes: [...indexes], complete: false };
        try {
          const { address } = await vault.call('btcAddress', { index, network, addressType });
          if (await source.isAddressUsed!(address)) indexes.add(index);
        } catch { complete = false; }
      }
    }
  }
  return { indexes: [...indexes], complete };
}

let adding: Promise<HDAccountMeta> | null = null;

/**
 * Derives the next HD account from the unlocked vault (same phrase, next index)
 * and selects it. Concurrent calls share one derivation, so repeated clicks
 * cannot create duplicate accounts.
 */
export function addNextAccount(): Promise<HDAccountMeta> {
  adding ??= (async () => {
    try {
      const index = nextAccountIndex(useMeta.getState().accounts);
      const [address] = await vault.call('addresses', { indexes: [index] });
      if (!address) throw new Error('No address derived');
      const account = makeAccountMeta(index, address);
      useMeta.getState().addAccount(account);
      return account;
    } finally {
      adding = null;
    }
  })();
  return adding;
}

/**
 * After unlock: re-derives every stored account's address in the KeyWorker and
 * replaces metadata that is missing or belongs to a different phrase.
 */
export async function reconcileWithVault(): Promise<'ok' | 'rebuilt'> {
  const stored = useMeta.getState().accounts;
  const derived = await vault.call('addresses', { indexes: indexesToVerify(stored) });
  const result = reconcileAccounts(stored, derived);
  if (result.status === 'rebuilt') useMeta.getState().setAccounts(result.accounts);
  return result.status;
}

export const DISCOVERY_SCAN = 20;
const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Restore-time account discovery: an index counts as used if it has a balance or
 * sent a transaction on the selected EVM network/Sepolia, or has legacy Bitcoin
 * receiving history on a configured network. Returns `complete:
 * false` when the scan could not finish, so the UI never claims accounts were
 * searched when they were not.
 */
export async function discoverRestoredAccounts(): Promise<{ accounts: HDAccountMeta[]; complete: boolean }> {
  const bitcoinDiscovery = discoverBitcoinIndexes();
  const { networkId, customRpc } = useMeta.getState();
  const ids = [...new Set([networkId, 'sepolia'])].filter((id) => registry.byId(id)?.family === 'evm');
  const addresses = await vault.call('addresses', { indexes: Array.from({ length: DISCOVERY_SCAN }, (_, i) => i) });
  // discoverAccounts treats RPC errors as "unused", so scan only networks that answer
  // with the right chain id; otherwise report the scan as incomplete.
  const candidates = ids.map((id) => getEvmAdapter(id, customRpc[id]));
  const reachable = await Promise.all(candidates.map((a) => a.getChainStatus().then(() => true, () => false)));
  const adapters = candidates.filter((_, i) => reachable[i]);
  if (adapters.length === 0) {
    const bitcoin = await bitcoinDiscovery;
    return { accounts: [...new Set([0, ...bitcoin.indexes])].sort((a,b) => a-b).map(i => makeAccountMeta(i, addresses[i]!)), complete: false };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const used = await Promise.race([
    discoverAccounts(adapters, (i) => addresses[i]!, { max: DISCOVERY_SCAN }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DISCOVERY_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));

  const bitcoin = await bitcoinDiscovery;
  const indexes = [...new Set([...(used ?? [0]), ...bitcoin.indexes])].sort((a,b) => a-b);
  return { accounts: indexes.map((i) => makeAccountMeta(i, addresses[i]!)), complete: used !== null && reachable.every(Boolean) && bitcoin.complete };
}
