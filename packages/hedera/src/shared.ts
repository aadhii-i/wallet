/** Native Hedera threshold custody plus off-chain Raccoon authorization.
 * No network requests or private-key storage belong in this module. */
import {
  AccountId,
  AccountCreateTransaction,
  AccountUpdateTransaction,
  Hbar,
  KeyList,
  PublicKey,
  Timestamp,
  TransactionId,
  TransferTransaction,
} from '@hashgraph/sdk';
import { proto } from '@hiero-ledger/proto';
import { base64, base64urlnopad } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, fromHex, type HederaSharedContext } from '@qd/wallet-core';
import {
  combine,
  decodePublicKey,
  decodeRound1,
  decodeRound2,
  decodeRound3,
  decodeSignature,
  encodeSignature,
  verify,
} from '@qd/qd-crypto';

export const HEDERA_LEDGER = '01';
export const HEDERA_MAX_FEE = 100_000_000n;
const MAX_INT64 = 9223372036854775807n;
const hash = (value: unknown) => sha256(new TextEncoder().encode(JSON.stringify(value)));
const hexHash = (value: unknown) => bytesToHex(hash(value));
export const hederaWireText = (bytes: Uint8Array) => base64.encode(bytes);
export const hederaWireBytes = (value: string) => base64.decode(value);
export interface HederaEnrollment extends HederaSharedContext {
  participantId: string;
  partyIndex: number;
  derivationIndex: number;
  threshold: number;
  parties: number;
  publicKey: string;
  raccoonPublicKey: string;
  proof: string;
}
export interface HederaSharedPolicy {
  version: 1;
  context: HederaSharedContext;
  derivationIndex: number;
  raccoonPublicKey: string;
  nativeThreshold: number;
  raccoonThreshold: number;
  members: HederaEnrollment[];
}
export interface HederaAccountInfo {
  accountId: string;
  network: 'testnet';
  tinybars: string;
  balanceTimestamp: string;
  deleted: boolean;
  receiverSignatureRequired: boolean;
  key: { type: string; key: string };
}
/** A stale or future-dated balance must not authorize a new signature. */
export function verifyHederaSnapshotFresh(account: HederaAccountInfo, now = Date.now()): void {
  if (!/^\d+\.\d{1,9}$/.test(account.balanceTimestamp)) throw new Error('Invalid Hedera balance timestamp');
  const timestamp = Number(account.balanceTimestamp) * 1000;
  if (!Number.isFinite(timestamp) || timestamp < now - 120000 || timestamp > now + 15000)
    throw new Error('Hedera balance data is stale or the device clock is incorrect; refresh before signing');
}
export interface HederaPlan {
  version: 1;
  id: string;
  policyId: string;
  network: 'testnet';
  ledgerId: '01';
  kind: 'transfer' | 'create' | 'keyUpdate';
  /** Present only for an explicitly reviewed two-policy key rotation. */
  sourcePolicy?: HederaSharedPolicy;
  targetPolicy?: HederaSharedPolicy;
  migrationId?: string;
  transactionId: string;
  transactionBytes: string;
  expiresAt: number;
  from: string;
  to: string;
  amount: string;
  maxFee: string;
}
export interface HederaProposal extends HederaPlan {
  kind: 'transfer' | 'keyUpdate';
  approvalPolicyId?: string;
  sid: string;
  active: number[];
}
export interface HederaConsent {
  from: number;
  nonce: string;
}
export interface HederaRound {
  from: number;
  payload: string;
}
export interface HederaApproval {
  policyId: string;
  message: string;
  signature: string;
  consents: HederaConsent[];
}
export interface HederaPartial {
  from: number;
  publicKey: string;
  signature: string;
}

