import {
  decodeFunctionResult,
  encodeFunctionData,
  hexToBigInt,
  serializeTransaction,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  WalletError,
  type EvmNetwork,
  type FeeOption,
  type FeeQuote,
  type FeeStrategyId,
  type FeeTier,
} from '@qd/blockchain';

/** What the signer needs to build the transaction. */
export interface EvmFeeParams {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /**
   * Wei the chain charges on top of `gas × maxFeePerGas` — today only the
   * OP-stack L1 data fee. Already added to `FeeOption.maxFee` and
   * `estimatedFee` so the review screen and the balance check cannot miss it;
   * carried here so the UI can break it out instead of showing one number.
   */
  extraFee?: bigint;
}

export interface FeeContext {
  client: PublicClient;
  network: EvmNetwork;
  /** Gas limit, already estimated against the node and padded. */
  gas: bigint;
  /** The call being priced; the OP-stack leg needs it to size the transaction. */
  call: { to: Hex; value: bigint; data?: Hex };
  now: () => number;
}

export interface FeeStrategy {
  readonly id: FeeStrategyId;
  quote(ctx: FeeContext): Promise<FeeQuote<EvmFeeParams>>;
}

const GWEI = 1_000_000_000n;
/** Below this a sampled priority fee is dust; keeps a quiet node from quoting zero. */
const MIN_PRIORITY_FEE = 1_000_000n; // 0.001 gwei
/** Gas price floor ArbOS enforces on Arbitrum; anything lower is rejected. */
const ARBITRUM_MIN_GAS_PRICE = GWEI / 100n; // 0.01 gwei
/** OP-stack L1-cost predeploy. Same address on every chain in the family. */
const OP_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';

const TIER_ORDER = ['low', 'market', 'aggressive'] as const;
/** Blocks a tier is expected to wait for inclusion — feeds the UI's eta estimate. */
const BLOCKS_TO_INCLUDE: Record<FeeTier, number> = { low: 6, market: 2, aggressive: 1 };
/**
 * Headroom over the price the node itself quotes, in percent. Rollups whose
 * sequencer sets the price cannot be jumped ahead of by bidding, so a tier buys
 * protection against the price moving rather than priority.
 */
const HEADROOM_PCT: Record<FeeTier, bigint> = { low: 110n, market: 125n, aggressive: 150n };
/** Base-fee multipliers for the tiers on a public EIP-1559 chain. */
const BASE_MULTIPLIER: Record<FeeTier, bigint> = { low: 2n, market: 2n, aggressive: 3n };
/** Column of the 10/50/90 percentiles that each tier bids from. */
const PERCENTILE_COLUMN: Record<FeeTier, number> = { low: 0, market: 1, aggressive: 2 };

interface TierPrice {
  tier: FeeTier;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Gas price the quote expects to actually pay, execution layer only. */
  expectedGasPrice: bigint;
}

/**
 * Turns per-tier prices into the quote the UI consumes. `extraFee` is added to
 * both numbers because it is charged either way: the worst case has to cover it
 * or the insufficient-funds guard below it is a lie.
 */
function assemble(ctx: FeeContext, tiers: readonly TierPrice[], extraFee: bigint): FeeQuote<EvmFeeParams> {
  const blockSeconds = Math.max(1, Math.round(ctx.network.blockTimeMs / 1000));
  const options = {} as Record<FeeTier, FeeOption & { params: EvmFeeParams }>;
  for (const t of tiers) {
    options[t.tier] = {
      tier: t.tier,
      maxFee: ctx.gas * t.maxFeePerGas + extraFee,
      estimatedFee: ctx.gas * t.expectedGasPrice + extraFee,
      etaSeconds: BLOCKS_TO_INCLUDE[t.tier] * blockSeconds,
      params: {
        gas: ctx.gas,
        maxFeePerGas: t.maxFeePerGas,
        maxPriorityFeePerGas: t.maxPriorityFeePerGas,
        ...(extraFee > 0n ? { extraFee } : {}),
      },
    };
  }
  return { options, quotedAt: ctx.now() };
}

