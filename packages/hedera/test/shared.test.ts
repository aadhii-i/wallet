import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PublicKey, Transaction } from '@hashgraph/sdk';
import { proto } from '@hiero-ledger/proto';
import { HDKeyring, bytesToHex, fromHex, type HederaSharedContext } from '@qd/wallet-core';
import {
  dealerKeyGen,
  QdParty,
  encodePublicKey,
  encodeRound1,
  encodeRound2,
  encodeRound3,
  decodeRound1,
  decodeRound2,
  type KeyShare,
} from '@qd/qd-crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as h from '../src';

const context: HederaSharedContext = {
  walletId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  keygenId: '33333333-3333-4333-8333-333333333333',
  membershipVersion: 3,
  network: 'testnet',
};
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let keys: HDKeyring[] = [],
  shares: KeyShare[],
  policy: h.HederaSharedPolicy;
const enrollmentFields = (e: Omit<h.HederaEnrollment, 'proof'>) => [
  e.walletId,
  e.accountId,
  e.keygenId,
  e.membershipVersion,
  e.network,
  e.participantId,
  e.partyIndex,
  e.derivationIndex,
  e.threshold,
  e.parties,
  e.publicKey,
  e.raccoonPublicKey,
];
beforeAll(async () => {
  for (let i = 0; i < 3; i++) keys.push(await HDKeyring.fromMnemonic(phrase, `hedera-test-${i}`));
  shares = dealerKeyGen(2, 3).shares;
  const pk = h.hederaWireText(encodePublicKey(new QdParty(shares[0]!).publicKey(7)));
  policy = h.createHederaPolicy(
    keys.map((key, i) => {
      const entry = {
        ...context,
        participantId: `44444444-4444-4444-8444-44444444444${i}`,
        partyIndex: i + 1,
        derivationIndex: 7,
        threshold: 2,
        parties: 3,
        publicKey: key.hederaSharedPublicKey(context),
        raccoonPublicKey: pk,
      };
      // Enrollment uses the exported helper in normal callers.
      return key.withHederaSharedPrivateKey(context, (pk) => h.signHederaEnrollment(entry, pk));
    }),
  );
});
afterAll(() => keys.forEach((key) => key.lock()));
function proposal() {
  return h.makeHederaProposal(policy, '0.0.123', '0.0.124', 1_000_000n, 1_000_000n, [1, 2]);
}
function approve(p: h.HederaProposal, ownPolicy = policy) {
  const consents = [1, 2].map((from) => ({ from, nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }));
  const req = {
    sid: h.hederaJointSid(ownPolicy, p, consents),
    act: p.active,
    derivationIndex: ownPolicy.derivationIndex,
    msg: h.hederaSharedMessage(ownPolicy, p),
  };
  const parties = shares.slice(0, 2).map((s) => new QdParty(s));
  const r1 = parties.map((party) => ({
    from: party.index,
    payload: h.hederaWireText(encodeRound1(party.round1(req))),
  }));
  const r2 = parties.map((party) => ({
    from: party.index,
    payload: h.hederaWireText(
      encodeRound2(
        party.round2(
          req.sid,
          r1.map((m) => decodeRound1(m.from, h.hederaWireBytes(m.payload))),
        ),
        req.act,
      ),
    ),
  }));
  const r3 = parties.map((party) => ({
    from: party.index,
    payload: h.hederaWireText(
      encodeRound3(
        party.round3(
          req.sid,
          r2.map((m) => decodeRound2(m.from, h.hederaWireBytes(m.payload), req.act)),
        ),
      ),
    ),
  }));
  return h.combineHederaApproval(ownPolicy, p, consents, r1, r2, r3);
}
function approved() {
  for (let n = 0; n < 16; n++) {
    const p = proposal();
    try {
      return { p, approval: approve(p) };
    } catch (e) {
      if (n === 15) throw e;
    }
  }
  throw new Error('Signing failed');
}
function partial(p: h.HederaProposal, a: h.HederaApproval, index: number) {
  return keys[index]!.withHederaSharedPrivateKey(context, (key) => h.signHederaNative(policy, p, a, index + 1, key));
}
describe('shared Hedera native quorum and Raccoon', () => {
  it('separates deterministic native keys and proves enrollment', () => {
    expect(policy.nativeThreshold).toBe(2);
    expect(new Set(policy.members.map((m) => m.publicKey)).size).toBe(3);
    expect(keys[0]!.hederaPublicKey(7)).not.toBe(policy.members[0]!.publicKey);
    expect(() =>
      h.createHederaPolicy(policy.members.map((m, i) => (i === 1 ? { ...m, proof: '00'.repeat(64) } : m))),
    ).toThrow();
  });
  it('matches the complete on-chain native threshold key, never a single public key', () => {
    const account: h.HederaAccountInfo = {
      accountId: '0.0.123',
      network: 'testnet',
      tinybars: '100000000',
      balanceTimestamp: '1700000000.000000001',
      deleted: false,
      receiverSignatureRequired: false,
      key: { type: 'ProtobufEncoded', key: h.hederaThresholdKeyHex(policy) },
    };
    expect(() => h.verifyHederaAccount(policy, account)).not.toThrow();
    expect(() =>
      h.verifyHederaAccount(policy, {
        ...account,
        key: { type: 'ECDSA_SECP256K1', key: policy.members[0]!.publicKey },
      }),
    ).toThrow();
    expect(() => h.verifyHederaAccount(policy, { ...account, deleted: true })).toThrow();
  });
  it('runs actual Raccoon rounds and produces SDK-compatible native signatures', () => {
    const { p, approval } = approved(),
      a = partial(p, approval, 0),
      b = partial(p, approval, 1);
    expect(PublicKey.fromStringECDSA(a.publicKey).verify(h.hederaBody(p), fromHex(a.signature))).toBe(true);
    expect(() => h.finalizeHederaShared(policy, p, approval, [a])).toThrow(/quorum/);
    expect(() => h.finalizeHederaShared(policy, p, approval, [a, a])).toThrow(/quorum/);
    const signed = h.finalizeHederaShared(policy, p, approval, [a, b]),
      decoded = Transaction.fromBytes(h.hederaWireBytes(signed.raw));
    expect(decoded.transactionId?.toString()).toBe(p.transactionId);
    const list = proto.TransactionList.decode(h.hederaWireBytes(signed.raw)),
      wire = proto.SignedTransaction.decode(list.transactionList[0]!.signedTransactionBytes!);
    expect(wire.sigMap!.sigPair!.length).toBe(2);
    expect(bytesToHex(wire.bodyBytes!)).toBe(bytesToHex(h.hederaBody(p)));
  });
  it('rejects mutated recipients, amounts, fees, nodes, expiry and signatures', () => {
    const { p, approval } = approved();
    for (const change of [
      { to: '0.0.125' },
      { amount: '2000000' },
      { maxFee: '2000000' },
      { ledgerId: '00' },
      { expiresAt: p.expiresAt + 1 },
    ])
      expect(() => partial({ ...p, ...change } as h.HederaProposal, approval, 0)).toThrow();
    expect(() => partial(p, { ...approval, signature: h.hederaWireText(new Uint8Array(64)) }, 0)).toThrow();
    expect(() => h.validateHederaProposal(policy, p, p.expiresAt)).toThrow();
  });
  it('uses fresh signer randomness even if a coordinator repeats its nonce', () => {
    const p = proposal(),
      a = [
        { from: 1, nonce: '11'.repeat(32) },
        { from: 2, nonce: '22'.repeat(32) },
      ];
    expect(bytesToHex(h.hederaJointSid(policy, p, a))).not.toBe(
      bytesToHex(h.hederaJointSid(policy, p, [{ ...a[0]!, nonce: '33'.repeat(32) }, a[1]!])),
    );
  });
  it('creates only the reviewed threshold account with zero initial funding', () => {
    const plan = h.makeHederaCreation(policy, '0.0.123');
    expect(h.hederaNativeIntent(plan)).toMatch(/^QDWallet:[0-9a-f-]{36}:[A-Za-z0-9_-]{43}$/);
    expect(new TextEncoder().encode(h.hederaNativeIntent(plan)).length).toBeLessThanOrEqual(100);
    expect(h.hederaNativeIntent({ ...plan, to: '0.0.124' })).not.toBe(h.hederaNativeIntent(plan));
    const signed = keys[0]!.withHederaPrivateKey(0, (key) => h.signHederaCreation(policy, plan, key));
    expect(Transaction.fromBytes(h.hederaWireBytes(signed.raw)).transactionId?.toString()).toBe(plan.transactionId);
    expect(() => h.validateHederaPlan(policy, { ...plan, amount: '1' })).toThrow();
  });
});

