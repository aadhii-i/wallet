import { describe, expect, it } from 'vitest';
import type { ActivityItem, ApiBtcTransaction } from '@qd/shared-types';
import { bitcoinWalletHistory, classifyBitcoinTransaction } from './bitcoin-history';

const template: ActivityItem = {
  hash: 'tx',
  networkId: 'btc-testnet4',
  direction: 'in',
  from: '',
  to: '',
  assetId: 'btc-testnet4:native',
  amount: '0',
  status: 'confirmed',
  timestamp: '2026-11-24T00:00:00Z',
  flags: [],
};
const tx: ApiBtcTransaction = {
  txid: 'tx',
  status: 'confirmed',
  confirmations: 1,
  value: '99000',
  fee: '1000',
  inputs: [{ address: 'legacy', value: '100000' }],
  outputs: [
    { address: 'recipient', value: '40000' },
    { address: 'change', value: '59000' },
  ],
};
describe('account-level Bitcoin history', () => {
  it('does not count internal change as an external payment', () => {
    const result = classifyBitcoinTransaction(tx, new Set(['legacy', 'change']), template);
    expect(result.direction).toBe('out');
    expect(result.amount).toBe('40000');
    expect(result.to).toBe('recipient');
  });
  it('deduplicates transactions appearing under receive and change histories', async () => {
    const page = await bitcoinWalletHistory(
      ['legacy', 'change'],
      undefined,
      async () => ({ items: [template] }),
      async () => tx,
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.amount).toBe('40000');
  });
  it('does not silently truncate a broken pagination loop or provider error', async () => {
    await expect(
      bitcoinWalletHistory(
        ['legacy'],
        undefined,
        async () => ({ items: [], nextCursor: 'repeat' }),
        async () => tx,
      ),
    ).rejects.toThrow(/advance/);
    await expect(
      bitcoinWalletHistory(
        ['legacy'],
        undefined,
        async () => {
          throw new Error('offline');
        },
        async () => tx,
      ),
    ).rejects.toThrow('offline');
  });
});