function quoteFailed(network: EvmNetwork, technical: string): WalletError {
  return new WalletError({
    code: 'FEE_QUOTE_FAILED',
    userTitle: `Can't price the fee on ${network.name}`,
    userMessage: 'The network did not answer our fee questions, so nothing was sent. Try again in a moment.',
    fundsMoved: 'no',
    retryable: true,
    // Error name only: messages from HTTP transports can embed the RPC URL.
    technical,
  });
}

/** A chain this build does not know how to price: nothing to retry, only a registry change. */
function unsupported(network: EvmNetwork): WalletError {
  return new WalletError({
    code: 'FEE_QUOTE_FAILED',
    userTitle: `Fees on ${network.name} are not supported yet`,
    userMessage: 'This wallet has no fee model for this network, so nothing was sent. Balances are still shown.',
    fundsMoved: 'no',
    retryable: false,
    technical: `unknown feeStrategy '${String(network.feeStrategy)}'`,
  });
}

function reason(e: unknown): string {
  return e instanceof Error ? e.name : 'unknown';
}

/** `eth_gasPrice`, never below what the chain itself will accept. */
async function nodeGasPrice(ctx: FeeContext, floor: bigint): Promise<bigint> {
  let price: bigint;
  try {
    price = await ctx.client.getGasPrice();
  } catch (e) {
    throw quoteFailed(ctx.network, reason(e));
  }
  return price < floor ? floor : price;
}

/** Tier ladder over a price the node quoted, for chains where bidding is not a queue. */
function headroomTiers(price: bigint, tip: bigint): TierPrice[] {
  return TIER_ORDER.map((tier) => {
    const max = (price * HEADROOM_PCT[tier]) / 100n;
    return {
      tier,
      // A tier cap below the tip would be an invalid EIP-1559 transaction.
      maxFeePerGas: max < tip ? tip : max,
      maxPriorityFeePerGas: tip,
      expectedGasPrice: price,
    };
  });
}

/**
 * Ethereum and Ethereum-like chains: sample the 10/50/90 priority-fee
 * percentiles of the last blocks and cap at a multiple of the next base fee
 * (spec §16.2). This is the model the wallet shipped with, unchanged.
 */