it('rotates a native account only with both old and new native and Raccoon quorums', () => {
  const nextContext = {...context, walletId:'55555555-5555-4555-8555-555555555555', keygenId:'66666666-6666-4666-8666-666666666666'};
  const next = h.createHederaPolicy(keys.map((key,i) => {
    const entry = {...policy.members[i]!,...nextContext,publicKey:key.hederaSharedPublicKey(nextContext)};
    return key.withHederaSharedPrivateKey(nextContext,privateKey=>h.signHederaEnrollment(entry,privateKey));
  }));
  let complete=false;
  for(let attempt=0;attempt<16&&!complete;attempt++) {
    const rotation=h.makeHederaKeyUpdate(policy,next,'0.0.123','77777777-7777-4777-8777-777777777777',[1,2],[1,2]);
    let oldApproval:h.HederaApproval,newApproval:h.HederaApproval;
    try {oldApproval=approve(rotation.source);newApproval=approve(rotation.target,next);}catch(error){if(attempt===15)throw error;continue;}
    const oldPartials=keys.slice(0,2).map((key,i)=>key.withHederaSharedPrivateKey(context,privateKey=>h.signHederaNative(policy,rotation.source,oldApproval,i+1,privateKey)));
    const newPartials=keys.slice(0,2).map((key,i)=>key.withHederaSharedPrivateKey(nextContext,privateKey=>h.signHederaNative(next,rotation.target,newApproval,i+1,privateKey)));
    expect(()=>h.finalizeHederaShared(policy,rotation.source,oldApproval,oldPartials)).toThrow(/both/);
    expect(()=>h.finalizeHederaKeyUpdate(rotation.source,oldApproval,oldPartials,rotation.target,newApproval,[newPartials[0]!])).toThrow(/Both/);
    const signed=h.finalizeHederaKeyUpdate(rotation.source,oldApproval,oldPartials,rotation.target,newApproval,newPartials);
    expect(()=>h.verifyHederaSavedPlan(policy,rotation.source,signed.raw)).not.toThrow();
    const list=proto.TransactionList.decode(h.hederaWireBytes(signed.raw)), tx=proto.SignedTransaction.decode(list.transactionList[0]!.signedTransactionBytes!),body=proto.TransactionBody.decode(tx.bodyBytes!);
    expect(tx.sigMap!.sigPair!.length).toBe(4);
    expect(bytesToHex(proto.Key.encode(body.cryptoUpdateAccount!.key!).finish())).toBe(h.hederaThresholdKeyHex(next));
    expect(body.cryptoUpdateAccount!.accountIDToUpdate!.accountNum!.toString()).toBe('123');
    expect(()=>h.finalizeHederaKeyUpdate(rotation.source,oldApproval,oldPartials,{...rotation.target,amount:'1'},newApproval,newPartials)).toThrow();
    complete=true;
  }
  expect(complete).toBe(true);
});