export function hederaAccountId(value: string): string {
  if (value.length > 23 || !/^0\.0\.(0|[1-9][0-9]*)$/.test(value) || BigInt(value.slice(4)) > MAX_INT64)
    throw new Error('Use a canonical numeric Testnet account ID');
  return value;
}
function enrollmentFields(e: Omit<HederaEnrollment, 'proof'>) {
  return [
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
}
export function signHederaEnrollment(entry: Omit<HederaEnrollment, 'proof'>, key: Uint8Array): HederaEnrollment {
  if (bytesToHex(secp256k1.getPublicKey(key, true)) !== entry.publicKey) throw new Error('Enrollment key mismatch');
  return {
    ...entry,
    proof: bytesToHex(
      secp256k1.sign(hash(['QDWallet-HederaEnrollment/v1', enrollmentFields(entry)]), key, { prehash: false }),
    ),
  };
}
export const hederaJointSid = hederaJointSidInternal;
export function createHederaPolicy(entries: HederaEnrollment[]): HederaSharedPolicy {
  if (entries.length < 2 || entries.length > 5) throw new Error('Shared Hedera supports 2–5 participants');
  const members = [...entries].sort((a, b) => a.partyIndex - b.partyIndex),
    first = members[0]!;
  if (
    first.network !== 'testnet' ||
    first.parties !== members.length ||
    !Number.isInteger(first.threshold) ||
    first.threshold < 2 ||
    first.threshold > members.length ||
    !Number.isSafeInteger(first.derivationIndex) ||
    first.derivationIndex < 0 ||
    first.derivationIndex > 0x7fffffff
  )
    throw new Error('Unsupported Hedera threshold context');
  const common = (e: HederaEnrollment) => [
    e.walletId,
    e.accountId,
    e.keygenId,
    e.membershipVersion,
    e.network,
    e.derivationIndex,
    e.threshold,
    e.parties,
    e.raccoonPublicKey,
  ];
  const ids = new Set<string>(),
    keys = new Set<string>();
  for (let i = 0; i < members.length; i++) {
    const member = members[i]!;
    if (
      member.partyIndex !== i + 1 ||
      JSON.stringify(common(member)) !== JSON.stringify(common(first)) ||
      ids.has(member.participantId) ||
      keys.has(member.publicKey) ||
      !/^0[23][0-9a-f]{64}$/.test(member.publicKey)
    )
      throw new Error('Invalid or duplicate Hedera enrollment');
    if (
      !secp256k1.verify(
        fromHex(member.proof),
        hash(['QDWallet-HederaEnrollment/v1', enrollmentFields(member)]),
        fromHex(member.publicKey),
        { prehash: false, lowS: true },
      )
    )
      throw new Error('Invalid native enrollment proof');
    ids.add(member.participantId);
    keys.add(member.publicKey);
  }
  decodePublicKey(base64.decode(first.raccoonPublicKey));
  return {
    version: 1,
    context: {
      walletId: first.walletId,
      accountId: first.accountId,
      keygenId: first.keygenId,
      membershipVersion: first.membershipVersion,
      network: 'testnet',
    },
    derivationIndex: first.derivationIndex,
    raccoonPublicKey: first.raccoonPublicKey,
    nativeThreshold: Math.floor(members.length / 2) + 1,
    raccoonThreshold: first.threshold,
    members,
  };
}
function policyFields(p: HederaSharedPolicy) {
  return [
    p.version,
    p.context.walletId,
    p.context.accountId,
    p.context.keygenId,
    p.context.membershipVersion,
    p.context.network,
    p.derivationIndex,
    p.nativeThreshold,
    p.raccoonThreshold,
    p.raccoonPublicKey,
  ];
}
export function hederaPolicyId(policy: HederaSharedPolicy): string {
  const expected = createHederaPolicy(policy.members);
  if (JSON.stringify(policyFields(policy)) !== JSON.stringify(policyFields(expected)))
    throw new Error('Hedera policy fields changed');
  return hexHash([
    'QDWallet-HederaPolicy/v1',
    policyFields(expected),
    expected.members.map((m) => [enrollmentFields(m), m.proof]),
  ]);
}
/** Flat native threshold, in participant-index order. No alternate key branches. */
export function hederaThresholdKey(policy: HederaSharedPolicy): KeyList {
  return new KeyList(
    policy.members.map((m) => PublicKey.fromStringECDSA(m.publicKey)),
    policy.nativeThreshold,
  );
}
export function hederaThresholdKeyHex(policy: HederaSharedPolicy): string {
  hederaPolicyId(policy);
  return bytesToHex(proto.Key.encode(hederaThresholdKey(policy)._toProtobufKey()).finish());
}
export function verifyHederaAccount(
  policy: HederaSharedPolicy,
  account: HederaAccountInfo,
  expectedId = account.accountId,
): void {
  hederaPolicyId(policy);
  hederaAccountId(expectedId);
  if (
    account.accountId !== expectedId ||
    account.network !== 'testnet' ||
    account.deleted ||
    account.receiverSignatureRequired ||
    account.key.type !== 'ProtobufEncoded' ||
    account.key.key.toLowerCase() !== hederaThresholdKeyHex(policy)
  )
    throw new Error('Account does not have the exact approved native threshold key');
  if (
    !/^(0|[1-9][0-9]*)$/.test(account.tinybars) ||
    BigInt(account.tinybars) > MAX_INT64 ||
    !/^\d+\.\d{1,9}$/.test(account.balanceTimestamp)
  )
    throw new Error('Invalid Hedera account snapshot');
}

function unsignedEnvelope(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32768) throw new Error('Hedera transaction is oversized');
  const list = proto.TransactionList.decode(bytes);
  if (list.transactionList.length !== 1) throw new Error('Expected one frozen Hedera node transaction');
  const tx = list.transactionList[0]!;
  if (!tx.signedTransactionBytes?.length || tx.bodyBytes?.length || tx.sigMap || tx.body)
    throw new Error('Unsupported Hedera transaction envelope');
  const signed = proto.SignedTransaction.decode(tx.signedTransactionBytes);
  if (!signed.bodyBytes?.length || signed.sigMap?.sigPair?.length)
    throw new Error('Expected an unsigned Hedera transaction');
  if (bytesToHex(proto.TransactionList.encode(list).finish()) !== bytesToHex(bytes))
    throw new Error('Noncanonical Hedera envelope');
  return signed.bodyBytes;
}
export function hederaBody(plan: HederaPlan): Uint8Array {
  return unsignedEnvelope(base64.decode(plan.transactionBytes));
}
export function hederaNativeIntent(
  plan: Pick<
    HederaPlan,
    | 'policyId'
    | 'id'
    | 'kind'
    | 'from'
    | 'to'
    | 'amount'
    | 'maxFee'
    | 'transactionId'
    | 'sourcePolicy'
    | 'targetPolicy'
    | 'migrationId'
  >,
): string {
  return `QDWallet:${plan.id}:${base64urlnopad.encode(hash(['QDWallet-HederaNativeIntent/v1', plan.policyId, plan.kind, plan.from, plan.to, plan.amount, plan.maxFee, plan.transactionId, ...(plan.kind === 'keyUpdate' ? [plan.migrationId, hederaPolicyId(plan.targetPolicy!)] : [])]))}`;
}
function makeTransaction(
  policy: HederaSharedPolicy,
  plan: Pick<
    HederaPlan,
    | 'policyId'
    | 'id'
    | 'kind'
    | 'from'
    | 'to'
    | 'amount'
    | 'maxFee'
    | 'transactionId'
    | 'sourcePolicy'
    | 'targetPolicy'
    | 'migrationId'
  >,
) {
  const transaction =
    plan.kind === 'transfer'
      ? new TransferTransaction()
          .addHbarTransfer(hederaAccountId(plan.from), Hbar.fromTinybars(`-${plan.amount}`))
          .addHbarTransfer(hederaAccountId(plan.to), Hbar.fromTinybars(plan.amount))
      : plan.kind === 'keyUpdate'
        ? new AccountUpdateTransaction()
            .setAccountId(hederaAccountId(plan.from))
            .setKey(hederaThresholdKey(plan.targetPolicy!))
        : new AccountCreateTransaction()
            .setKeyWithoutAlias(hederaThresholdKey(policy))
            .setInitialBalance(Hbar.fromTinybars('0'))
            .setReceiverSignatureRequired(false)
            .setMaxAutomaticTokenAssociations(0)
            .setAccountMemo(`QD shared ${hederaPolicyId(policy).slice(0, 16)}`);
  return transaction
    .setTransactionMemo(hederaNativeIntent(plan))
    .setTransactionId(TransactionId.fromString(plan.transactionId))
    .setTransactionValidDuration(120)
    .setNodeAccountIds([new AccountId(3)])
    .setMaxTransactionFee(Hbar.fromTinybars(plan.maxFee))
    .freeze();
}
function expiry(transactionId: string): number {
  const id = TransactionId.fromString(transactionId),
    start = id.validStart;
  if (!start || id.scheduled || (id.nonce !== null && id.nonce.toString() !== '0'))
    throw new Error('Unsupported transaction ID');
  return Number(start.seconds.toString()) * 1000 + Math.floor(Number(start.nanos.toString()) / 1000000) + 120000;
}
function basePlan(
  policy: HederaSharedPolicy,
  kind: 'create' | 'transfer' | 'keyUpdate',
  from: string,
  to: string,
  amount: bigint,
  maxFee: bigint,
  now: number,
  rotation?: { sourcePolicy: HederaSharedPolicy; targetPolicy: HederaSharedPolicy; migrationId: string },
): HederaPlan {
  const transactionId = new TransactionId(
    AccountId.fromString(hederaAccountId(from)),
    new Timestamp(Math.floor(now / 1000) - 3, crypto.getRandomValues(new Uint32Array(1))[0]! % 1000000000),
  ).toString();
  const plan: HederaPlan = {
    version: 1,
    id: crypto.randomUUID(),
    policyId: hederaPolicyId(policy),
    network: 'testnet',
    ledgerId: HEDERA_LEDGER,
    kind,
    transactionId,
    transactionBytes: '',
    expiresAt: expiry(transactionId),
    from,
    to,
    amount: amount.toString(),
    maxFee: maxFee.toString(),
    ...rotation,
  };
  plan.transactionBytes = base64.encode(makeTransaction(policy, plan).toBytes());
  validateHederaPlan(policy, plan, now);
  return plan;
}
export function makeHederaCreation(
  policy: HederaSharedPolicy,
  payer: string,
  maxFee = HEDERA_MAX_FEE,
  now = Date.now(),
): HederaPlan {
  return basePlan(policy, 'create', payer, '', 0n, maxFee, now);
}
export function makeHederaProposal(
  policy: HederaSharedPolicy,
  from: string,
  to: string,
  amount: bigint,
  maxFee: bigint,
  active: number[],
  now = Date.now(),
): HederaProposal {
  const plan = basePlan(policy, 'transfer', from, to, amount, maxFee, now);
  const proposal: HederaProposal = {
    ...plan,
    kind: 'transfer',
    sid: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    active: [...active],
  };
  validateHederaProposal(policy, proposal, now);
  return proposal;
}
/** Old and new quorums must sign this same body, as required by native Hedera. */
export function makeHederaKeyUpdate(
  source: HederaSharedPolicy,
  target: HederaSharedPolicy,
  accountId: string,
  migrationId: string,
  sourceActive: number[],
  targetActive: number[],
  maxFee = HEDERA_MAX_FEE,
  now = Date.now(),
): { source: HederaProposal; target: HederaProposal } {
  const plan = basePlan(source, 'keyUpdate', accountId, '', 0n, maxFee, now, {
    sourcePolicy: source,
    targetPolicy: target,
    migrationId,
  });
  const proposal = (policy: HederaSharedPolicy, active: number[]): HederaProposal => ({
    ...plan,
    kind: 'keyUpdate',
    approvalPolicyId: hederaPolicyId(policy),
    sid: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    active: [...active],
  });
  const result = { source: proposal(source, sourceActive), target: proposal(target, targetActive) };
  validateHederaProposal(source, result.source, now);
  validateHederaProposal(target, result.target, now);
  return result;
}

