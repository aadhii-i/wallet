import type { Network } from './networks';

export type AssetKind = 'native' | 'erc20';

export interface Asset {
  /** `{networkId}:native` or `{networkId}:{contractLowercase}` (matches the API). */
  id: string;
  networkId: string;
  kind: AssetKind;
  symbol: string;
  name: string;
  decimals: number;
  contract?: `0x${string}`;
  priceRef?: string;
  /** From the bundled curated list. Unverified tokens get a warning badge. */
  verified: boolean;
}

interface TokenSpec {
  symbol: string;
  name: string;
  decimals: number;
  contract: `0x${string}`;
  priceRef?: string;
}

/**
 * Curated, bundled token list (spec §16.3: decimals/symbol come from here first,
 * not from the backend). Addresses are the canonical issuer deployments.
 */
const TOKENS: Record<string, TokenSpec[]> = {
  'eth-mainnet': [
    { symbol: 'USDC', name: 'USD Coin', decimals: 6, contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', priceRef: 'usd-coin' },
    { symbol: 'USDT', name: 'Tether USD', decimals: 6, contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', priceRef: 'tether' },
    { symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18, contract: '0x6B175474E89094C44Da98b954EedeAC495271d0F', priceRef: 'dai' },
  ],
  base: [
    { symbol: 'USDC', name: 'USD Coin', decimals: 6, contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', priceRef: 'usd-coin' },
  ],
  arbitrum: [
    { symbol: 'USDC', name: 'USD Coin', decimals: 6, contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', priceRef: 'usd-coin' },
  ],
  polygon: [
    { symbol: 'USDC', name: 'USD Coin', decimals: 6, contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', priceRef: 'usd-coin' },
  ],
  sepolia: [
    { symbol: 'USDC', name: 'USD Coin (test)', decimals: 6, contract: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  ],
  anvil: [],
};

export function nativeAsset(network: Network): Asset {
  const c = network.nativeCurrency;
  return {
    id: `${network.id}:native`,
    networkId: network.id,
    kind: 'native',
    symbol: c.symbol,
    name: c.name,
    decimals: c.decimals,
    ...(c.priceRef ? { priceRef: c.priceRef } : {}),
    verified: true,
  };
}

export function assetsForNetwork(network: Network, extra: readonly Asset[] = []): Asset[] {
  const tokens = (TOKENS[network.id] ?? []).map<Asset>((t) => ({
    id: `${network.id}:${t.contract.toLowerCase()}`,
    networkId: network.id,
    kind: 'erc20',
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    contract: t.contract,
    ...(t.priceRef ? { priceRef: t.priceRef } : {}),
    verified: true,
  }));
  return [nativeAsset(network), ...tokens, ...extra.filter((a) => a.networkId === network.id)];
}

/** True when `address` is a token contract we know about on this network. */
export function isKnownTokenContract(networkId: string, address: string): boolean {
  const a = address.toLowerCase();
  return (TOKENS[networkId] ?? []).some((t) => t.contract.toLowerCase() === a);
}
