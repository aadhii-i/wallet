import { describe, expect, it } from 'vitest';
import { WalletError } from '@qd/blockchain';
import {
  assessFee,
  assessRecipient,
  initialSendState,
  isQuoteStale,
  looksLike,
  mapError,
  redactTechnical,
  sendReducer,
  type SendEvent,
  type SendState,
} from '../src';

const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const FRIEND = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const POISON = '0x7099000000000000000000000000000000079C8'.padEnd(42, '0');
const own = new Map([[ME.toLowerCase(), 'Account 1']]);

describe('recipient risk', () => {
  it('detects lookalikes by prefix/suffix', () => {
    const fake = '0x70990000000000000000000000000000000079c8';
    expect(looksLike(FRIEND, fake)).toBe(true);
    expect(looksLike(FRIEND, FRIEND.toLowerCase())).toBe(false);
    expect(looksLike(FRIEND, '0x1234000000000000000000000000000000000000')).toBe(false);
    expect(POISON.length).toBe(42);
  });

  it('warns on address poisoning and requires acknowledgement', () => {
    const fake = '0x70990000000000000000000000000000000079c8';
    const f = assessRecipient({ networkId: 'sepolia', from: ME, to: fake, ownAccounts: own, knownAddresses: [FRIEND] });
    const poison = f.find((x) => x.code === 'ADDRESS_POISONING');
    expect(poison?.requiresAck).toBe(true);
    expect(poison?.lookalikeOf).toBe(FRIEND.toLowerCase());
  });

  it('flags first-time recipients only', () => {
    const first = assessRecipient({ networkId: 'sepolia', from: ME, to: FRIEND, ownAccounts: own, knownAddresses: [] });
    expect(first.map((x) => x.code)).toEqual(['FIRST_TIME_RECIPIENT']);
    const known = assessRecipient({ networkId: 'sepolia', from: ME, to: FRIEND, ownAccounts: own, knownAddresses: [FRIEND] });
    expect(known).toEqual([]);
  });

  it('blocks zero address and known token contracts', () => {
    expect(
      assessRecipient({ networkId: 'eth-mainnet', from: ME, to: '0x0000000000000000000000000000000000000000', ownAccounts: own, knownAddresses: [] })[0]!.severity,
    ).toBe('block');
    expect(
      assessRecipient({ networkId: 'eth-mainnet', from: ME, to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ownAccounts: own, knownAddresses: [] })[0]!.code,
    ).toBe('TOKEN_CONTRACT_RECIPIENT');
  });

  it('recognises self and own accounts', () => {
    expect(assessRecipient({ networkId: 'x', from: ME, to: ME.toLowerCase(), ownAccounts: own, knownAddresses: [] })[0]!.code).toBe('SELF_SEND');
    const own2 = new Map([...own, [FRIEND.toLowerCase(), 'Account 2']]);
    expect(assessRecipient({ networkId: 'x', from: ME, to: FRIEND, ownAccounts: own2, knownAddresses: [] })[0]!.title).toBe(
      'Transfer to Account 2',
    );
  });
});

describe('fee risk', () => {
  it('warns on high fee and fee > amount', () => {
    const codes = assessFee({ maxFee: 100n, feeWarningNative: 50n, amount: 10n, isNativeTransfer: true }).map((f) => f.code);
    expect(codes).toEqual(['HIGH_FEE', 'FEE_EXCEEDS_AMOUNT']);
    expect(assessFee({ maxFee: 10n, feeWarningNative: 50n, amount: 100n, isNativeTransfer: true })).toEqual([]);
  });
});

