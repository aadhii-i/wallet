import type { ChainFamily, NetworkKind } from '@qd/shared-types';

export interface NetworkBase {
  /** Stable id used across client, API and DB, e.g. `eth-mainnet`. */
  id: string;
  family: ChainFamily;
  name: string;
  shortName: string;
  kind: NetworkKind;
  nativeCurrency: { symbol: string; name: string; decimals: number; priceRef?: string };
  explorer?: { name: string; txUrl: (hash: string) => string; addressUrl: (address: string) => string };
  /** Visual accent token for the network badge (packages/ui). */
  accent: string;
}

export interface EvmNetwork extends NetworkBase {
  family: 'evm';
  /**
   * Authoritative chain id. Always taken from this registry, never from an RPC
   * response (EIP-155 replay protection, spec §11.4).
   */
  chainId: number;
  feeModel: 'eip1559' | 'legacy';
  blockTimeMs: number;
  confirmationsForFinal: number;
  /** Hard warning when the network fee exceeds this many native units (decimal string). */
  feeWarningNative: string;
}

export type Network = EvmNetwork;

const etherscan = (base: string) => ({
  name: base.replace('https://', ''),
  txUrl: (h: string) => `${base}/tx/${h}`,
  addressUrl: (a: string) => `${base}/address/${a}`,
});

const ETH = { symbol: 'ETH', name: 'Ether', decimals: 18, priceRef: 'ethereum' } as const;

export const EVM_NETWORKS: readonly EvmNetwork[] = [
  {
    id: 'eth-mainnet',
    family: 'evm',
    chainId: 1,
    name: 'Ethereum',
    shortName: 'Ethereum',
    kind: 'mainnet',
    nativeCurrency: ETH,
    explorer: etherscan('https://etherscan.io'),
    feeModel: 'eip1559',
    blockTimeMs: 12_000,
    confirmationsForFinal: 12,
    feeWarningNative: '0.02',
    accent: 'eth',
  },
  {
    id: 'base',
    family: 'evm',
    chainId: 8453,
    name: 'Base',
    shortName: 'Base',
    kind: 'mainnet',
    nativeCurrency: ETH,
    explorer: etherscan('https://basescan.org'),
    feeModel: 'eip1559',
    blockTimeMs: 2_000,
    confirmationsForFinal: 10,
    feeWarningNative: '0.005',
    accent: 'base',
  },
  {
    id: 'arbitrum',
    family: 'evm',
    chainId: 42161,
    name: 'Arbitrum One',
    shortName: 'Arbitrum',
    kind: 'mainnet',
    nativeCurrency: ETH,
    explorer: etherscan('https://arbiscan.io'),
    feeModel: 'eip1559',
    blockTimeMs: 250,
    confirmationsForFinal: 20,
    feeWarningNative: '0.005',
    accent: 'arbitrum',
  },
  {
    id: 'polygon',
    family: 'evm',
    chainId: 137,
    name: 'Polygon PoS',
    shortName: 'Polygon',
    kind: 'mainnet',
    nativeCurrency: { symbol: 'POL', name: 'Polygon', decimals: 18, priceRef: 'polygon-ecosystem-token' },
    explorer: etherscan('https://polygonscan.com'),
    feeModel: 'eip1559',
    blockTimeMs: 2_000,
    confirmationsForFinal: 32,
    feeWarningNative: '20',
    accent: 'polygon',
  },
  {
    id: 'sepolia',
    family: 'evm',
    chainId: 11155111,
    name: 'Ethereum Sepolia',
    shortName: 'Sepolia',
    kind: 'testnet',
    nativeCurrency: { symbol: 'SepoliaETH', name: 'Sepolia Ether', decimals: 18 },
    explorer: etherscan('https://sepolia.etherscan.io'),
    feeModel: 'eip1559',
    blockTimeMs: 12_000,
    confirmationsForFinal: 3,
    feeWarningNative: '0.05',
    accent: 'testnet',
  },
  {
    id: 'anvil',
    family: 'evm',
    chainId: 31337,
    name: 'Localhost (Anvil)',
    shortName: 'Anvil',
    kind: 'local',
    nativeCurrency: { symbol: 'ETH', name: 'Ether', decimals: 18, priceRef: 'ethereum' },
    feeModel: 'eip1559',
    blockTimeMs: 1_000,
    confirmationsForFinal: 1,
    feeWarningNative: '0.05',
    accent: 'local',
  },
];

export interface NetworkRegistry {
  all(): readonly Network[];
  byId(id: string): Network | undefined;
  byChainId(chainId: number): EvmNetwork | undefined;
  require(id: string): Network;
}

/**
 * Registry filtered to what this build may use. Local networks are excluded
 * from production builds (spec §27.2).
 */
export function createNetworkRegistry(opts: { includeLocal: boolean; enabledIds?: readonly string[] }): NetworkRegistry {
  const list = EVM_NETWORKS.filter(
    (n) => (opts.includeLocal || n.kind !== 'local') && (!opts.enabledIds || opts.enabledIds.includes(n.id)),
  );
  const byId = new Map(list.map((n) => [n.id, n]));
  const byChain = new Map(list.map((n) => [n.chainId, n]));
  return {
    all: () => list,
    byId: (id) => byId.get(id),
    byChainId: (c) => byChain.get(c),
    require(id) {
      const n = byId.get(id);
      if (!n) throw new Error(`Unknown network: ${id}`);
      return n;
    },
  };
}
