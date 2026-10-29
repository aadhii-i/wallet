'use client';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toUsdCents, type Asset, type Network } from '@qd/blockchain';
import type { ActivityItem } from '@qd/shared-types';
import { getAdapter, registry } from './chains';
import { getApi } from './api';
import { filterEnabledNetworks, unmodelledNetworkIds } from './network-filter';
import { useMeta, useSession, type AccountMeta } from './store';

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

export function useNetwork() {
  const networkId = useMeta((s) => s.networkId);
  const selectable = useSelectableNetworks();
  // A backend with no upstream configured lists nothing. Falling back to the local
  // registry keeps the UI able to explain itself instead of dereferencing undefined.
  const list = selectable.length > 0 ? selectable : registry.all();
  return list.find((n) => n.id === networkId) ?? list[0]!;
}

export function useAdapter() {
  const network = useNetwork();
  const custom = useMeta((s) => s.customRpc[network.id]);
  return useMemo(() => getAdapter(network.id, custom), [network.id, custom]);
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

/** Backend history merged with transactions this device broadcast. */
export function useActivity(account: AccountMeta | undefined) {
  const network = useNetwork();
  const localTxs = useMeta((s) => s.localTxs);
  const apiOnline = useSession((s) => s.apiOnline);
  const remote = useQuery({
    queryKey: ['activity', network.id, account?.apiId],
    enabled: !!account?.apiId && apiOnline,
    refetchInterval: 20_000,
    retry: 1,
    queryFn: async () => (await (await getApi()).activity(account!.apiId!, network.id)).items,
  });

  const items = useMemo(() => {
    if (!account) return [];
    const me = account.address.toLowerCase();
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
        flags: [],
      }));
    const byHash = new Map<string, ActivityItem>();
    for (const i of local) byHash.set(i.hash.toLowerCase(), i);
    // Remote wins for status once indexed, but keep local-only pending items.
    // flags is defaulted here because the list dereferences it unconditionally.
    for (const i of remote.data ?? []) byHash.set(i.hash.toLowerCase(), { ...i, flags: i.flags ?? [] });
    return [...byHash.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }, [account, localTxs, network.id, remote.data]);

  return { items, isLoading: remote.isLoading && items.length === 0, remote };
}