describe('error mapping', () => {
  it('maps common node errors', () => {
    expect(mapError(new Error('insufficient funds for gas * price + value'), 'estimate').code).toBe('INSUFFICIENT_FUNDS_FOR_FEE');
    expect(mapError(new Error('nonce too low')).code).toBe('NONCE_CONFLICT');
    expect(mapError(new Error('replacement transaction underpriced')).code).toBe('REPLACEMENT_UNDERPRICED');
    const reverted = mapError(new Error('execution reverted: 0x08c379a0'), 'estimate');
    expect(reverted.code).toBe('GAS_ESTIMATION_FAILED');
    expect(reverted.userMessage).toContain('Your funds have not been sent');
    expect(mapError({ code: 4001, message: 'User rejected' }).code).toBe('USER_REJECTED');
  });

  it('never offers retry after an ambiguous broadcast', () => {
    const e = mapError(new Error('request timed out'), 'broadcast');
    expect(e.code).toBe('BROADCAST_UNKNOWN');
    expect(e.fundsMoved).toBe('unknown');
    expect(e.retryable).toBe(false);
    expect(mapError(new Error('request timed out'), 'estimate').retryable).toBe(true);
  });

  it('passes WalletErrors through and redacts technical details', () => {
    const w = new WalletError({ code: 'UNKNOWN', userTitle: 't', userMessage: 'm', fundsMoved: 'no', retryable: true });
    expect(mapError(w)).toBe(w);
    const blob = `0x${'ab'.repeat(200)}`;
    expect(redactTechnical(`raw ${blob} via https://eth.alchemy.io/v2/SECRETKEY`)).toBe('raw 0x… via https://eth.alchemy.io/…');
  });
});

describe('send state machine', () => {
  const run = (events: SendEvent[], from: SendState = initialSendState) => events.reduce(sendReducer, from);
  const err = new WalletError({ code: 'UNKNOWN', userTitle: 't', userMessage: 'm', fundsMoved: 'no', retryable: true });

  it('follows the happy path', () => {
    const s = run([
      { type: 'ESTIMATE' },
      { type: 'ESTIMATED', at: 1 },
      { type: 'CONFIRM' },
      { type: 'SIGNED' },
      { type: 'BROADCAST_OK', hash: '0xabc' },
      { type: 'TX_CONFIRMED' },
    ]);
    expect(s).toMatchObject({ status: 'confirmed', txHash: '0xabc' });
  });

  it('ignores out-of-order events', () => {
    expect(run([{ type: 'CONFIRM' }]).status).toBe('draft');
    expect(run([{ type: 'BROADCAST_OK', hash: 'x' }]).status).toBe('draft');
  });

  it('cannot be cancelled or errored away once pending', () => {
    const pending = run([{ type: 'ESTIMATE' }, { type: 'ESTIMATED', at: 1 }, { type: 'CONFIRM' }, { type: 'SIGNED' }, { type: 'BROADCAST_OK', hash: 'h' }]);
    expect(sendReducer(pending, { type: 'CANCEL' }).status).toBe('pending');
    expect(sendReducer(pending, { type: 'ERROR', error: err }).status).toBe('pending');
    expect(sendReducer(pending, { type: 'EDIT' }).status).toBe('pending');
  });

  it('handles rejection and failures', () => {
    expect(run([{ type: 'ESTIMATE' }, { type: 'ESTIMATED', at: 1 }, { type: 'CANCEL' }]).status).toBe('rejected');
    expect(run([{ type: 'ESTIMATE' }, { type: 'ERROR', error: err }]).status).toBe('error');
  });

  it('detects stale quotes', () => {
    const s = run([{ type: 'ESTIMATE' }, { type: 'ESTIMATED', at: 1000 }]);
    expect(isQuoteStale(s, 20_000)).toBe(false);
    expect(isQuoteStale(s, 31_001)).toBe(true);
  });
});

describe('nonce risk (audit finding 7)', () => {
  it('requires acknowledgement for gaps and queued sends', async () => {
    const { assessNonce } = await import('../src');
    expect(assessNonce([])).toEqual([]);
    const f = assessNonce(['NONCE_GAP', 'NONCE_BEHIND_LOCAL']);
    expect(f.map((x) => x.code)).toEqual(['NONCE_GAP', 'NONCE_QUEUED']);
    expect(f.every((x) => x.requiresAck)).toBe(true);
  });
});
