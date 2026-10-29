import { describe, expect, it } from 'vitest';
import { custom, encodeFunctionData, numberToHex, parseEther, parseGwei } from 'viem';
import { assetsForNetwork, createNetworkRegistry, type TransferIntent } from '@qd/blockchain';
import { EvmAdapter, feeStrategyFor } from '../src';

const registry = createNetworkRegistry({ includeLocal: true });
const A0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const A1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const ORACLE = '0x420000000000000000000000000000000000000F';
/** Declared here as well, so the test pins the interface we assume the predeploy has. */
const oracleAbi = [
  {
    type: 'function',
    name: 'getL1Fee',
    stateMutability: 'view',
    inputs: [{ name: '_transaction', type: 'bytes' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
const GET_L1_FEE = encodeFunctionData({ abi: oracleAbi, functionName: 'getL1Fee', args: ['0x'] }).slice(0, 10);

/** 20 gwei next base fee; sampled tips of 0.000000001 / 1 / 2 gwei. */
const FEE_HISTORY = {
  oldestBlock: '0x1',
  baseFeePerGas: ['0x3b9aca00', '0x4a817c800'],
  gasUsedRatio: [0.5],
  reward: [
    ['0x1', '0x3b9aca00', '0x77359400'],
    ['0x1', '0x3b9aca00', '0x77359400'],
  ],
};

const block = (baseFee: bigint) => ({
  number: '0x10',
  hash: `0x${'aa'.repeat(32)}`,
  parentHash: `0x${'bb'.repeat(32)}`,
  sha3Uncles: `0x${'cc'.repeat(32)}`,
  miner: '0x0000000000000000000000000000000000000000',
  stateRoot: `0x${'dd'.repeat(32)}`,
  transactionsRoot: `0x${'ee'.repeat(32)}`,
  receiptsRoot: `0x${'ff'.repeat(32)}`,
  logsBloom: `0x${'00'.repeat(256)}`,
  difficulty: '0x0',
  gasLimit: '0x1c9c380',
  gasUsed: '0x0',
  timestamp: '0x68000000',
  extraData: '0x',
  mixHash: `0x${'11'.repeat(32)}`,
  nonce: '0x0000000000000000',
  totalDifficulty: '0x0',
  size: '0x220',
  baseFeePerGas: numberToHex(baseFee),
  transactions: [],
  uncles: [],
});

function fakeNode(overrides: Record<string, (params: unknown[]) => unknown> = {}) {
  const calls: string[] = [];
  const handlers: Record<string, (params: unknown[]) => unknown> = {
    eth_chainId: () => '0x1',
    eth_getCode: () => '0x',
    eth_estimateGas: () => '0x5208', // 21000, padded to 25200
    eth_getTransactionCount: () => '0x1',
    eth_feeHistory: () => FEE_HISTORY,
    eth_gasPrice: () => numberToHex(parseGwei('1')),
    eth_maxPriorityFeePerGas: () => numberToHex(parseGwei('1')),
    eth_getBlockByNumber: () => block(parseGwei('1')),
    // eth_call answers with the raw return-data hex, like a real node.
    eth_call: () => {
      throw new Error('eth_call is not wired in this fixture');
    },
    ...overrides,
  };
  const transport = custom({
    async request({ method, params }) {
      calls.push(method);
      const h = handlers[method];
      if (!h) throw new Error(`unexpected method ${method}`);
      return h((params ?? []) as unknown[]);
    },
  });
  return { transport, calls };
}

const intent = (networkId: string, amount = parseEther('0.001')): TransferIntent => ({
  from: A0,
  to: A1,
  asset: assetsForNetwork(registry.require(networkId))[0]!,
  amount,
});

const adapterFor = (networkId: string, overrides: Record<string, (params: unknown[]) => unknown> = {}) => {
  const node = fakeNode(overrides);
  const network = registry.require(networkId) as never;
  return { adapter: new EvmAdapter({ network, transport: node.transport }), calls: node.calls };
};

describe('fee strategies', () => {
  it('gives every network in the registry a strategy', () => {
    for (const network of registry.all()) expect(feeStrategyFor(network).id).toBe(network.feeStrategy);
  });

  it('refuses a registry entry that names a strategy that does not exist', () => {
    const broken = { ...registry.require('sepolia'), feeStrategy: 'legacy' } as never;
    let caught: unknown;
    try {
      feeStrategyFor(broken);
    } catch (e) {
      caught = e;
    }
    // Not a network problem, so retrying is not offered: the registry has to change.
    expect(caught).toMatchObject({ code: 'FEE_QUOTE_FAILED', fundsMoved: 'no', retryable: false });
    expect((caught as Error).message).toMatch(/no fee model for this network/);
  });

  it('quotes Ethereum from fee history and adds nothing outside the gas cap', async () => {
    const { adapter, calls } = adapterFor('eth-mainnet');
    const q = await adapter.estimateFee(intent('eth-mainnet'));
    expect(calls).toContain('eth_feeHistory');
    expect(q.options.market.params.maxFeePerGas).toBe(parseGwei('41')); // 2 x 20 gwei + 1 gwei
    expect(q.options.market.maxFee).toBe(25200n * parseGwei('41'));
    expect(q.options.market.estimatedFee).toBe(25200n * parseGwei('21'));
    expect(q.options.market.params.extraFee).toBeUndefined();
  });

  describe('OP-stack (Base)', () => {
    it('adds the L1 data fee to both quoted numbers', async () => {
      const { adapter, calls } = adapterFor('base', {
        eth_call: () => numberToHex(parseEther('0.0001'), { size: 32 }),
      });
      const q = await adapter.estimateFee(intent('base'));
      const gas = q.options.market.params.gas;
      const l1 = parseEther('0.0001');
      expect(q.options.market.params.extraFee).toBe(l1);
      expect(q.options.market.maxFee).toBe(gas * parseGwei('41') + l1);
      expect(q.options.market.estimatedFee).toBe(gas * parseGwei('21') + l1);
      // The question went to the chain's own oracle, over the proxy's allowlisted eth_call.
      expect(calls).toContain('eth_call');
      expect(calls).not.toContain('optimism_getL1Fee');
    });

    it('asks the oracle about a transaction of the size it will send', async () => {
      let seen = '';
      const { adapter } = adapterFor('base', {
        eth_call: (params) => {
          const [call] = params as [{ to: string; data: string }];
          seen = call.data;
          expect(call.to).toBe(ORACLE);
          return numberToHex(0n, { size: 32 });
        },
      });
      const q = await adapter.estimateFee(intent('base'));
      expect(seen.startsWith(GET_L1_FEE)).toBe(true);
      // A zero charge means the node folds the L1 cost into the gas price: no double count.
      expect(q.options.market.params.extraFee).toBeUndefined();
      expect(q.options.market.maxFee).toBe(q.options.market.params.gas * q.options.market.params.maxFeePerGas);
    });

    it('sizes the L1 fee on the transaction it will actually send', async () => {
      // Oracle stand-in that reports the size of what it was asked about, so the
      // assertion is about sizing rather than about the fee formula.
      const bySize = (params: unknown[]) => {
        const [call] = params as [{ data: string }];
        return numberToHex(BigInt((call.data.length - 10) / 2), { size: 32 });
      };
      const { adapter } = adapterFor('base', { eth_call: bySize });
      const native = await adapter.estimateFee(intent('base'));
      const usdc = adapter.listAssets().find((a) => a.symbol === 'USDC')!;
      const token = await adapter.estimateFee({ from: A0, to: A1, asset: usdc, amount: 1_000_000n });
      // An ERC-20 transfer carries 68 bytes of calldata, which the sequencer posts to
      // Ethereum and charges for, so a quote sized off a bare transfer under-states it.
      expect(token.options.market.params.extraFee! > native.options.market.params.extraFee!).toBe(true);
    });

    it('fails the quote rather than sending a fee that misses the L1 component', async () => {
      const { adapter } = adapterFor('base', {
        eth_call: () => {
          throw new Error('execution reverted');
        },
      });
      await expect(adapter.estimateFee(intent('base'))).rejects.toMatchObject({
        code: 'FEE_QUOTE_FAILED',
        fundsMoved: 'no',
        retryable: true,
      });
    });
  });

  describe('Arbitrum', () => {
    it('prices from eth_gasPrice and never samples fee history', async () => {
      const { adapter, calls } = adapterFor('arbitrum', { eth_gasPrice: () => numberToHex(parseGwei('0.02')) });
      const q = await adapter.estimateFee(intent('arbitrum'));
      expect(calls).not.toContain('eth_feeHistory');
      const price = parseGwei('0.02');
      expect(q.options.market.estimatedFee).toBe(25200n * price);
      expect(q.options.low.maxFee < q.options.market.maxFee).toBe(true);
      expect(q.options.market.maxFee < q.options.aggressive.maxFee).toBe(true);
      expect(q.options.low.params.maxPriorityFeePerGas).toBe(price);
    });

    it('lifts a node price below the 0.01 gwei network floor', async () => {
      const { adapter } = adapterFor('arbitrum', { eth_gasPrice: () => '0x1' });
      const q = await adapter.estimateFee(intent('arbitrum'));
      expect(q.options.market.params.maxPriorityFeePerGas).toBe(parseGwei('0.01'));
    });

    it('keeps every tier cap at or above its tip', async () => {
      const { adapter } = adapterFor('arbitrum', { eth_gasPrice: () => numberToHex(parseGwei('0.01')) });
      const q = await adapter.estimateFee(intent('arbitrum'));
      for (const tier of ['low', 'market', 'aggressive'] as const) {
        const p = q.options[tier].params;
        expect(p.maxFeePerGas >= p.maxPriorityFeePerGas).toBe(true);
      }
    });
  });

  describe('Polygon PoS', () => {
    it('raises the tip so the effective price reaches the chain minimum', async () => {
      const { adapter } = adapterFor('polygon', {
        eth_gasPrice: () => numberToHex(parseGwei('100')),
        eth_getBlockByNumber: () => block(parseGwei('50')),
        eth_maxPriorityFeePerGas: () => numberToHex(parseGwei('30')),
      });
      const q = await adapter.estimateFee(intent('polygon'));
      const p = q.options.market.params;
      // base + tip would be 80 gwei on its own; the node's 100 gwei floor wins,
      // and the gap is closed in the tip because that is what the sender controls.
      expect(p.maxPriorityFeePerGas).toBe(parseGwei('50'));
      expect(q.options.market.estimatedFee).toBe(25200n * parseGwei('100'));
      expect(p.maxFeePerGas).toBe(parseGwei('125'));
    });

    it('keeps a sampled tip that already clears the minimum', async () => {
      const { adapter } = adapterFor('polygon', {
        eth_gasPrice: () => numberToHex(parseGwei('100')),
        eth_getBlockByNumber: () => block(parseGwei('50')),
        eth_maxPriorityFeePerGas: () => numberToHex(parseGwei('100')),
      });
      const q = await adapter.estimateFee(intent('polygon'));
      expect(q.options.market.params.maxPriorityFeePerGas).toBe(parseGwei('100'));
      expect(q.options.market.estimatedFee).toBe(25200n * parseGwei('150'));
    });
  });
});

describe('a Base quote survives the rest of the send path', () => {
  it('builds and describes a transaction from the quoted params', async () => {
    const { adapter } = adapterFor('base', { eth_call: () => numberToHex(parseEther('0.0001'), { size: 32 }) });
    const q = await adapter.estimateFee(intent('base'));
    const unsigned = await adapter.buildTransaction(intent('base'), q.options.market);
    expect(unsigned.tx).toMatchObject({ chainId: 8453, gas: 25200n });
    expect(adapter.describe(unsigned).maxFee).toBe(25200n * q.options.market.params.maxFeePerGas);
  });
});
