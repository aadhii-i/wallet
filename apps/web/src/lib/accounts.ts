'use client';
import { discoverAccounts } from '@qd/evm';
import { indexesToVerify, makeAccountMeta, nextAccountIndex, reconcileAccounts, type HDAccountMeta } from '@qd/wallet-core';
import { getAdapter, registry } from './chains';
import { useMeta } from './store';
import { vault } from './vault-client';

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
 * sent a transaction on the selected network or on Sepolia. Returns `complete:
 * false` when the scan could not finish, so the UI never claims accounts were
 * searched when they were not.
 */
export async function discoverRestoredAccounts(): Promise<{ accounts: HDAccountMeta[]; complete: boolean }> {
  const { networkId, customRpc } = useMeta.getState();
  const ids = [...new Set([networkId, 'sepolia'])].filter((id) => registry.byId(id));
  const addresses = await vault.call('addresses', { indexes: Array.from({ length: DISCOVERY_SCAN }, (_, i) => i) });
  // discoverAccounts treats RPC errors as "unused", so scan only networks that answer
  // with the right chain id; otherwise report the scan as incomplete.
  const candidates = ids.map((id) => getAdapter(id, customRpc[id]));
  const reachable = await Promise.all(candidates.map((a) => a.getChainStatus().then(() => true, () => false)));
  const adapters = candidates.filter((_, i) => reachable[i]);
  if (adapters.length === 0) return { accounts: [makeAccountMeta(0, addresses[0]!)], complete: false };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const used = await Promise.race([
    discoverAccounts(adapters, (i) => addresses[i]!, { max: DISCOVERY_SCAN }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DISCOVERY_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));

  const indexes = used ?? [0];
  return { accounts: indexes.map((i) => makeAccountMeta(i, addresses[i]!)), complete: used !== null && reachable.every(Boolean) };
}
