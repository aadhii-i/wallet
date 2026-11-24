'use client';
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toUsdCents, type Asset, type BlockchainAdapter, type Network } from '@qd/blockchain';
import type { BitcoinAdapter } from '@qd/bitcoin';
import type { EvmAdapter } from '@qd/evm';
import type { ActivityItem } from '@qd/shared-types';
import { getAdapter, getBitcoinAdapter, getEvmAdapter, getHederaAdapter, registry } from './chains';
import { getApi } from './api';
import { filterEnabledNetworks, unmodelledNetworkIds } from './network-filter';
import { useMeta, useSelectedAccount, useSession, type AccountMeta } from './store';
import { readLinkedHederaAccount } from './hedera-link';
import { vault } from './vault-client';

/** Networks wallet-api will proxy. Public endpoint, so it answers before unlock too. */
export function useServerNetworks() {
  return useQuery({
    queryKey: ['networks'],
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async () => (await getApi()).networks(),
  });
}

/**
 * Networks this device can use: what the server proxies, plus anything the user
 * gave a custom RPC. Order and metadata still come from the client registry.
 */
export function useSelectableNetworks(): Network[] {
  const server = useServerNetworks().data;
  const customRpc = useMeta((s) => s.customRpc);
  return useMemo(
    () =>
      filterEnabledNetworks(
        registry.all(),
        server ? server.networks.map((n) => n.id) : null,
        Object.keys(customRpc),
      ),
    [server, customRpc],
  );
}

/** Chains the backend proxies that this build cannot render yet. */
export function useUnmodelledNetworks(): string[] {
  const server = useServerNetworks().data;
  return useMemo(
    () => unmodelledNetworkIds(server ? server.networks.map((n) => n.id) : null, registry.all().map((n) => n.id)),
    [server],
  );
}

export function useNetwork() {  const networkId = useMeta((s) => s.networkId);
  const selectable = useSelectableNetworks();
  // A backend with no upstream configured lists nothing. Falling back to the local
  // registry keeps the UI able to explain itself instead of dereferencing undefined.
  const list = selectable.length > 0 ? selectable : registry.all();
  return list.find((n) => n.id === networkId) ?? list[0]!;
}

/**
 * Read-only adapter for the selected network. Bitcoin instances are keyed by
 * address type because fee size estimates differ per spending scheme.
 */
export function useAdapter(): BlockchainAdapter {
  const network = useNetwork();
  const account = useSelectedAccount();
  const custom = useMeta((s) => s.customRpc[network.id]);
  const btcAddressType = useMeta((s) => s.btcAddressType);
  const hederaAccountId = useMeta((s) =>
    network.family === 'hedera'
      ? readLinkedHederaAccount(s.hederaAccountIds, account?.index)
      : undefined,
  );
  return useMemo(
    () => {
      if (network.family === 'bitcoin') return getBitcoinAdapter(network.id, btcAddressType, account?.index);
      if (network.family === 'hedera') return getHederaAdapter(network.id, hederaAccountId);
      return getEvmAdapter(network.id, custom);
    },
    [network, custom, btcAddressType, hederaAccountId, account?.index],
  );
}

/**
 * The EVM adapter for the selected network. Signing flows need the concrete
 * type (payload shape, fee parameters), so they take this instead of the
 * family-agnostic `useAdapter`.
 */
export function useEvmAdapter(): EvmAdapter {
  const network = useNetwork();
  const custom = useMeta((s) => s.customRpc[network.id]);
  return useMemo(() => {
    if (network.family !== 'evm') throw new Error(`Not an EVM network: ${network.id}`);
    return getEvmAdapter(network.id, custom);
  }, [network, custom]);
}

/** The Bitcoin adapter for the selected network and address type. */
export function useBitcoinAdapter(): BitcoinAdapter {
  const network = useNetwork();
  const account = useSelectedAccount();
  const addressType = useMeta((s) => s.btcAddressType);
  return useMemo(() => {
    if (network.family !== 'bitcoin') throw new Error(`Not a Bitcoin network: ${network.id}`);
    return getBitcoinAdapter(network.id, addressType, account?.index);
  }, [network, addressType, account?.index]);
}

/**
 * Derives (once) and caches the Bitcoin address for an account index on the
 * selected network. Addresses are public, so they live in the metadata store;
 * the key itself never leaves the worker.
 */
