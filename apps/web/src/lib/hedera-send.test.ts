import { describe, expect, it } from 'vitest';
import {
  assessHbarSendAmount,
  canSpendHbar,
  HBAR_TRANSFER_FEE_BUFFER_TINYBARS,
  HBAR_TRANSFER_FEE_LABEL,
  parseHbarAmount,
  validateHederaRecipient,
} from './hedera-send';

const HBAR = 100_000_000n;

describe('parseHbarAmount', () => {
  it.each([
    ['1', HBAR],
    ['0.5', HBAR / 2n],
    ['.5', HBAR / 2n],
    ['1.', HBAR],
    ['0.00000001', 1n],
    ['123.45678901', 12_345_678_901n],
  ])('parses %s into tinybars', (input, expected) => {
    expect(parseHbarAmount(input)).toEqual({ tinybars: expected, error: null });
  });

  it.each(['', '   ', '0', '0.0', '-1', 'abc', '1e8', '1,5', '1.123456789', '.'])(
    'rejects invalid amount %j',
    (input) => {
      const result = parseHbarAmount(input);
      expect(result.tinybars).toBeUndefined();
      expect(result.error).toBeTruthy();
    },
  );

  it('reports a specific error for zero', () => {
    expect(parseHbarAmount('0').error).toMatch(/greater than 0/i);
  });

  it('reports a specific error for sub-tinybar precision', () => {
    expect(parseHbarAmount('0.000000001').error).toMatch(/8 decimal places/i);
  });
});

describe('assessHbarSendAmount', () => {
  it('only checks the format when the balance is not known yet', () => {
    expect(assessHbarSendAmount('1', undefined)).toEqual({ tinybars: HBAR, error: null });
    expect(assessHbarSendAmount('1', null)).toEqual({ tinybars: HBAR, error: null });
  });

  it('rejects an amount larger than the available balance', () => {
    const result = assessHbarSendAmount('0.5', HBAR / 2n);
    expect(result.tinybars).toBeUndefined();
    expect(result.error).toMatch(/insufficient balance/i);
  });

  it('includes the fee reserve in the balance check', () => {
    // 0.5 HBAR balance and 0.5 HBAR amount: the 0.01 HBAR fee reserve does not fit.
    expect(assessHbarSendAmount('0.5', HBAR / 2n).error).toMatch(/insufficient balance/i);
    // 0.49 + 0.01 reserve == 0.5 balance.
    expect(assessHbarSendAmount('0.49', HBAR / 2n)).toEqual({
      tinybars: 49_000_000n,
      error: null,
    });
  });

  it('accepts the exact boundary and rejects one tinybar more', () => {
    const maxAmount = HBAR - HBAR_TRANSFER_FEE_BUFFER_TINYBARS;
    expect(canSpendHbar(maxAmount, HBAR)).toBe(true);
    expect(canSpendHbar(maxAmount + 1n, HBAR)).toBe(false);
  });

  it('rejects any positive amount when the balance is zero', () => {
    expect(assessHbarSendAmount('0.00000001', 0n).error).toMatch(/insufficient balance/i);
  });
});

describe('validateHederaRecipient', () => {
  const FROM = '0.0.11473900';

  it('does not show an error before the field is filled', () => {
    expect(validateHederaRecipient('', FROM)).toBeNull();
    expect(validateHederaRecipient('   ', FROM)).toBeNull();
  });

  it('accepts a valid recipient Account ID', () => {
    expect(validateHederaRecipient('0.0.12345', FROM)).toBeNull();
    expect(validateHederaRecipient('  1.2.3  ', FROM)).toBeNull();
  });

  it('rejects malformed Account IDs', () => {
    for (const value of ['12345', '0.0', '0.0.', '0.0.abc', '0.0.1.2', 'hedera:0.0.1']) {
      expect(validateHederaRecipient(value, FROM)).toMatch(/valid Hedera Account ID/i);
    }
  });

  it('rejects sending to the selected account itself', () => {
    expect(validateHederaRecipient(FROM, FROM)).toMatch(/own account/i);
  });
});

describe('fee label', () => {
  it('matches the reserve amount', () => {
    expect(HBAR_TRANSFER_FEE_LABEL).toBe('~0.01 HBAR');
  });
});
