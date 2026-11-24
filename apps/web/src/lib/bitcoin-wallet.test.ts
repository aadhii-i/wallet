import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BitcoinDataSource } from '@qd/bitcoin';
import { bitcoinWalletScope } from './bitcoin-wallet';

let next = 0;
vi.mock('./vault-client', () => ({
  vault: {
    call: vi.fn(async (method: string, request: Record<string, number>) => {
      if (method === 'btcAddress') return { address: 'legacy' };
      if (method === 'btcChangePlan') {
        if (request.highestUsed !== undefined) next = Math.max(next, request.highestUsed + 1);
        return { address: `change-${next}`, index: next, unavailable: [], pending: [] };
      }
      if (method === 'btcChangeAddresses')
        return Array.from({ length: request.count! }, (_, i) => ({
          address: `change-${request.start! + i}`,
          changeIndex: request.start! + i,
        }));
      throw new Error('unexpected request');
    }),
  },
}));

function source(used: (address: string) => Promise<boolean>): BitcoinDataSource {
  return {
    chain: 'testnet4',
    isAddressUsed: used,
    getUtxos: async () => [],
    getFees: async () => ({ low: 1, market: 2, aggressive: 3, tipHeight: 1, quotedAt: 0 }),
    getTipHeight: async () => 1n,
    getHistory: async () => ({ items: [] }),
    getTransaction: async () => null,
    broadcast: async () => '',
  };
}
beforeEach(() => {
  next = 0;
  vi.clearAllMocks();
});
describe('Bitcoin change discovery', () => {
  it('finds spent internal addresses beyond a small unused gap and advances the next index', async () => {
    const reads: string[] = [];
    const scope = bitcoinWalletScope(
      0,
      'testnet4',
      'p2wpkh',
      source(async (address) => {
        reads.push(address);
        return address === 'change-2';
      }),
    );
    const found = await scope.discover();
    expect(found.highestUsed).toBe(2);
    expect(found.addresses.map((a) => a.address)).toEqual(['legacy', 'change-2']);
    expect(reads.at(-1)).toBe('change-22');
    expect(await scope.change()).toEqual({ address: 'change-3', index: 3 });
  });
  it('does not report provider failure as zero funds or unused addresses', async () => {
    const scope = bitcoinWalletScope(
      0,
      'testnet4',
      'p2wpkh',
      source(async () => {
        throw new Error('provider offline');
      }),
    );
    await expect(scope.discover()).rejects.toThrow('provider offline');
  });
  it('shares discovery requests and invalidates the cache after signing advances allocation', async () => {
    const used = vi.fn(async () => false);
    const scope = bitcoinWalletScope(0, 'testnet4', 'p2wpkh', source(used));
    await Promise.all([scope.discover(), scope.discover()]);
    expect(used).toHaveBeenCalledTimes(20);
    await scope.discover();
    expect(used).toHaveBeenCalledTimes(20);
    next = 1;
    const result = await scope.discover();
    expect(result.addresses.map((a) => a.address)).toContain('change-0');
    expect(used).toHaveBeenCalledTimes(40);
  });
});