async function feeHistoryTiers(ctx: FeeContext): Promise<TierPrice[]> {
  let nextBase = 0n;
  let rewards: readonly (readonly bigint[])[] = [];
  try {
    const history = await ctx.client.getFeeHistory({ blockCount: 10, rewardPercentiles: [10, 50, 90], blockTag: 'latest' });
    nextBase = history.baseFeePerGas[history.baseFeePerGas.length - 1] ?? 0n;
    rewards = history.reward ?? [];
  } catch (e) {
    throw quoteFailed(ctx.network, reason(e));
  }
  return TIER_ORDER.map((tier) => {
    const column = rewards.map((r) => r[PERCENTILE_COLUMN[tier]] ?? 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const sampled = column.length ? column[Math.floor(column.length / 2)]! : 0n;
    const maxPriorityFeePerGas = sampled < MIN_PRIORITY_FEE ? MIN_PRIORITY_FEE : sampled;
    const maxFeePerGas = nextBase * BASE_MULTIPLIER[tier] + maxPriorityFeePerGas;
    return { tier, maxFeePerGas, maxPriorityFeePerGas, expectedGasPrice: nextBase + maxPriorityFeePerGas };
  });
}

const eip1559: FeeStrategy = {
  id: 'eip1559',
  async quote(ctx) {
    return assemble(ctx, await feeHistoryTiers(ctx), 0n);
  },
};

const gasPriceOracleAbi = [
  {
    type: 'function',
    name: 'getL1Fee',
    stateMutability: 'view',
    inputs: [{ name: '_transaction', type: 'bytes' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** Only the RLP length is priced, so the signature is fake but the same size as a real one. */
const REPRESENTATIVE_SIG = { r: `0x${'11'.repeat(32)}` as Hex, s: `0x${'22'.repeat(32)}` as Hex, yParity: 0 };

/**
 * OP-stack (Base and the chains built on the same stack): the L2 execution fee
 * plus what the sequencer charges for posting the transaction to Ethereum.
 * Skipping the second component under-quotes the cost the user actually pays and
 * gets the transaction rejected for insufficient funds at broadcast.
 *
 * The chain's own oracle is asked rather than the formula being modelled here:
 * the inputs and encoding have changed with each hardfork, while
 * `getL1Fee(bytes)` has stayed on the predeploy, so it reports whatever the node
 * is currently enforcing. The representative transaction uses nonce 0 because
 * small nonces encode to the same single RLP byte, so the size is accurate.
 */
const opStack: FeeStrategy = {
  id: 'op-stack',
  async quote(ctx) {
    const tiers = await feeHistoryTiers(ctx);
    const market = tiers.find((t) => t.tier === 'market')!;
    const extraFee = await l1DataFee(ctx, market);
    return assemble(ctx, tiers, extraFee);
  },
};

async function l1DataFee(ctx: FeeContext, market: TierPrice): Promise<bigint> {
  const representative = serializeTransaction(
    {
      type: 'eip1559',
      chainId: ctx.network.chainId,
      nonce: 0,
      to: ctx.call.to,
      value: ctx.call.value,
      ...(ctx.call.data ? { data: ctx.call.data } : {}),
      gas: ctx.gas,
      maxFeePerGas: market.maxFeePerGas,
      maxPriorityFeePerGas: market.maxPriorityFeePerGas,
    },
    REPRESENTATIVE_SIG,
  );
  try {
    const result = await ctx.client.call({
      to: OP_GAS_PRICE_ORACLE,
      data: encodeFunctionData({ abi: gasPriceOracleAbi, functionName: 'getL1Fee', args: [representative] }),
    });
    if (!result.data || result.data === '0x') throw new Error('empty result');
    return decodeFunctionResult({ abi: gasPriceOracleAbi, functionName: 'getL1Fee', data: result.data });
  } catch (e) {
    // A chain we cannot price in full is a chain we do not transact on.
    throw quoteFailed(ctx.network, reason(e));
  }
}

/**
 * Arbitrum: ArbOS sets the gas price from L1 conditions and the Rollup
 * parameters, and the result already contains the L1 component. `eth_feeHistory`
 * rewards do not describe what the sender pays, so the node's own price is used
 * with the network floor applied.
 */
const arbitrum: FeeStrategy = {
  id: 'arbitrum',
  async quote(ctx) {
    const price = await nodeGasPrice(ctx, ARBITRUM_MIN_GAS_PRICE);
    return assemble(ctx, headroomTiers(price, price), 0n);
  },
};

/**
 * The node's own tip suggestion, asked directly. viem's estimator answers from
 * fee history when a client carries no chain descriptor, which is the model the
 * `eip1559` strategy above already implements.
 */
async function suggestedTip(ctx: FeeContext): Promise<bigint> {
  try {
    return hexToBigInt(await ctx.client.request({ method: 'eth_maxPriorityFeePerGas' }));
  } catch {
    // A node that has not implemented the method prices from its gas floor alone.
    return 0n;
  }
}

/**
 * Polygon PoS: EIP-1559 on the surface, but the validators enforce a chain
 * minimum gas price that has been raised several times, so a tip sampled from
 * history can still produce a price the network will not include. The floor is
 * taken from `eth_gasPrice`, which already reflects whatever minimum the node is
 * enforcing, rather than from a constant that would go stale at the next upgrade.
 */
const polygon: FeeStrategy = {
  id: 'polygon',
  async quote(ctx) {
    const floor = await nodeGasPrice(ctx, 0n);
    const block = await ctx.client.getBlock({ blockTag: 'latest' }).catch(() => null);
    const tip = await suggestedTip(ctx);
    const base = block?.baseFeePerGas ?? 0n;
    const price = base + tip > floor ? base + tip : floor;
    // The minimum applies to the effective price, so lifting the tip is the only
    // way to reach it; leaving the tip as sampled would quote right and send wrong.
    const requiredTip = price > base ? price - base : 0n;
    return assemble(ctx, headroomTiers(price, requiredTip), 0n);
  },
};

const STRATEGIES: Record<FeeStrategyId, FeeStrategy> = {
  'eip1559': eip1559,
  'op-stack': opStack,
  arbitrum,
  polygon,
};

/**
 * Selected from the registry, never from a chain id tested inside the adapter:
 * a new chain has to say which fee model it uses (ADR 0016).
 */
export function feeStrategyFor(network: EvmNetwork): FeeStrategy {
  const strategy = STRATEGIES[network.feeStrategy];
  if (!strategy) throw unsupported(network);
  return strategy;
}
