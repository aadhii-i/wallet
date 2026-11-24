import { describe, expect, it } from 'vitest';
import {
  KeygenRefusedError,
  checkKeygenAgainstWallet,
  envelopesDigestHex,
  keygenAckMessage,
  keygenDealMessage,
  keygenKeyMessage,
  keygenSafetyNumber,
  toB64url,
  type KeyGeneration,
  type SharedWallet,
} from '../src';

// Same fixture and values as services/wallet-api/internal/sharedwallet/keygen_vector_test.go
// (hashes independently computed with Python hashlib).
const WALLET = '01900000-0000-7000-8000-000000000002';
const KEYGEN = '01900000-0000-7000-8000-0000000000a1';
const FP = 'ab'.repeat(32);
const DIGEST = 'd06d14f61436b5f9ab8a14be789d4dc762ab7964975e1630ff380582c5629d19';
const pid = (n: number) => `01900000-0000-7000-8000-00000000000${n}`;

function kg(over: Partial<KeyGeneration> = {}): KeyGeneration {
  return {
    id: KEYGEN, status: 'collecting_keys', failureReason: '', threshold: 2, parties: 3, membershipVersion: 5,
    dealerParticipantId: pid(4), fingerprint: null, keysRegistered: 0, provisioned: 0,
    createdAt: '2026-11-14T00:00:00Z', expiresAt: '2026-11-15T00:00:00Z',
    participants: [4, 5, 6].map((n, i) => ({
      participantId: pid(n), partyIndex: i + 1, encryptionKey: toB64url(new Uint8Array(1216).fill(n)),
      keyRegistered: true, envelopeStaged: false, provisioned: false,
    })),
    me: { participantId: pid(4), partyIndex: 1 },
    ...over,
  };
}

describe('key-generation messages match the Go vectors', () => {
  it('key registration, envelope digest, deal and acknowledgement', async () => {
    expect(await keygenKeyMessage(WALLET, kg(), pid(4), 1, new Uint8Array(1216).fill(7))).toBe(
      `QDWallet-KeygenKey|v1|${WALLET}|${KEYGEN}|${pid(4)}|1|5|bdaf76ae70b0ce3fc93a281afab76b7ffbcdc7b86c5b50754c23a28a1f53df27`,
    );
    const digest = await envelopesDigestHex([3, 1, 2].map((i) => ({ partyIndex: i, participantId: pid(i + 3), hashHex: `0${i}`.repeat(32) })));
    expect(digest).toBe(DIGEST);
    expect(keygenDealMessage(WALLET, kg(), FP, digest)).toBe(`QDWallet-KeygenDeal|v1|${WALLET}|${KEYGEN}|5|2|3|${FP}|${DIGEST}`);
    const env = { walletId: WALLET, keygenId: KEYGEN, participantId: pid(6), partyIndex: 3, threshold: 2, parties: 3, membershipVersion: 5, fingerprint: FP, enc: '', ct: '', envelopeHash: '' };
    expect(keygenAckMessage(env, '03'.repeat(32))).toBe(`QDWallet-KeygenAck|v1|${WALLET}|${KEYGEN}|${pid(6)}|3|2|3|5|${FP}|${'03'.repeat(32)}`);
  });
});

describe('safety number', () => {
  it('is stable, and changes if the server substitutes any key', async () => {
    const a = await keygenSafetyNumber(WALLET, kg());
    expect(a).toMatch(/^\d{5}( \d{5}){5}$/);
    expect(await keygenSafetyNumber(WALLET, kg())).toBe(a);
    const swapped = kg();
    swapped.participants[2]!.encryptionKey = toB64url(new Uint8Array(1216).fill(9));
    expect(await keygenSafetyNumber(WALLET, swapped)).not.toBe(a);
    const missing = kg();
    missing.participants[0]!.encryptionKey = null;
    expect(await keygenSafetyNumber(WALLET, missing)).toBeNull();
  });
});

describe('checkKeygenAgainstWallet', () => {
  const wallet = {
    policy: { version: 1, numerator: 1, denominator: 2, rounding: 'ceil', membershipVersion: 5, activeParticipants: 3, requiredApprovals: 2, maxParticipants: 64 },
    participants: [4, 5, 6].map((n) => ({ id: pid(n), displayName: '', role: 'member', status: 'active', joinedAt: '' })),
  } as unknown as SharedWallet;

  it('accepts a ceremony matching the wallet', () => {
    expect(() => checkKeygenAgainstWallet(wallet, kg())).not.toThrow();
  });
  const bad: [string, Partial<KeyGeneration>][] = [
    ['lower threshold', { threshold: 1 }],
    ['stale membership version', { membershipVersion: 4 }],
    ['wrong party count', { parties: 4 }],
    ['unknown participant', { participants: kg().participants.map((p, i) => (i === 2 ? { ...p, participantId: pid(9) } : p)) }],
    ['duplicate index', { participants: kg().participants.map((p, i) => (i === 2 ? { ...p, partyIndex: 2 } : p)) }],
  ];
  for (const [name, over] of bad) {
    it(`refuses: ${name}`, () => {
      expect(() => checkKeygenAgainstWallet(wallet, kg(over))).toThrow(KeygenRefusedError);
    });
  }
});