/** Rebuild only the allowed operation and compare its complete frozen body.
 * Hidden allowances, token transfers, staking changes, memo/fee mutations,
 * unexpected nodes and arbitrary native operations cannot pass this check. */
export function validateHederaPlan(policy: HederaSharedPolicy, plan: HederaPlan, now = Date.now()): Uint8Array {
  if (
    plan.version !== 1 ||
    plan.policyId !== hederaPolicyId(plan.kind === 'keyUpdate' ? plan.sourcePolicy! : policy) ||
    plan.network !== 'testnet' ||
    plan.ledgerId !== HEDERA_LEDGER ||
    !/^[-0-9a-f]{36}$/.test(plan.id) ||
    !['create', 'transfer', 'keyUpdate'].includes(plan.kind) ||
    plan.expiresAt !== expiry(plan.transactionId) ||
    plan.expiresAt <= now ||
    plan.expiresAt > now + 125000
  )
    throw new Error('Stale or invalid Hedera proposal');
  if (plan.kind === 'keyUpdate') {
    const source = hederaPolicyId(plan.sourcePolicy!),
      target = hederaPolicyId(plan.targetPolicy!);
    if (
      !/^[0-9a-f-]{36}$/.test(plan.migrationId ?? '') ||
      source === target ||
      plan.sourcePolicy!.context.walletId === plan.targetPolicy!.context.walletId ||
      ![source, target].includes(hederaPolicyId(policy)) ||
      plan.amount !== '0' ||
      plan.to !== ''
    )
      throw new Error('Invalid native key migration');
  } else if (plan.sourcePolicy || plan.targetPolicy || plan.migrationId)
    throw new Error('Unexpected migration metadata');
  if (
    plan.amount.length > 19 ||
    plan.maxFee.length > 9 ||
    plan.transactionBytes.length > 45000 ||
    !/^(0|[1-9][0-9]*)$/.test(plan.amount) ||
    !/^[1-9][0-9]*$/.test(plan.maxFee) ||
    BigInt(plan.maxFee) > HEDERA_MAX_FEE ||
    BigInt(plan.amount) > MAX_INT64
  )
    throw new Error('Invalid Hedera amount or fee cap');
  if (TransactionId.fromString(plan.transactionId).accountId?.toString() !== hederaAccountId(plan.from))
    throw new Error('Hedera fee payer changed');
  if (plan.kind === 'create' && (plan.amount !== '0' || plan.to !== ''))
    throw new Error('Unsupported account creation funding');
  if (plan.kind === 'transfer' && (BigInt(plan.amount) <= 0n || hederaAccountId(plan.to) === plan.from))
    throw new Error('Invalid Hedera recipient or amount');
  const body = hederaBody(plan),
    expected = unsignedEnvelope(makeTransaction(policy, plan).toBytes());
  if (bytesToHex(body) !== bytesToHex(expected))
    throw new Error('Frozen Hedera transaction differs from the reviewed operation');
  return body;
}
export function validateHederaProposal(policy: HederaSharedPolicy, p: HederaProposal, now = Date.now()): Uint8Array {
  const body = validateHederaPlan(policy, p, now);
  if (
    !['transfer', 'keyUpdate'].includes(p.kind) ||
    (p.kind === 'keyUpdate' && p.approvalPolicyId !== hederaPolicyId(policy)) ||
    !/^[0-9a-f]{64}$/.test(p.sid) ||
    p.active.length !== policy.raccoonThreshold ||
    p.active.some(
      (v, i) => !Number.isSafeInteger(v) || v < 1 || v > policy.members.length || (i > 0 && v <= p.active[i - 1]!),
    )
  )
    throw new Error('Invalid Raccoon signer selection');
  return body;
}
export function hederaPlanMessage(policy: HederaSharedPolicy, p: HederaPlan, now = Date.now()): string {
  validateHederaPlan(policy, p, now);
  return hexHash([
    'QDWallet-HederaOperation/v1',
    p.policyId,
    p.id,
    p.network,
    p.ledgerId,
    p.kind,
    p.transactionId,
    p.transactionBytes,
    p.expiresAt,
    p.from,
    p.to,
    p.amount,
    p.maxFee,
  ]);
}
export function hederaSharedMessage(policy: HederaSharedPolicy, p: HederaProposal, now = Date.now()): Uint8Array {
  validateHederaProposal(policy, p, now);
  return hash([
    'QDWallet-HederaApproval/v1',
    hederaPlanMessage(policy, p, now),
    p.sid,
    p.active,
    ...(p.kind === 'keyUpdate' ? [hederaPolicyId(policy)] : []),
  ]);
}
/** Each selected worker contributes fresh randomness after explicit approval.
 * A restored backup cannot be tricked into reproducing old Raccoon masks by
 * replaying a coordinator-chosen session identifier. */
