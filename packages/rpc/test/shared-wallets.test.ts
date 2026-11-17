import { describe, expect, it } from 'vitest';
import { VoteRefusedError, prepareVoteMessage, proposalCanonicalString, proposalDigest, type Proposal } from '../src/shared-wallets';

// Same fixture and vector as services/wallet-api/internal/sharedwallet (TestProposalDigestVector).
const VECTOR = 'ca4d341e72e05646af08221cecdb330c6ad480662796aa3e0258858587769321';

function fixture(): Proposal {
  return {
    id: '01900000-0000-7000-8000-000000000001',
    walletId: '01900000-0000-7000-8000-000000000002',
    accountId: '01900000-0000-7000-8000-000000000003',
    derivationIndex: 1,
    initiatorParticipantId: '01900000-0000-7000-8000-000000000004',
    senderAddress: null,
    chainId: 31337,
    to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    valueWei: '1000000000000000000',
    data: '0x',
    nonce: 0,
    gasLimit: 21000,
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
    policy: { version: 1, numerator: 1, denominator: 2, rounding: 'ceil' },
    membershipVersion: 5,
    participantCount: 5,
    requiredApprovals: 3,
    eligibleParticipantIds: [
      '01900000-0000-7000-8000-000000000005',
      '01900000-0000-7000-8000-000000000004',
      '01900000-0000-7000-8000-000000000006',
      '01900000-0000-7000-8000-000000000007',
      '01900000-0000-7000-8000-000000000008',
    ],
    digest: VECTOR,
    status: 'pending',
    approvals: 0,
    rejections: 0,
    remainingApprovals: 3,
    votes: [],
    lifecycle: 'awaiting_approvals',
    execution: { status: 'not_started' },
    expiresAt: '2026-11-14T12:00:00Z',
    createdAt: '2026-11-13T12:00:00Z',
  };
}

describe('proposal digest', () => {
  it('matches the Go/Python vector', async () => {
    const p = fixture();
    // The vector was computed over a 2-participant eligible list.
    p.eligibleParticipantIds = p.eligibleParticipantIds.slice(0, 2);
    expect(proposalCanonicalString(p)).toContain('|01900000-0000-7000-8000-000000000004,01900000-0000-7000-8000-000000000005|1794657600');
    expect(await proposalDigest(p)).toBe(VECTOR);
  });
});

describe('prepareVoteMessage refuses to sign anything it cannot verify', () => {
  const me = '01900000-0000-7000-8000-000000000006';

  async function withRealDigest(mut?: (p: Proposal) => void): Promise<Proposal> {
    const p = fixture();
    p.digest = await proposalDigest(p);
    mut?.(p);
    return p;
  }

  it('signs a consistent proposal and binds every field', async () => {
    const p = await withRealDigest();
    const msg = await prepareVoteMessage(p, 'approve', me, 'nonce_abc-1', 1794600000);
    expect(msg).toBe(`QDWallet-Vote|v1|approve|${p.id}|${p.walletId}|${p.digest}|1|5|${me}|nonce_abc-1|1794600000`);
  });

  const tampered: [string, (p: Proposal) => void][] = [
    ['amount changed after hashing', (p) => (p.valueWei = '2000000000000000000')],
    ['recipient changed', (p) => (p.to = '0x' + '1'.repeat(40))],
    ['required approvals lowered', (p) => (p.requiredApprovals = 2)],
    ['participant count mismatch', (p) => (p.participantCount = 4)],
    ['delimiter injection', (p) => (p.data = '0x|00')],
    ['uppercase address', (p) => (p.to = p.to.toUpperCase().replace('0X', '0x'))],
  ];
  for (const [name, mut] of tampered) {
    it(`refuses: ${name}`, async () => {
      const p = await withRealDigest(mut);
      await expect(prepareVoteMessage(p, 'approve', me, 'n', 1)).rejects.toBeInstanceOf(VoteRefusedError);
    });
  }

  it('refuses a participant outside the snapshot', async () => {
    const p = await withRealDigest();
    await expect(prepareVoteMessage(p, 'approve', '01900000-0000-7000-8000-0000000000ff', 'n', 1)).rejects.toBeInstanceOf(VoteRefusedError);
  });

  it('refuses an unknown decision', async () => {
    const p = await withRealDigest();
    await expect(prepareVoteMessage(p, 'maybe' as 'approve', me, 'n', 1)).rejects.toBeInstanceOf(VoteRefusedError);
  });
});
