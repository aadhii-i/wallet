import { afterEach, describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver, focusManager, type QueryObserverResult } from '@tanstack/react-query';
import type { GasTransfer, RelayerChainStatus } from '@qd/rpc';
import { balanceView, eth, gasHealth, gwei, preferredChain, rechargeCount, transferEffectWei } from './gas-service';

type ChainState = { balanceWei: string; nonce: number; deployed: boolean };

afterEach(() => focusManager.setFocused(undefined));

/** Runs a real react-query observer until `until` holds; returns that result. */
async function observe(fn: () => Promise<ChainState>, until: (r: QueryObserverResult<ChainState>) => boolean) {
  const client = new QueryClient();
  const obs = new QueryObserver<ChainState>(client, { queryKey: ['qd-account-chain', 31337, '0xabc'], queryFn: fn, retry: 1, retryDelay: 0 });
  return new Promise<QueryObserverResult<ChainState>>((resolve) => {
    const unsub = obs.subscribe((r) => {
      if (until(r)) {
        unsub();
        resolve(r);
      }
    });
  });
}

describe('balanceView (root cause of "chain.data is undefined")', () => {
  it('a failing balance read in a background window leaves the query pending+paused with no data', async () => {
    // Another participant's browser window is not focused; its local Anvil RPC is down.
    focusManager.setFocused(false);
    const r = await observe(
      () => Promise.reject(new Error('connection refused')),
      (x) => x.fetchStatus === 'paused',
    );
    // The old render assumed: !isLoading && !isError ⇒ data. This state breaks it.
    expect(r.isLoading).toBe(false);
    expect(r.isError).toBe(false);
    expect(r.data).toBeUndefined();
    expect(balanceView('0xabc', r)).toEqual({ kind: 'paused' });
  });

  it('maps every state without touching missing data', async () => {
    const ok = await observe(async () => ({ balanceWei: '1000000000000000000', nonce: 0, deployed: false }), (x) => x.status === 'success');
    expect(balanceView('0xabc', ok)).toEqual({ kind: 'ready', data: { balanceWei: '1000000000000000000', nonce: 0, deployed: false } });
    const failed = await observe(() => Promise.reject(new Error('rpc down')), (x) => x.status === 'error');
    expect(balanceView('0xabc', failed)).toEqual({ kind: 'error', message: 'rpc down' });
    expect(balanceView(null, ok)).toEqual({ kind: 'no-address' });
    expect(balanceView('0xabc', { status: 'pending', fetchStatus: 'fetching', data: undefined, error: null })).toEqual({ kind: 'loading' });
    // Disabled query (no address yet): idle, not loading, not error.
    expect(balanceView('', { status: 'pending', fetchStatus: 'idle', data: undefined, error: null })).toEqual({ kind: 'no-address' });
  });
});

const chain = (over: Partial<RelayerChainStatus>): RelayerChainStatus => ({
  chainId: 11155111, rpcConfigured: true, rpcOk: true, relayerConfigured: true, verifierAddress: '0x', factoryAddress: '0x', ready: true, problems: [], ...over,
});

describe('gas service helpers', () => {
  it('reports unknown (never zero) when the balance is unavailable', () => {
    expect(gasHealth(undefined)).toBe('unknown');
    expect(gasHealth(chain({ relayerBalanceWei: undefined, health: 'healthy' }))).toBe('unknown');
    expect(gasHealth(chain({ relayerConfigured: false }))).toBe('unknown');
    expect(gasHealth(chain({ relayerBalanceWei: '0', health: 'insufficient' }))).toBe('insufficient');
    expect(eth(null)).toBe('unavailable');
  });

  it('never rounds small requirements to zero', () => {
    expect(eth('7036112')).toBe('0.000000000007036112 ETH');
    expect(eth('50000000000000000', 'SepoliaETH')).toBe('0.05 SepoliaETH');
    expect(gwei('17')).toBe('0.000000017 gwei');
    expect(gwei('1500000000')).toBe('1.5 gwei');
  });

  it('starts on a network that works here: Anvil when it is up, else Sepolia', () => {
    const ids = [31337, 11155111, 84532];
    expect(preferredChain(ids, [chain({ chainId: 31337, rpcOk: true }), chain({ chainId: 11155111 })])).toBe(31337);
    expect(preferredChain(ids, [chain({ chainId: 31337, rpcOk: false }), chain({ chainId: 11155111 })])).toBe(11155111);
    expect(preferredChain(ids, undefined)).toBe(11155111);
  });

  it('computes the balance effect of history entries and counts recharges', () => {
    const base: GasTransfer = {
      txHash: '0x1', direction: 'in', kind: 'recharge', counterparty: '0xf', valueWei: '100', gasUsed: 0, gasPriceWei: '', feeWei: '',
      success: true, blockNumber: 1, blockTime: '2026-11-15T00:00:00Z',
    };
    const out: GasTransfer = { ...base, txHash: '0x2', direction: 'out', kind: 'execute', valueWei: '0', gasUsed: 10, gasPriceWei: '17', feeWei: '170' };
    expect(transferEffectWei(base)).toBe(100n);
    expect(transferEffectWei({ ...base, success: false })).toBe(0n);
    expect(transferEffectWei(out)).toBe(-170n);
    expect(transferEffectWei({ ...out, success: false })).toBe(-170n); // a reverted transaction still pays gas
    expect(rechargeCount([base, out, { ...base, txHash: '0x3', success: false }])).toBe(1);
  });
});
