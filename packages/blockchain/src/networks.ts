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
  /** Testnets only: where to request free test funds. */
  faucetUrl?: string;
}

/**
 * Fee models the EVM adapter knows how to price. Kept here rather than in
 * `packages/evm` because the registry is the type that declares it.
 */
export type FeeStrategyId = 'eip1559' | 'op-stack' | 'arbitrum' | 'polygon';

export interface EvmNetwork extends NetworkBase {
  family: 'evm';
  /**
   * Authoritative chain id. Always taken from this registry, never from an RPC
   * response (EIP-155 replay protection, spec §11.4).
   */
  chainId: number;
  feeModel: 'eip1559' | 'legacy';
  /**
   * Which fee model the adapter quotes this chain with, implemented in
   * `packages/evm/src/fees.ts`. Required so that enabling a chain is a decision
   * about how it prices, not just a name and a chain id (ADR 0016).
   */
  feeStrategy: FeeStrategyId;
  blockTimeMs: number;
  confirmationsForFinal: number;
  /** Hard warning when the network fee exceeds this many native units (decimal string). */
  feeWarningNative: string;
}

export type BitcoinChain = 'mainnet' | 'testnet4';
export type BitcoinAddressType = 'p2wpkh' | 'p2tr';

/**
 * Bitcoin is a UTXO chain: no chain id, no nonce. Everything the adapter needs
 * that is not part of `NetworkBase` lives under `bitcoin`.
 */
export interface BitcoinNetwork extends NetworkBase {
  family: 'bitcoin';
  bitcoin: {
    chain: BitcoinChain;
    /** BIP-44 coin type: 0 mainnet, 1 testnet. */
    coinType: 0 | 1;
    /** Bech32 human-readable part: `bc` or `tb`. */
    bech32Hrp: 'bc' | 'tb';
    defaultAddressType: BitcoinAddressType;
    addressTypes: readonly BitcoinAddressType[];
    blockTimeMs: number;
    confirmationsForFinal: number;
    /** Hard warning when the fee exceeds this many satoshis (decimal string). */
    feeWarningSats: string;
  };
}

export type HederaChain = 'mainnet' | 'testnet';

/**
 * Hedera Hashgraph network. No EVM chain id; accounts are identified by
 * the Hedera Account ID format (shard.realm.num, e.g. 0.0.12345).
 * Key type for HD wallets: secp256k1 on SLIP-44 coin type 3030.
 */
export interface HederaNetwork extends NetworkBase {
  family: 'hedera';
  hedera: {
    chain: HederaChain;
    /** SLIP-44 coin type for HBAR: 3030. */
    coinType: 3030;
    /** Mirror Node REST API base URL for this network (no trailing slash). */
    mirrorNodeUrl: string;
    /** Name passed to the Hedera SDK Client factory ('mainnet' | 'testnet'). */
    networkName: 'mainnet' | 'testnet';
    blockTimeMs: number;
    confirmationsForFinal: number;
    /**
     * Hard fee warning threshold in tinybars (decimal string).
     * 1 HBAR = 100_000_000 tinybars.
     */
    feeWarningTinybars: string;
  };
}

export type Network = EvmNetwork | BitcoinNetwork | HederaNetwork;

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
    feeStrategy: 'eip1559',
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
    feeStrategy: 'op-stack',
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
    feeStrategy: 'arbitrum',
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
    feeStrategy: 'polygon',
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
    feeStrategy: 'eip1559',
    blockTimeMs: 12_000,
    confirmationsForFinal: 3,
    feeWarningNative: '0.05',
    accent: 'testnet',
    faucetUrl: 'https://www.alchemy.com/faucets/ethereum-sepolia',
  },
  {
    id: 'base-sepolia',
    family: 'evm',
    chainId: 84532,
    name: 'Base Sepolia',
    shortName: 'Base Sepolia',
    kind: 'testnet',
    nativeCurrency: { symbol: 'ETH', name: 'Sepolia Ether', decimals: 18 },
    explorer: etherscan('https://sepolia.basescan.org'),
    feeModel: 'eip1559',
    feeStrategy: 'op-stack',
    blockTimeMs: 2_000,
    confirmationsForFinal: 5,
    feeWarningNative: '0.05',
    accent: 'testnet',
  },
  {
    id: 'arbitrum-sepolia',
    family: 'evm',
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    shortName: 'Arb Sepolia',
    kind: 'testnet',
    nativeCurrency: { symbol: 'ETH', name: 'Sepolia Ether', decimals: 18 },
    explorer: etherscan('https://sepolia.arbiscan.io'),
    feeModel: 'eip1559',
    feeStrategy: 'arbitrum',
    blockTimeMs: 250,
    confirmationsForFinal: 10,
    feeWarningNative: '0.05',
    accent: 'testnet',
  },
  {
    id: 'amoy',
    family: 'evm',
    chainId: 80002,
    name: 'Polygon Amoy',
    shortName: 'Amoy',
    kind: 'testnet',
    nativeCurrency: { symbol: 'POL', name: 'Polygon', decimals: 18 },
    explorer: etherscan('https://amoy.polygonscan.com'),
    feeModel: 'eip1559',
    feeStrategy: 'polygon',
    blockTimeMs: 2_000,
    confirmationsForFinal: 16,
    feeWarningNative: '2',
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
    feeStrategy: 'eip1559',
    blockTimeMs: 1_000,
    confirmationsForFinal: 1,
    feeWarningNative: '0.05',
    accent: 'local',
  },
];

