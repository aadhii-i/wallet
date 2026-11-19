import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Receipt/submission tests for buildAndSubmitHbarTransfer.
 *
 * The SDK and the KeyWorker bridge are mocked so no key material is touched and
 * no transaction can reach a real network. The assertions cover the two things
 * the UI depends on: the exact signing account/index, and that only a SUCCESS
 * receipt is reported as a confirmed transfer.
 */

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  close: vi.fn(),
  sign: vi.fn(),
  issueConfirmation: vi.fn(),
}));

vi.mock('./vault-client', () => ({
  vault: {
    call: async (op: string, args: unknown) => {
      if (op === 'issueConfirmation') return h.issueConfirmation(args);
      if (op === 'sign') return h.sign(args);
      throw new Error(`unexpected vault op: ${op}`);
    },
  },
}));

vi.mock('@hashgraph/sdk', () => {
  class AccountId {
    static fromString(_value: string) {
      return new AccountId();
    }
  }

  class Hbar {
    static fromTinybars(_value: string) {
      return new Hbar();
    }
  }

  class TransactionId {
    static generate() {
      return new TransactionId();
    }
  }

  class TransferTransaction {
    addHbarTransfer() {
      return this;
    }
    setNodeAccountIds() {
      return this;
    }
    setTransactionId() {
      return this;
    }
    freeze() {
      return this;
    }
    toBytes() {
      return new Uint8Array([1, 2, 3]);
    }
  }

  class AccountCreateTransaction extends TransferTransaction {}

  class PublicKey {
    static fromString(_value: string) {
      return new PublicKey();
    }
  }

  class Client {
    close() {
      h.close();
    }
    static forTestnet() {
      return new Client();
    }
  }

  const Transaction = {
    fromBytes(_bytes: Uint8Array) {
      return { execute: h.execute };
    },
  };

  return {
    AccountId,
    AccountCreateTransaction,
    Hbar,
    PublicKey,
    Transaction,
    TransactionId,
    TransferTransaction,
    Client,
  };
});

import { buildAndSubmitHbarTransfer, HederaTransferError, isSuccessfulHederaReceipt } from './hedera-transfer';

const FROM = '0.0.11473900';
const TO = '0.0.11473975';
const TX_ID = '0.0.11473900@1700000000.000000000';
const ACCOUNT_API_ID = 'backend-account-7';
const HD_INDEX = 7;

const params = {
  fromAccountId: FROM,
  toAccountId: TO,
  amountTinybars: 100_000_000n,
  hdIndex: HD_INDEX,
  accountApiId: ACCOUNT_API_ID,
};

function responseWithStatus(status: string) {
  return {
    transactionId: { toString: () => TX_ID },
    getReceipt: async () => ({ status: { toString: () => status } }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.issueConfirmation.mockResolvedValue('confirmation-token');
  h.sign.mockResolvedValue({
    kind: 'hedera-transfer',
    signerKind: 'hd',
    signedBytes: Buffer.from([4, 5, 6]).toString('base64'),
  });
  h.execute.mockResolvedValue(responseWithStatus('SUCCESS'));
});

describe('buildAndSubmitHbarTransfer submission', () => {
  it('accepts only the SUCCESS receipt status', () => {
    expect(isSuccessfulHederaReceipt('SUCCESS')).toBe(true);
    expect(isSuccessfulHederaReceipt('success')).toBe(false);
    expect(isSuccessfulHederaReceipt('INSUFFICIENT_ACCOUNT_BALANCE')).toBe(false);
    expect(isSuccessfulHederaReceipt('UNKNOWN')).toBe(false);
  });

  it('signs with the selected HD index and the backend account id, then requires SUCCESS', async () => {
    const result = await buildAndSubmitHbarTransfer(params);

    expect(result).toEqual({ transactionId: TX_ID, status: 'SUCCESS' });

    // The confirmation token is issued and consumed; signing is never bypassed.
    expect(h.issueConfirmation).toHaveBeenCalledTimes(1);
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(h.sign).toHaveBeenCalledWith({
      account: { id: ACCOUNT_API_ID, hdIndex: HD_INDEX },
      payload: expect.objectContaining({
        kind: 'hedera-transfer',
        fromAccountId: FROM,
        toAccountId: TO,
        amountTinybars: '100000000',
      }),
      confirmation: 'confirmation-token',
    });
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('does not pass a payer key or any key material to the worker', async () => {
    await buildAndSubmitHbarTransfer(params);

    const request = h.sign.mock.calls[0]?.[0] as {
      payload: Record<string, unknown>;
      account: Record<string, unknown>;
    };
    expect(request.payload).not.toHaveProperty('payerPrivateKeyHex');
    expect(request.payload).not.toHaveProperty('privateKey');
    expect(request.account).not.toHaveProperty('privateKey');
    expect(JSON.stringify(request)).not.toMatch(/payerPrivateKeyHex|privateKey|mnemonic|seed/i);
  });

  it('reports a non-SUCCESS receipt as a typed failure with the transaction id', async () => {
    h.execute.mockResolvedValue(responseWithStatus('INSUFFICIENT_ACCOUNT_BALANCE'));

    const error = await buildAndSubmitHbarTransfer(params).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HederaTransferError);
    expect((error as HederaTransferError).transactionId).toBe(TX_ID);
    expect((error as HederaTransferError).status).toBe('INSUFFICIENT_ACCOUNT_BALANCE');
    expect((error as Error).message).toMatch(/INSUFFICIENT_ACCOUNT_BALANCE/);
  });

  it('maps an SDK receipt error status and keeps the transaction id', async () => {
    h.execute.mockResolvedValue({
      transactionId: { toString: () => TX_ID },
      getReceipt: async () => {
        throw Object.assign(new Error('receipt failed'), {
          status: { toString: () => 'INVALID_SIGNATURE' },
        });
      },
    });

    const error = await buildAndSubmitHbarTransfer(params).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HederaTransferError);
    expect((error as HederaTransferError).transactionId).toBe(TX_ID);
    expect((error as HederaTransferError).status).toBe('INVALID_SIGNATURE');
  });

  it('treats an unreadable receipt as unconfirmed instead of success', async () => {
    h.execute.mockResolvedValue({
      transactionId: { toString: () => TX_ID },
      getReceipt: async () => {
        throw new Error('receipt timed out');
      },
    });

    const error = await buildAndSubmitHbarTransfer(params).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HederaTransferError);
    expect((error as HederaTransferError).transactionId).toBe(TX_ID);
    expect((error as HederaTransferError).status).toBe('UNKNOWN');
    expect((error as Error).message).toMatch(/could not be confirmed/i);
  });
});
