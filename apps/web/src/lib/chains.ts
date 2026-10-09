'use client';
import { custom, http } from 'viem';
import { createNetworkRegistry, type EvmNetwork } from '@qd/blockchain';
import { EvmAdapter, NonceTracker } from '@qd/evm';
import { proxyRequest } from '@qd/rpc';
import { getApi } from './api';
import { useMeta } from './store';

export const registry = createNetworkRegistry({
  includeLocal: process.env.NEXT_PUBLIC_ENABLE_LOCAL_NETWORKS === 'true',
});

// Persisted so a reload cannot make us trust a lying RPC's nonce (audit finding 7).
const nonceTracker = new NonceTracker(useMeta.getState().nonces, (n) => useMeta.getState().setNonces(n));
const cache = new Map<string, EvmAdapter>();

/**
 * Adapter per network. Default transport is the authenticated wallet-api proxy
 * (provider keys stay server-side). A user-configured custom RPC bypasses our
 * backend entirely (spec §25.5).
 */
export function getAdapter(networkId: string, customRpc?: string): EvmAdapter {
  const key = `${networkId}|${customRpc ?? ''}`;
  let a = cache.get(key);
  if (!a) {
    const network = registry.require(networkId) as EvmNetwork;
    const transport = customRpc
      ? http(customRpc, { timeout: 10_000, retryCount: 1 })
      : custom({
          async request(args) {
            const api = await getApi();
            return proxyRequest(api, network.chainId)(args);
          },
        }, { retryCount: 0 });
    a = new EvmAdapter({ network, transport, nonceTracker });
    cache.set(key, a);
  }
  return a;
}