/**
 * Bitcoin networks. `family: 'bitcoin'` distinguishes them from EVM entries;
 * `Network` is the union of both registries.
 */
export const BITCOIN_NETWORKS: readonly BitcoinNetwork[] = [
  {
    id: 'btc-mainnet',
    family: 'bitcoin',
    name: 'Bitcoin',
    shortName: 'Bitcoin',
    kind: 'mainnet',
    nativeCurrency: { symbol: 'BTC', name: 'Bitcoin', decimals: 8, priceRef: 'bitcoin' },
    explorer: {
      name: 'mempool.space',
      txUrl: (h) => `https://mempool.space/tx/${h}`,
      addressUrl: (a) => `https://mempool.space/address/${a}`,
    },
    accent: 'bitcoin',
    bitcoin: {
      chain: 'mainnet',
      coinType: 0,
      bech32Hrp: 'bc',
      defaultAddressType: 'p2wpkh',
      addressTypes: ['p2wpkh', 'p2tr'],
      blockTimeMs: 600_000,
      confirmationsForFinal: 6,
      feeWarningSats: '100000',
    },
  },
  {
    id: 'btc-testnet4',
    family: 'bitcoin',
    name: 'Bitcoin Testnet4',
    shortName: 'Testnet4',
    kind: 'testnet',
    nativeCurrency: { symbol: 'BTC', name: 'Testnet Bitcoin', decimals: 8, priceRef: 'bitcoin' },
    explorer: {
      name: 'mempool.space testnet4',
      txUrl: (h) => `https://mempool.space/testnet4/tx/${h}`,
      addressUrl: (a) => `https://mempool.space/testnet4/address/${a}`,
    },
    accent: 'testnet',
    faucetUrl: 'https://mempool.space/testnet4/faucet',
    bitcoin: {
      chain: 'testnet4',
      coinType: 1,
      bech32Hrp: 'tb',
      defaultAddressType: 'p2wpkh',
      addressTypes: ['p2wpkh', 'p2tr'],
      blockTimeMs: 600_000,
      confirmationsForFinal: 3,
      feeWarningSats: '50000',
    },
  },
];

export const HEDERA_NETWORKS: readonly HederaNetwork[] = [
  {
    id: 'hedera-testnet',
    family: 'hedera',
    name: 'Hedera Testnet',
    shortName: 'Hedera',
    kind: 'testnet',
    nativeCurrency: {
      symbol: 'HBAR',
      name: 'HBAR',
      decimals: 8,
      priceRef: 'hedera-hashgraph',
    },
    explorer: {
      name: 'HashScan',
      txUrl: (h) => `https://hashscan.io/testnet/transaction/${h}`,
      addressUrl: (a) => `https://hashscan.io/testnet/account/${a}`,
    },
    accent: 'testnet',
    faucetUrl: 'https://portal.hedera.com',
    hedera: {
      chain: 'testnet',
      coinType: 3030,
      mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com/api/v1',
      networkName: 'testnet',
      blockTimeMs: 3_000,
      confirmationsForFinal: 1,
      // 1 HBAR = 100_000_000 tinybars; warn above 1 HBAR on testnet.
      feeWarningTinybars: '100000000',
    },
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
  const list: readonly Network[] = [...EVM_NETWORKS, ...BITCOIN_NETWORKS, ...HEDERA_NETWORKS].filter(
    (n) => (opts.includeLocal || n.kind !== 'local') && (!opts.enabledIds || opts.enabledIds.includes(n.id)),
  );
  const byId = new Map<string, Network>(list.map((n) => [n.id, n]));
  const byChain = new Map<number, EvmNetwork>();
  for (const n of list) {
    if (n.family === 'evm') byChain.set(n.chainId, n);
  }
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
