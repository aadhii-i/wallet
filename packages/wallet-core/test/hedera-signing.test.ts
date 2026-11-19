import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { hashPayload } from '../src/signer/confirmation';
import { toHex, utf8ToBytes } from '../src/encoding';
import type { SignatureResult, SigningPayload } from '../src/signer/types';

const BASE_PAYLOAD: SigningPayload & { kind: 'hedera-transfer' } = {
  kind: 'hedera-transfer',
  fromAccountId: '0.0.12345',
  toAccountId: '0.0.67890',
  amountTinybars: '100000000',
  transactionBytes: 'AQIDBA==',
};

describe('hashPayload for hedera-transfer', () => {
  it('is deterministic', () => {
    const h1 = hashPayload(BASE_PAYLOAD);
    const h2 = hashPayload({ ...BASE_PAYLOAD });
    expect(h1).toBe(h2);
  });

  it('differs from an evm-transaction hash', () => {
    const evmPayload: SigningPayload = {
      kind: 'evm-transaction',
      chainId: 1,
      from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      serializedUnsigned: '0x02ef01808080808080808080',
    };
    const hHedera = hashPayload(BASE_PAYLOAD);
    const hEvm = hashPayload(evmPayload);
    expect(hHedera).not.toBe(hEvm);
  });

  it('produces the correct canonical string (hedera-transfer|{from}|{to}|{amount}|{bytes})', () => {
    const canonical =
      `hedera-transfer|${BASE_PAYLOAD.fromAccountId}|${BASE_PAYLOAD.toAccountId}` +
      `|${BASE_PAYLOAD.amountTinybars}|${BASE_PAYLOAD.transactionBytes}`;
    const expected = toHex(sha256(utf8ToBytes(canonical)));
    expect(hashPayload(BASE_PAYLOAD)).toBe(expected);
  });

  it('changes when fromAccountId changes', () => {
    const h1 = hashPayload(BASE_PAYLOAD);
    const h2 = hashPayload({ ...BASE_PAYLOAD, fromAccountId: '0.0.99999' });
    expect(h1).not.toBe(h2);
  });

  it('changes when toAccountId changes', () => {
    const h1 = hashPayload(BASE_PAYLOAD);
    const h2 = hashPayload({ ...BASE_PAYLOAD, toAccountId: '0.0.11111' });
    expect(h1).not.toBe(h2);
  });

  it('changes when amountTinybars changes', () => {
    const h1 = hashPayload(BASE_PAYLOAD);
    const h2 = hashPayload({ ...BASE_PAYLOAD, amountTinybars: '200000000' });
    expect(h1).not.toBe(h2);
  });

  it('changes when transactionBytes changes', () => {
    const h1 = hashPayload(BASE_PAYLOAD);
    const h2 = hashPayload({ ...BASE_PAYLOAD, transactionBytes: 'BQYHCA==' });
    expect(h1).not.toBe(h2);
  });
});

describe('SignatureResult hedera-transfer type', () => {
  it('satisfies the SignatureResult union (compile-time)', () => {
    // This is a compile-time-only check: if SignatureResult does not include
    // the hedera-transfer variant, TypeScript will reject this assignment.
    const result: SignatureResult = {
      kind: 'hedera-transfer',
      signerKind: 'hd',
      signedBytes: 'AQIDBA==',
    };
    expect(result.kind).toBe('hedera-transfer');
  });
});
