// Approval threshold ↔ Threshold Raccoon compatibility (in-process only).
//
// Shows that a T = ceil(N/2) approval policy maps onto dealerKeyGen(T, N):
// the first T approvers become the active set and sign the 32-byte proposal
// digest with the unchanged QdParty rounds. This does NOT exercise share
// distribution or a networked signing session; both are still pending.
import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils.js';
import { QdParty, SigningError, dealerKeyGen, signLocally, verify } from '../src';

const required = (n: number) => Math.ceil(n / 2);
// Digest vector shared with services/wallet-api/internal/sharedwallet (vector_test.go).
const PROPOSAL_DIGEST = hexToBytes('ca4d341e72e05646af08221cecdb330c6ad480662796aa3e0258858587769321');
const sid = () => crypto.getRandomValues(new Uint8Array(32));

/** Party indices of the first T approvers, as the active set (sorted, exactly T). */
function activeSet(approverPartyIndexes: number[], t: number): number[] {
  if (approverPartyIndexes.length < t) throw new Error('threshold not met');
  return approverPartyIndexes.slice(0, t).sort((a, b) => a - b);
}

describe('approval policy ↔ dealerKeyGen(T, N)', () => {
  for (const n of [1, 2, 3, 5, 10]) {
    it(`N=${n}: the first ceil(N/2) approvers sign the proposal digest`, () => {
      const t = required(n);
      const { shares } = dealerKeyGen(t, n);
      const parties = shares.map((s) => new QdParty(s));
      // Approvals arrive in an arbitrary order; party index = participant slot.
      const order = Array.from({ length: n }, (_, i) => n - i);
      const act = activeSet(order, t);
      const req = { sid: sid(), act, derivationIndex: 1, msg: PROPOSAL_DIGEST };
      const sig = signLocally(parties, req);
      expect(verify(parties[0].publicKey(1), PROPOSAL_DIGEST, sig)).toBe(true);
    });
  }

  it('fewer than T approvers cannot form a signing session', () => {
    const { shares } = dealerKeyGen(3, 5);
    const p = new QdParty(shares[0]);
    expect(() => p.round1({ sid: sid(), act: [1, 2], derivationIndex: 1, msg: PROPOSAL_DIGEST })).toThrow(SigningError);
  });

  it('a key generated for 10 participants cannot serve 11 (membership change needs a new keygen)', () => {
    const { shares } = dealerKeyGen(required(10), 10);
    const p = new QdParty(shares[0]);
    // 11 participants require T = 6, but this key's T is 5.
    expect(() => p.round1({ sid: sid(), act: [1, 2, 3, 4, 5, 6], derivationIndex: 1, msg: PROPOSAL_DIGEST })).toThrow(SigningError);
  });

  it('a signature over one proposal digest does not verify for a modified proposal', () => {
    const { shares } = dealerKeyGen(2, 3);
    const parties = shares.map((s) => new QdParty(s));
    const sig = signLocally(parties, { sid: sid(), act: [1, 3], derivationIndex: 1, msg: PROPOSAL_DIGEST });
    const modified = PROPOSAL_DIGEST.slice();
    modified[0] ^= 1;
    expect(verify(parties[0].publicKey(1), modified, sig)).toBe(false);
  });
});
