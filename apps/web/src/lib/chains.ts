'use client';
import { custom, http } from 'viem';
import {
  createNetworkRegistry,
  type BitcoinAddressType,
  type BitcoinNetwork,
  type BlockchainAdapter,
  type EvmNetwork,
  type HederaNetwork,
} from '@qd/blockchain';
import { BitcoinAdapter } from '@qd/bitcoin';
import { EvmAdapter, NonceTracker } from '@qd/evm';
import { proxyRequest } from '@qd/rpc';
import { getApi } from './api';
import { createBitcoinDataSource } from './bitcoin-api';
import { bitcoinWalletScope } from './bitcoin-wallet';
import { createHederaAdapter } from './hedera-api';
import { useMeta } from './store';

export const registry = createNetworkRegistry({
  includeLocal: process.env.NEXT_PUBLIC_ENABLE_LOCAL_NETWORKS === 'true',
});

// Persisted so a reload cannot make us trust a lying RPC's nonce (audit finding 7).
const nonceTracker = new NonceTracker(useMeta.getState().nonces, (n) => useMeta.getState().setNonces(n));
const evmCache = new Map<string, EvmAdapter>();
const btcCache = new Map<string, BitcoinAdapter>();

/**
 * Adapter per EVM network. Default transport is the authenticated wallet-api
 * proxy (provider keys stay server-side). A user-configured custom RPC bypasses
 * our backend entirely (spec §25.5).
 */
export function getEvmAdapter(networkId: string, customRpc?: string): EvmAdapter {
  const key = `${networkId}|${customRpc ?? ''}`;
  let a = evmCache.get(key);
  if (!a) {
    const network = registry.require(networkId);
    if (network.family !== 'evm') throw new Error(`Not an EVM network: ${networkId}`);
    const transport = customRpc
      ? http(customRpc, { timeout: 10_000, retryCount: 1 })
      : custom({
          async request(args) {
            const api = await getApi();
            return proxyRequest(api, network.chainId)(args);
          },
        }, { retryCount: 0 });
    a = new EvmAdapter({ network: network as EvmNetwork, transport, nonceTracker });
    evmCache.set(key, a);
  }
  return a;
}

/**
 * Adapter per Bitcoin network. There is no user-supplied RPC: the only supported
 * backend is the operator's Core node, reached through wallet-api. `addressType`
 * selects the spending scheme, so BIP-84 and BIP-86 get separate instances.
 */
export function getBitcoinAdapter(networkId: string, addressType?: BitcoinAddressType, account = useMeta.getState().selectedIndex): BitcoinAdapter {
  const network = registry.require(networkId);
  if (network.family !== 'bitcoin') throw new Error(`Not a Bitcoin network: ${networkId}`);
  const btc = network as BitcoinNetwork;
  const type = addressType ?? btc.bitcoin.defaultAddressType;
  const key = `${networkId}|${type}|${account}`;
  let a = btcCache.get(key);
  if (!a) {
    const source = createBitcoinDataSource(btc.bitcoin.chain);
    a = new BitcoinAdapter({
      network: btc,
      dataSource: source,
      wallet: bitcoinWalletScope(account, btc.bitcoin.chain, type, source),
      addressType: type,
    });
    btcCache.set(key, a);
  }
  return a;
}

/**
 * Family-agnostic adapter for read-only UI (balances, activity, chain status).
 * Signing flows pick the concrete family adapter instead, because their payload
 * shapes differ.
 */
export function getAdapter(networkId: string, customRpc?: string): BlockchainAdapter {
  const network = registry.require(networkId);
  if (network.family === 'bitcoin') return getBitcoinAdapter(networkId);
  if (network.family === 'hedera') return getHederaAdapter(networkId);
  return getEvmAdapter(networkId, customRpc);
}

const hederaCache = new Map<string, BlockchainAdapter>();

/**
 * Adapter per Hedera network. Backed by the Testnet Mirror Node via
 * wallet-api. No signing in this phase.
 */
export function getHederaAdapter(networkId: string, accountId?: string): BlockchainAdapter {
  const network = registry.require(networkId);
  if (network.family !== 'hedera') throw new Error(`Not a Hedera network: ${networkId}`);
  const key = `${networkId}|${accountId ?? ''}`;
  let a = hederaCache.get(key);
  if (!a) {
    a = createHederaAdapter(network as HederaNetwork, accountId);
    hederaCache.set(key, a);
  }
  return a;
}
