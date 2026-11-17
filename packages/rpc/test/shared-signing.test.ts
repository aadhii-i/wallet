import { describe, expect, it } from 'vitest';
import {
  SigningRefusedError,
  checkSession,
  sessionHeader,
  sha256Hex,
  signRoundMessage,
  transcriptHash,
  type SigningSession,
} from '../src';

const enc = (s: string) => new TextEncoder().encode(s);
const rep = (n: number, b: string) => b.repeat(n);

// Same inputs as services/wallet-api/internal/sharedwallet/signing_vector_test.go.
const session: SigningSession = {
  id: '01900000-0000-7000-8000-0000000000a1', proposalId: '01900000-0000-7000-8000-0000000000a2', attempt: 1, status: 'round2',
  round: 2, failureReason: '', keyGenerationId: '01900000-0000-7000-8000-0000000000a4', threshold: 2, parties: 3,
  membershipVersion: 4, derivationIndex: 0, chainId: 31337, signerPartyIndexes: [1, 3],
  signerParticipantIds: ['01900000-0000-7000-8000-0000000000b1', '01900000-0000-7000-8000-0000000000b3'],
  sid: rep(32, '5a'), message: '0x' + rep(32, '22'), accountAddress: '0xef2d12c08016fe0e3af45d10de2f1c88b61e2aa4',
  publicKeyHash: '0x' + rep(32, '11'), progress: { '1': [1, 3], '2': [1], '3': [] }, createdAt: '2026-11-14T00:00:00Z',
  expiresAt: new Date(1_800_000_000_000).toISOString(), header: '', messages: [],
};
const walletId = '01900000-0000-7000-8000-0000000000a3';
const digest = rep(32, '33');

describe('signing messages match the Go coordinator', () => {
  it('header, transcript and round message', async () => {
    const header = sessionHeader(session, walletId, digest);
    expect(await sha256Hex(enc(header))).toBe('f79880c595d31fb091ed867e0900982ef9e30520dd32d6c72629f750ff676ab0');
    const msgs = [
      { round: 1, partyIndex: 3, payloadSha256: await sha256Hex(enc('r1-p3')) },
      { round: 1, partyIndex: 1, payloadSha256: await sha256Hex(enc('r1-p1')) },
      { round: 2, partyIndex: 1, payloadSha256: await sha256Hex(enc('r2-p1')) },
    ];
    const tr = await transcriptHash(header, msgs, 2);
    expect(tr).toBe('dcc971af4a59dcdc644c5e7a2cae40fab84ae6a6d07f68839db98acd156707f7');
    const rm = await signRoundMessage(session.id, 2, 3, session.signerParticipantIds[1]!, tr, enc('r2-p3'));
    expect(await sha256Hex(enc(rm))).toBe('62b14f1724376e9dbf523a576e616128ec645f60bccedb9a91ac08bb0b5e961d');
  });

  it('refuses a session that differs from what this device approved', () => {
    const s = { ...session, header: sessionHeader(session, walletId, digest) };
    const exp = {
      walletId, proposalId: s.proposalId, proposalDigest: digest, chainId: 31337, derivationIndex: 0,
      accountAddress: s.accountAddress, publicKeyHash: s.publicKeyHash, message: s.message, signerPartyIndexes: [1, 3],
      keyGenerationId: s.keyGenerationId,
    };
    expect(() => checkSession(s, exp)).not.toThrow();
    for (const bad of [
      { message: '0x' + rep(32, '23') }, { accountAddress: '0x' + rep(20, '00') }, { chainId: 1 }, { signerPartyIndexes: [1, 2] },
      { header: s.header + 'x' }, { sid: 'zz' },
    ]) {
      expect(() => checkSession({ ...s, ...bad } as SigningSession, exp)).toThrow(SigningRefusedError);
    }
  });
});
