// API-level integration test against a real wallet-api (in-memory store).
// Runs only when QD_API_URL is set, e.g.:
//   (cd services/wallet-api && HTTP_ADDR=:8181 METRICS_ADDR=:9191 APP_ENV=development STORE=memory \
//      PRICE_PROVIDER=static go run ./cmd/wallet-api) &
//   QD_API_URL=http://localhost:8181 npx vitest run test/shared-wallets.integration.test.ts
// Each participant is an independent user: its own P-256 device key, its own session.
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, generateDeviceKeyPair, webCryptoDeviceKey, type Proposal } from '../src';

const API = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.QD_API_URL;

async function newUser(): Promise<ApiClient> {
  let tokens: { accessToken: string; refreshToken: string } | null = null;
  return new ApiClient({
    baseUrl: API!,
    clientType: 'mobile',
    platform: 'android',
    expectedOrigin: 'app:qdwallet',
    deviceKey: webCryptoDeviceKey(await generateDeviceKeyPair()),
    freshDevice: true,
    tokenStore: { get: async () => tokens, set: async (t) => void (tokens = t) },
  });
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}

const proposalInput = (accountId: string) => ({
  accountId, chainId: 31337, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', valueWei: '1000000000000000000',
  nonce: 0, gasLimit: 21000, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000',
});

describe.skipIf(!API)('shared wallet over HTTP with 5 independent users', () => {
  it('runs the full invitation → proposal → approval lifecycle', async () => {
    const users = await Promise.all(Array.from({ length: 5 }, newUser));
    const outsider = await newUser();
    const p1 = users[0]!;

    const created = await p1.createSharedWallet('Team treasury', 'P1');
    expect(created.policy).toMatchObject({ activeParticipants: 1, requiredApprovals: 1, numerator: 1, denominator: 2 });
    for (const [i, u] of users.slice(1).entries()) {
      const inv = await p1.createInvitation(created.id, `P${i + 2}`);
      const prev = await u.previewInvitation(inv.code);
      expect(prev.walletName).toBe('Team treasury');
      await u.acceptInvitation(inv.code, `P${i + 2}`);
      expect(await code(outsider.acceptInvitation(inv.code, 'thief'))).toBe('INVITATION_INVALID');
    }
    // Every participant independently sees 5 participants and a threshold of 3.
    const views = await Promise.all(users.map((u) => u.sharedWallet(created.id)));
    const ids = new Set(views.map((v) => v.me.id));
    expect(ids.size).toBe(5);
    for (const v of views) expect(v.policy).toMatchObject({ activeParticipants: 5, requiredApprovals: 3 });
    expect(views[1]!.invitations).toBeUndefined(); // owner-only
    expect(await code(outsider.sharedWallet(created.id))).toBe('NOT_FOUND');
    expect(await code(users[1]!.createInvitation(created.id, 'x'))).toBe('FORBIDDEN');

    const acct = await p1.createSharedAccount(created.id, 'Ops');
    expect(acct.address).toBeNull();
    const prop = await p1.createProposal(created.id, proposalInput(acct.id));
    expect(prop).toMatchObject({ requiredApprovals: 3, participantCount: 5, status: 'pending', senderAddress: null });
    expect(await code(outsider.proposal(prop.id))).toBe('NOT_FOUND');

    let p: Proposal = await users[0]!.voteOnProposal(prop.id, 'approve');
    p = await users[1]!.voteOnProposal(prop.id, 'approve');
    expect(p).toMatchObject({ approvals: 2, status: 'pending' });
    expect(p.signing).toBeUndefined();
    expect(await code(users[1]!.voteOnProposal(prop.id, 'approve'))).toBe('DUPLICATE_VOTE');

    // Three participants race for the last approval: exactly one wins.
    const race = await Promise.all(users.slice(2).map((u) => code(u.voteOnProposal(prop.id, 'approve'))));
    expect(race.filter((c) => c === 'OK')).toHaveLength(1);
    expect(race.filter((c) => c === 'PROPOSAL_CLOSED')).toHaveLength(2);
    p = await p1.proposal(prop.id);
    expect(p).toMatchObject({ approvals: 3, status: 'approved', remainingApprovals: 0 });
    expect(p.signing?.status).toBe('awaiting_key_generation');
    expect(p.signing?.signers).toHaveLength(3);
    expect(p.execution.status).toBe('not_started');
  });

  it('rejects forged votes, enforces revocation and recalculates the threshold', async () => {
    const users = await Promise.all(Array.from({ length: 4 }, newUser));
    const owner = users[0]!;
    const w = await owner.createSharedWallet('Rekey test', 'owner');
    for (const u of users.slice(1)) await u.acceptInvitation((await owner.createInvitation(w.id, '')).code, '');
    const acct = await owner.createSharedAccount(w.id, 'A');
    const prop = await owner.createProposal(w.id, proposalInput(acct.id));
    expect(prop.requiredApprovals).toBe(2);

    // A vote with a valid nonce but a signature that does not cover the message.
    const n = await users[1]!.json<{ nonce: string }>('POST', `/v1/proposals/${prop.id}/vote-nonce`);
    const forged = users[1]!.json('POST', `/v1/proposals/${prop.id}/votes`, {
      decision: 'approve', nonce: n.nonce, issuedAt: Math.floor(Date.now() / 1000), digest: prop.digest, signature: 'A'.repeat(86),
    });
    expect(await code(forged)).toBe('VOTE_SIGNATURE_INVALID');
    const wrongDigest = users[2]!.json('POST', `/v1/proposals/${prop.id}/votes`, {
      decision: 'approve', nonce: (await users[2]!.json<{ nonce: string }>('POST', `/v1/proposals/${prop.id}/vote-nonce`)).nonce,
      issuedAt: Math.floor(Date.now() / 1000), digest: '00'.repeat(32), signature: 'A'.repeat(86),
    });
    expect(await code(wrongDigest)).toBe('DIGEST_MISMATCH');
    expect((await owner.proposal(prop.id)).approvals).toBe(0);

    // Revoke a participant: the open proposal is superseded, the revoked user loses access.
    const target = (await users[3]!.sharedWallet(w.id)).me.id;
    const r = await owner.revokeParticipant(w.id, target);
    expect(r.membershipVersion).toBe(prop.membershipVersion + 1);
    expect((await owner.proposal(prop.id)).status).toBe('superseded');
    expect(await code(users[3]!.sharedWallet(w.id))).toBe('NOT_FOUND');
    expect(await code(users[1]!.voteOnProposal(prop.id, 'approve'))).toBe('PROPOSAL_CLOSED');
    const next = await owner.createProposal(w.id, proposalInput(acct.id));
    expect(next).toMatchObject({ participantCount: 3, requiredApprovals: 2 });
  });
});
