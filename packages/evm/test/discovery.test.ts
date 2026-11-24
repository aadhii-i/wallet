import { describe, expect, it } from 'vitest';
import { discoverAccounts, type EvmAdapter } from '../src';

/** A fake adapter: `used` indexes have a nonce; `failures[i]` lookups of index i throw first (e.g. HTTP 429). */
function fakeAdapter(used: number[], failures: Record<number, number> = {}) {
  const left = { ...failures };
  const indexOf = (address: string) => Number.parseInt(address.slice(2), 16);
  const lookup = (address: string) => {
    const i = indexOf(address);
    if ((left[i] ?? 0) > 0) {
      left[i]!--;
      return Promise.reject(new Error('HTTP request failed. Status: 429'));
    }
    return Promise.resolve(i);
  };
  const client = {
    getTransactionCount: async ({ address }: { address: string }) => (used.includes(await lookup(address)) ? 1 : 0),
    getBalance: async () => 0n,
  };
  return { client } as unknown as EvmAdapter;
}
const addressAt = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;

describe('discoverAccounts', () => {
  it('finds used accounts up to the gap limit', async () => {
    expect(await discoverAccounts([fakeAdapter([0, 1, 3])], addressAt, { gap: 2, retryDelaysMs: [] })).toEqual([0, 1, 3]);
  });

  it('retries a rate-limited lookup instead of dropping a used account', async () => {
    const used = await discoverAccounts([fakeAdapter([0, 1, 2], { 1: 1 })], addressAt, { gap: 2, retryDelaysMs: [1, 1] });
    expect(used).toEqual([0, 1, 2]);
  });

  it('counts an index as unused only after every retry fails', async () => {
    const used = await discoverAccounts([fakeAdapter([0, 1], { 1: 5 })], addressAt, { gap: 2, retryDelaysMs: [1, 1] });
    expect(used).toEqual([0]);
  });
});