function hederaJointSidInternal(policy: HederaSharedPolicy, p: HederaProposal, consents: HederaConsent[]): Uint8Array {
  if (consents.length !== p.active.length) throw new Error('Incomplete signer consent');
  const ordered = p.active.map((from) => {
    const found = consents.filter((c) => c.from === from);
    if (found.length !== 1 || !/^[0-9a-f]{64}$/.test(found[0]!.nonce)) throw new Error('Invalid signer randomness');
    return [from, found[0]!.nonce];
  });
  return hash(['QDWallet-HederaSession/v1', hederaPolicyId(policy), p.id, p.sid, ordered]);
}
export function combineHederaApproval(
  policy: HederaSharedPolicy,
  p: HederaProposal,
  consents: HederaConsent[],
  r1: HederaRound[],
  r2: HederaRound[],
  r3: HederaRound[],
  now = Date.now(),
): HederaApproval {
  const msg = hederaSharedMessage(policy, p, now),
    sid = hederaJointSid(policy, p, consents);
  const ordered = (round: HederaRound[]) =>
    p.active.map((index) => {
      const found = round.filter((r) => r.from === index);
      if (found.length !== 1) throw new Error('Incomplete Raccoon round');
      return base64.decode(found[0]!.payload);
    });
  const first = ordered(r1),
    second = ordered(r2),
    third = ordered(r3);
  const signature = combine(
    decodePublicKey(base64.decode(policy.raccoonPublicKey)),
    { sid, act: p.active, derivationIndex: policy.derivationIndex, msg },
    first.map((b, i) => decodeRound1(p.active[i]!, b)),
    second.map((b, i) => decodeRound2(p.active[i]!, b, p.active)),
    third.map((b, i) => decodeRound3(p.active[i]!, b)),
  );
  return {
    policyId: p.policyId,
    message: bytesToHex(msg),
    signature: base64.encode(encodeSignature(signature)),
    consents,
  };
}
export function verifyHederaApproval(
  policy: HederaSharedPolicy,
  p: HederaProposal,
  approval: HederaApproval,
  now = Date.now(),
): void {
  const message = hederaSharedMessage(policy, p, now);
  hederaJointSid(policy, p, approval.consents);
  if (
    approval.policyId !== p.policyId ||
    approval.message !== bytesToHex(message) ||
    !verify(
      decodePublicKey(base64.decode(policy.raccoonPublicKey)),
      message,
      decodeSignature(base64.decode(approval.signature)),
    )
  )
    throw new Error('Valid Threshold Raccoon approval is required');
}
export function signHederaNative(
  policy: HederaSharedPolicy,
  p: HederaProposal,
  approval: HederaApproval,
  from: number,
  key: Uint8Array,
  now = Date.now(),
): HederaPartial {
  verifyHederaApproval(policy, p, approval, now);
  const member = policy.members.find((m) => m.partyIndex === from);
  const publicKey = bytesToHex(secp256k1.getPublicKey(key, true));
  if (member?.publicKey !== publicKey) throw new Error('Native key is not enrolled');
  return {
    from,
    publicKey,
    signature: bytesToHex(secp256k1.sign(keccak_256(hederaBody(p)), key, { prehash: false, lowS: true })),
  };
}
export function verifyHederaPartial(policy: HederaSharedPolicy, p: HederaPlan, partial: HederaPartial): void {
  if (
    policy.members.find((m) => m.partyIndex === partial.from)?.publicKey !== partial.publicKey ||
    !secp256k1.verify(fromHex(partial.signature), keccak_256(hederaBody(p)), fromHex(partial.publicKey), {
      prehash: false,
      lowS: true,
    })
  )
    throw new Error('Invalid Hedera native signature');
}
function assemble(
  plan: HederaPlan,
  partials: { publicKey: string; signature: string }[],
): { raw: string; transactionId: string; expiresAt: number; intentMemo: string } {
  const body = hederaBody(plan);
  const signed = proto.SignedTransaction.encode({
    bodyBytes: body,
    sigMap: {
      sigPair: partials.map((p) => ({ pubKeyPrefix: fromHex(p.publicKey), ECDSASecp256k1: fromHex(p.signature) })),
    },
  }).finish();
  return {
    raw: base64.encode(
      proto.TransactionList.encode({ transactionList: [{ signedTransactionBytes: signed }] }).finish(),
    ),
    transactionId: plan.transactionId,
    intentMemo: hederaNativeIntent(plan),
    expiresAt: plan.expiresAt,
  };
}
export function finalizeHederaShared(
  policy: HederaSharedPolicy,
  p: HederaProposal,
  approval: HederaApproval,
  partials: HederaPartial[],
  now = Date.now(),
) {
  if (p.kind !== 'transfer') throw new Error('Key rotation requires both old and new quorums');
  verifyHederaApproval(policy, p, approval, now);
  const members = new Map<number, HederaPartial>();
  for (const partial of partials) {
    verifyHederaPartial(policy, p, partial);
    members.set(partial.from, partial);
  }
  if (members.size < policy.nativeThreshold || members.size > policy.members.length)
    throw new Error('Hedera native quorum is incomplete');
  return assemble(
    p,
    [...members.values()].sort((a, b) => a.from - b.from),
  );
}
export function signHederaCreation(policy: HederaSharedPolicy, plan: HederaPlan, key: Uint8Array, now = Date.now()) {
  validateHederaPlan(policy, plan, now);
  if (plan.kind !== 'create') throw new Error('Expected account creation');
  return assemble(plan, [
    {
      publicKey: bytesToHex(secp256k1.getPublicKey(key, true)),
      signature: bytesToHex(secp256k1.sign(keccak_256(hederaBody(plan)), key, { prehash: false, lowS: true })),
    },
  ]);
}

