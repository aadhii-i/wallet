import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountId, Client, Hbar, PrivateKey, Transaction, TransactionId, TransferTransaction } from '@hashgraph/sdk';
import { hederaWireText } from '@qd/hedera';
import { submitSharedHedera } from './hedera-shared-client';

const mirror = vi.hoisted(() => ({ intent: '' }));
vi.mock('./api', () => ({
  getApi: async () => ({
    hederaSharedReceipt: async () => ({ found: true, result: 'SUCCESS', intentMemo: mirror.intent }),
  }),
}));
afterEach(() => vi.restoreAllMocks());
describe('exact-byte shared Hedera submission', () => {
  for (const status of ['SUCCESS', 'INSUFFICIENT_ACCOUNT_BALANCE', 'OTHER_OPERATION'])
    it(`requires a ${status === 'SUCCESS' ? 'successful receipt' : 'failure result without inventing a new transaction'}`, async () => {
      const intentMemo = `QDWallet:55555555-5555-4555-8555-555555555555:${'A'.repeat(43)}`;
      mirror.intent = status === 'OTHER_OPERATION' ? 'another reviewed operation' : intentMemo;
      const id = TransactionId.generate('0.0.123'),
        transaction = new TransferTransaction()
          .addHbarTransfer('0.0.123', Hbar.fromTinybars('-100'))
          .addHbarTransfer('0.0.124', Hbar.fromTinybars('100'))
          .setNodeAccountIds([new AccountId(3)])
          .setTransactionMemo(intentMemo)
          .setTransactionId(id)
          .freeze();
      await transaction.sign(PrivateKey.fromBytesECDSA(new Uint8Array(32).fill(1)));
      const raw = hederaWireText(transaction.toBytes());
      const execute = vi.spyOn(Transaction.prototype, 'execute').mockImplementation(async function (
        this: Transaction,
        client,
      ) {
        expect(client?.defaultRegenerateTransactionId).toBe(false);
        expect(hederaWireText(this.toBytes())).toBe(raw);
        return {
          transactionId: id,
          getReceipt: async () => ({ status: { toString: () => (status === 'OTHER_OPERATION' ? 'SUCCESS' : status) } }),
        } as never;
      });
      const result = submitSharedHedera({
        raw,
        transactionId: id.toString(),
        expiresAt: Date.now() + 60000,
        intentMemo,
      });
      if (status === 'SUCCESS')
        await expect(result).resolves.toMatchObject({ transactionId: id.toString(), status: 'SUCCESS' });
      else if (status === 'OTHER_OPERATION') await expect(result).rejects.toThrow(/another operation/);
      else await expect(result).rejects.toThrow(/network fee may have been charged/);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  it('refuses an expired saved transaction before any SDK submission', async () => {
    const execute = vi.spyOn(Transaction.prototype, 'execute');
    await expect(
      submitSharedHedera({ raw: '', transactionId: '', intentMemo: '', expiresAt: Date.now() - 1 }),
    ).rejects.toThrow(/expired/);
    expect(execute).not.toHaveBeenCalled();
  });
});
