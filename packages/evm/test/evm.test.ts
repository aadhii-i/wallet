import { describe, expect, it } from 'vitest';
import { custom, encodeFunctionData, erc20Abi, http, parseEther, parseGwei, serializeTransaction } from 'viem';
import { createNetworkRegistry, assetsForNetwork, type TransferIntent } from '@qd/blockchain';
import { HDKeyring, HDSigner } from '@qd/wallet-core';
import { EvmAdapter, NonceTracker, discoverAccounts, type EvmUnsignedTx } from '../src';

const registry = createNetworkRegistry({ includeLocal: true });
const anvil = registry.require('anvil') as never;
const mainnet = registry.require('eth-mainnet') as never;
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const A0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const A1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/** Minimal fake JSON-RPC node for deterministic unit tests. */
function fakeNode(overrides: Record<string, (params: unknown[]) => unknown> = {}) {
  const calls: string[] = [];
  const handlers: Record<string, (params: unknown[]) => unknown> = {
    eth_chainId: () => '0x1',
    eth_getCode: () => '0x',
    eth_estimateGas: () => '0xfde8', // 65000
    eth_getTransactionCount: () => '0x5',
    eth_feeHistory: () => ({
      oldestBlock: '0x1',
      baseFeePerGas: ['0x3b9aca00', '0x3b9aca00', '0x4a817c800'], // next base = 20 gwei
      gasUsedRatio: [0.5, 0.5],
      reward: [
        ['0x1', '0x3b9aca00', '0x77359400'],
        ['0x1', '0x3b9aca00', '0x77359400'],
      ],
    }),
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

const intentNative = (amount = parseEther('1')): TransferIntent => ({
  from: A0,
  to: A1,
  asset: assetsForNetwork(mainnet)[0]!,
  amount,
});

describe('EvmAdapter (unit)', () => {
  it('validates addresses with EIP-55', () => {
    const a = new EvmAdapter({ network: mainnet, transport: fakeNode().transport });
    expect(a.validateAddress(A1.toLowerCase())).toEqual({ valid: true, normalized: A1 });
    expect(a.validateAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79c8').reason).toBe('checksum');
    expect(a.validateAddress('0x1234').reason).toBe('format');
    expect(a.validateAddress(' ' + A1 + ' ').valid).toBe(true);
  });

  it('uses exactly 21000 gas for EOA transfers and orders fee tiers', async () => {
    const { transport, calls } = fakeNode();
    const a = new EvmAdapter({ network: mainnet, transport });
    const q = await a.estimateFee(intentNative());
    expect(calls).not.toContain('eth_estimateGas');
    expect(q.options.market.params.gas).toBe(21000n);
    expect(q.options.market.params.maxPriorityFeePerGas).toBe(parseGwei('1'));
    expect(q.options.market.params.maxFeePerGas).toBe(parseGwei('41'));
    expect(q.options.low.maxFee <= q.options.market.maxFee).toBe(true);
    expect(q.options.market.maxFee <= q.options.aggressive.maxFee).toBe(true);
    expect(q.options.low.params.maxPriorityFeePerGas).toBe(1_000_000n); // floored
  });

  it('pads estimateGas by 20% for token transfers', async () => {
    const { transport } = fakeNode();
    const a = new EvmAdapter({ network: mainnet, transport });
    const usdc = a.listAssets().find((x) => x.symbol === 'USDC')!;
    const q = await a.estimateFee({ from: A0, to: A1, asset: usdc, amount: 1_000_000n });
    expect(q.options.market.params.gas).toBe(78000n);
  });

  it('builds with the registry chain id, never the RPC one', async () => {
    const { transport } = fakeNode({ eth_chainId: () => '0x2a' });
    const a = new EvmAdapter({ network: mainnet, transport });
    const q = await a.estimateFee(intentNative());
    const u = await a.buildTransaction(intentNative(), q.options.market);
    expect(u.tx.chainId).toBe(1);
    expect(u.tx.nonce).toBe(5);
    expect(a.describe(u)).toMatchObject({ to: A1, amount: parseEther('1'), networkId: 'eth-mainnet', nonce: 5 });
  });

  it('describes ERC-20 transfers from calldata', async () => {
    const { transport } = fakeNode();
    const a = new EvmAdapter({ network: mainnet, transport });
    const usdc = a.listAssets().find((x) => x.symbol === 'USDC')!;
    const q = await a.estimateFee({ from: A0, to: A1, asset: usdc, amount: 2_500_000n });
    const u = await a.buildTransaction({ from: A0, to: A1, asset: usdc, amount: 2_500_000n }, q.options.market);
    const d = a.describe(u);
    expect(d.asset.symbol).toBe('USDC');
    expect(d.to).toBe(A1);
    expect(d.amount).toBe(2_500_000n);
    expect(u.tx.to).toBe(usdc.contract);
  });

  it('refuses to describe a tx for another chain or an unknown contract call', () => {
    const a = new EvmAdapter({ network: mainnet, transport: fakeNode().transport });
    const base = { type: 'eip1559' as const, nonce: 0, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
    const wrongChain: EvmUnsignedTx = {
      networkId: 'eth-mainnet',
      from: A0,
      tx: { ...base, chainId: 10, to: A1 },
      serializedUnsigned: serializeTransaction({ ...base, chainId: 10, to: A1 }),
      warnings: [],
    };
    expect(() => a.describe(wrongChain)).toThrow(/network/);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [A1, 1n] });
    const approve = serializeTransaction({ ...base, chainId: 1, to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', data });
    expect(() => a.describe({ ...wrongChain, serializedUnsigned: approve })).toThrow(/Unsupported token call/);
  });

  it('rejects absurd gas limits from the RPC', async () => {
    const { transport } = fakeNode({ eth_getCode: () => '0x6000', eth_estimateGas: () => '0x3b9aca00' });
    const a = new EvmAdapter({ network: mainnet, transport });
    const q = await a.estimateFee(intentNative());
    await expect(a.buildTransaction(intentNative(), q.options.market)).rejects.toMatchObject({ code: 'GAS_ESTIMATION_FAILED' });
  });

  it('never reuses a nonce when the RPC lags behind local state', async () => {
    const tracker = new NonceTracker();
    tracker.markUsed(1, A0, 7);
    const { transport } = fakeNode(); // RPC says 5
    const a = new EvmAdapter({ network: mainnet, transport, nonceTracker: tracker });
    const q = await a.estimateFee(intentNative());
    const u = await a.buildTransaction(intentNative(), q.options.market);
    expect(u.tx.nonce).toBe(8);
    expect(u.warnings).toContain('NONCE_BEHIND_LOCAL');
  });

  it('detects an RPC that returns a different tx hash on broadcast', async () => {
    const { transport } = fakeNode({ eth_sendRawTransaction: () => `0x${'11'.repeat(32)}` });
    const a = new EvmAdapter({ network: mainnet, transport });
    await expect(
      a.broadcastTransaction({ networkId: 'eth-mainnet', raw: '0x02', hash: `0x${'22'.repeat(32)}` }),
    ).rejects.toMatchObject({ code: 'BROADCAST_UNKNOWN' });
  });
});

const ANVIL_URL = process.env.ANVIL_RPC_URL;

describe.runIf(ANVIL_URL)('EvmAdapter against Anvil (integration)', () => {
  it('derives, signs, broadcasts and confirms a native transfer', async () => {
    const adapter = new EvmAdapter({ network: anvil, transport: http(ANVIL_URL) });
    const keyring = await HDKeyring.fromMnemonic(ANVIL_MNEMONIC);
    const signer = new HDSigner(keyring);
    const from = keyring.evmAddress(0);
    const to = keyring.evmAddress(9);

    const before = await adapter.getBalance(to);
    const intent: TransferIntent = { from, to, asset: adapter.listAssets()[0]!, amount: parseEther('0.25') };
    const quote = await adapter.estimateFee(intent);
    const unsigned = await adapter.buildTransaction(intent, quote.options.market);
    const review = adapter.describe(unsigned);
    expect(review).toMatchObject({ from, to, amount: parseEther('0.25') });

    const payload = adapter.signingPayload(unsigned);
    const token = signer.confirmations.issue(payload);
    const sig = await signer.sign({ account: { id: 'a0', hdIndex: 0 }, payload, confirmation: token });
    const signed = adapter.assembleSigned(unsigned, sig);
    const hash = await adapter.broadcastTransaction(signed);
    expect(hash).toBe(signed.hash);

    const final = await adapter.waitForFinal(hash, { timeoutMs: 20_000 });
    expect(final.status).toBe('confirmed');
    expect(final.fee! > 0n).toBe(true);
    expect(await adapter.getBalance(to)).toBe(before + parseEther('0.25'));
  }, 30_000);

  it('discovers funded accounts on import', async () => {
    const adapter = new EvmAdapter({ network: anvil, transport: http(ANVIL_URL) });
    const keyring = await HDKeyring.fromMnemonic(ANVIL_MNEMONIC);
    // Anvil funds indexes 0..9; with gap 2 and max 12 we should see 0..9
    const used = await discoverAccounts([adapter], (i) => keyring.evmAddress(i), { gap: 2, max: 12 });
    expect(used).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }, 30_000);
});

describe('NonceTracker persistence (audit finding 7)', () => {
  it('restores and reports snapshots', () => {
    const snaps: Record<string, number>[] = [];
    const t = new NonceTracker({ [`1:${A0.toLowerCase()}`]: 4 }, (s) => snaps.push(s));
    expect(t.lastUsed(1, A0)).toBe(4);
    t.markUsed(1, A0, 3); // lower nonce never regresses
    expect(snaps).toHaveLength(0);
    t.markUsed(1, A0, 5);
    expect(snaps.at(-1)).toEqual({ [`1:${A0.toLowerCase()}`]: 5 });
  });
});