/** No single-quorum finalization is permitted for an account-key update. */
export function finalizeHederaKeyUpdate(
  source: HederaProposal,
  sourceApproval: HederaApproval,
  sourcePartials: HederaPartial[],
  target: HederaProposal,
  targetApproval: HederaApproval,
  targetPartials: HederaPartial[],
  now = Date.now(),
) {
  if (
    source.kind !== 'keyUpdate' ||
    target.kind !== 'keyUpdate' ||
    source.transactionBytes !== target.transactionBytes ||
    source.id !== target.id ||
    hederaPolicyId(source.sourcePolicy!) !== hederaPolicyId(target.sourcePolicy!) ||
    hederaPolicyId(source.targetPolicy!) !== hederaPolicyId(target.targetPolicy!)
  )
    throw new Error('Rotation bodies or policies differ');
  const groups = [
    [source.sourcePolicy!, source, sourceApproval, sourcePartials],
    [source.targetPolicy!, target, targetApproval, targetPartials],
  ] as const;
  const signatures = new Map<string, HederaPartial>();
  for (const [policy, proposal, approval, partials] of groups) {
    verifyHederaApproval(policy, proposal, approval, now);
    const members = new Set<number>();
    for (const partial of partials) {
      verifyHederaPartial(policy, proposal, partial);
      members.add(partial.from);
      signatures.set(partial.publicKey, partial);
    }
    if (members.size < policy.nativeThreshold) throw new Error('Both old and new native quorums are required');
  }
  return assemble(
    source,
    [...signatures.values()].sort((a, b) => (a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0)),
  );
}