export function useBitcoinAddressForAccount(index: number | undefined): string | undefined {
  const network = useNetwork();
  const addressType = useMeta((s) => s.btcAddressType);
  const key = index !== undefined && network.family === 'bitcoin' ? `${network.id}|${addressType}|${index}` : '';
  const cached = useMeta((s) => (key ? s.btcAddresses[key] : undefined));
  const remember = useMeta((s) => s.setBtcAddress);

  useEffect(() => {
    if (!key || cached || index === undefined || network.family !== 'bitcoin') return;
    let cancelled = false;
    void vault
      .call('btcAddress', { index, network: network.bitcoin.chain, addressType })
      .then(({ address }) => {
        if (!cancelled) remember(key, address);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key, cached, index, network, addressType, remember]);

  return cached;
}

/**
 * Address the UI should display and read balances for on the selected network.
 *
 * EVM accounts use the address stored with the account metadata. Bitcoin
 * addresses are derived on demand inside the KeyWorker and cached in the
 * (non-secret) metadata store, keyed by network and address type. Nothing is
 * returned until the worker has produced the address, so callers never show a
 * placeholder as if it were a real address.
 */
export function useAccountAddress(): string | undefined {
  const account = useSelectedAccount();
  const network = useNetwork();
  const btc = useBitcoinAddressForAccount(account?.index);
  const hederaAccountId = useMeta((s) =>
    network.family === 'hedera'
      ? readLinkedHederaAccount(s.hederaAccountIds, account?.index)
      : undefined,
  );
  if (network.family === 'bitcoin') return btc;
  if (network.family === 'hedera') return hederaAccountId;
  return account?.address;
}

export interface Holding {
  asset: Asset;
  balance: bigint | null;
}

export function useHoldings(address: string | undefined) {
  const adapter = useAdapter();
  const custom = useMeta((s) => s.customRpc[adapter.network.id]);
  return useQuery({
    queryKey: ['holdings', adapter.network.id, custom ?? 'proxy', address],
    enabled: !!address,
    refetchInterval: 15_000,
    queryFn: async (): Promise<Holding[]> => {
      // Never show balances from an RPC that serves a different chain.
      await adapter.getChainStatus();
      const map = await adapter.getAllBalances(address!);
      return adapter.listAssets().map((asset) => ({ asset, balance: map.get(asset.id) ?? null }));
    },
  });
}

/** Connectivity, chain id verification and latest block for the selected network. */
export function useChainStatus() {
  const adapter = useAdapter();
  const custom = useMeta((s) => s.customRpc[adapter.network.id]);
  return useQuery({
    queryKey: ['chain-status', adapter.network.id, custom ?? 'proxy'],
    refetchInterval: 15_000,
    retry: 1,
    queryFn: () => adapter.getChainStatus(),
  });
}

export function usePrices(refs: readonly string[]) {
  const key = [...new Set(refs)].sort();
  return useQuery({
    queryKey: ['prices', key.join(',')],
    enabled: key.length > 0,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async () => {
      const api = await getApi();
      const res = await api.prices(key);
      return res.prices;
    },
  });
}

export interface ValuedHolding extends Holding {
  usdCents: bigint | null;
}

/** Holdings with fiat values; total is null while prices are unavailable. */
export function useValuedHoldings(address: string | undefined) {
  const holdings = useHoldings(address);
  const refs = (holdings.data ?? []).flatMap((h) => (h.asset.priceRef ? [h.asset.priceRef] : []));
  const prices = usePrices(refs);
  const valued: ValuedHolding[] | undefined = holdings.data?.map((h) => {
    const p = h.asset.priceRef ? prices.data?.[h.asset.priceRef]?.usd : undefined;
    return { ...h, usdCents: p && h.balance !== null ? toUsdCents(h.balance, h.asset.decimals, p) : null };
  });
  const totalCents = valued && prices.data ? valued.reduce((sum, h) => sum + (h.usdCents ?? 0n), 0n) : null;
  return { holdings, prices, valued, totalCents };
}

/**
 * Backend history merged with transactions this device broadcast. Bitcoin
 * history is address-scoped (Core has no account concept); EVM history is
 * account-scoped on the backend.
 */
export function useActivity(account: AccountMeta | undefined) {
  const network = useNetwork();
  const address = useAccountAddress();
  const localTxs = useMeta((s) => s.localTxs);
  const apiOnline = useSession((s) => s.apiOnline);
  const bitcoin = network.family === 'bitcoin';
  const hedera = network.family === 'hedera';
  const hederaAccountId = useMeta((s) =>
    hedera ? readLinkedHederaAccount(s.hederaAccountIds, account?.index) : undefined,
  );
  const scope = hedera ? hederaAccountId : bitcoin ? address : account?.apiId;
  const remote = useQuery({
    queryKey: ['activity', network.id, scope],
    enabled: !!scope && apiOnline,
    refetchInterval: 20_000,
    // Returning to the app re-syncs: the API indexes this account's addresses from the chain on each request.
    refetchOnWindowFocus: 'always',
    retry: 1,
    queryFn: async () => {
      const api = await getApi();
      if (network.family === 'hedera') {
        return (await api.hederaHistory(scope!, undefined)).items.map((i) => ({
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
      }
      if (network.family === 'bitcoin') return (await getBitcoinAdapter(network.id, useMeta.getState().btcAddressType, account!.index).getTransactionHistory(address!)).items;
      return (await api.activity(account!.apiId!, network.id)).items;
    },
  });

  const items = useMemo(() => {
    if (!account || !address) return [];
    // For Hedera the "address" is the Account ID; local tx tracking for Hedera
    // is deferred to Phase 2B (transfers not yet implemented).
    if (hedera) return [...(remote.data ?? [])].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const me = address.toLowerCase();
    const local: ActivityItem[] = localTxs
      .filter((t) => t.networkId === network.id && (t.from.toLowerCase() === me || t.to.toLowerCase() === me))
      .map((t) => ({
        hash: t.hash,
        networkId: t.networkId,
        direction: t.from.toLowerCase() === me ? (t.to.toLowerCase() === me ? 'self' : 'out') : 'in',
        from: t.from,
        to: t.to,
        assetId: t.assetId,
        amount: t.amount,
        ...(t.fee ? { fee: t.fee } : {}),
        status: t.status,
        timestamp: new Date(t.createdAt).toISOString(),
        flags: [] as 'suspected_poisoning'[],
      }));
    const byHash = new Map<string, ActivityItem>();
    const key = (i: ActivityItem) => `${i.hash.toLowerCase()}|${i.assetId}`;
    for (const i of local) byHash.set(key(i), i);
    // Remote wins for status once indexed, but keep local-only pending items.
    // flags is defaulted here because the list dereferences it unconditionally.
    for (const i of remote.data ?? []) byHash.set(key(i), { ...i, flags: (i.flags ?? []) as 'suspected_poisoning'[] });
    return [...byHash.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }, [account, address, localTxs, network.id, remote.data]);

  return { items, isLoading: remote.isLoading && items.length === 0, remote };
}
