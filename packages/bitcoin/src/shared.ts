import { HDKey } from '@scure/bip32';
import { base64 } from '@scure/base';
import { Transaction, RawTx, p2ms, p2wsh, TEST_NETWORK } from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, fromHex, type BitcoinSharedContext } from '@qd/wallet-core';
import {
  decodePublicKey,
  decodeSignature,
  encodeSignature,
  verify,
  combine,
  decodeRound1,
  decodeRound2,
  decodeRound3,
} from '@qd/qd-crypto';
import { scriptPubKeyHex } from './address';
import { MAX_BITCOIN_SATS, validateUtxos, verifyPreviousOutput, outpoint } from './validation';
import type { BtcUtxo } from './types';

export const BITCOIN_TESTNET4_GENESIS = '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043';
export interface BitcoinEnrollment extends BitcoinSharedContext {
  participantId: string;
  partyIndex: number;
  derivationIndex: number;
  threshold: number;
  parties: number;
  xpub: string;
  raccoonPublicKey: string; // base64
  proof: string; // compact ECDSA proof under this participant's branch 0/index 0 key
}
export interface BitcoinSharedPolicy {
  version: 1;
  context: BitcoinSharedContext;
  derivationIndex: number;
  raccoonPublicKey: string;
  raccoonThreshold: number;
  nativeThreshold: number;
  members: BitcoinEnrollment[];
}
export interface SharedBitcoinCoin extends BtcUtxo {
  branch: 0 | 1;
  addressIndex: number;
}
export interface SharedBitcoinProposal {
  version: 1 | 2;
  id: string;
  policyId: string;
  genesis: string;
  sid: string;
  active: number[];
  expiresAt: number;
  psbt: string;
  recipient: string;
  amount: string;
  maxFee: string;
  changeIndex: number | null;
  inputPaths: { branch: 0 | 1; index: number }[];
  migration?: { id: string; targetPolicy: BitcoinSharedPolicy };
}
export interface BitcoinRound {
  from: number;
  payload: string;
}
export interface BitcoinConsent {
  from: number;
  nonce: string;
}
export interface BitcoinApproval {
  policyId: string;
  message: string;
  signature: string;
}
export const bitcoinWireText = (bytes: Uint8Array): string => base64.encode(bytes);
export const bitcoinWireBytes = (text: string): Uint8Array => base64.decode(text);

const jsonHash = (value: unknown): Uint8Array => sha256(new TextEncoder().encode(JSON.stringify(value)));
const hexHash = (value: unknown): string => bytesToHex(jsonHash(value));
const boundedIndex = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0 || n >= 10000) throw new Error('Invalid Bitcoin address index');
};

export function enrollmentMessage(e: Omit<BitcoinEnrollment, 'proof'> | BitcoinEnrollment): Uint8Array {
  return jsonHash([
    'QDWallet-BitcoinEnrollment/v1',
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
    e.xpub,
    e.raccoonPublicKey,
  ]);
}

export function signBitcoinEnrollment(
  entry: Omit<BitcoinEnrollment, 'proof'>,
  privateKey: Uint8Array,
): BitcoinEnrollment {
  return { ...entry, proof: bytesToHex(secp256k1.sign(enrollmentMessage(entry), privateKey, { prehash: false })) };
}

export function nativePublicKey(e: BitcoinEnrollment, branch: 0 | 1, index: number): Uint8Array {
  boundedIndex(index);
  if (branch !== 0 && branch !== 1) throw new Error('Invalid Bitcoin branch');
  const root = HDKey.fromExtendedKey(e.xpub, { public: 0x043587cf, private: 0x04358394 });
  if (root.privateKey || root.depth !== 12 || !e.xpub.startsWith('tpub'))
    throw new Error('Expected a public shared-account root');
  return root.deriveChild(branch).deriveChild(index).publicKey!;
}

export function createBitcoinPolicy(enrollments: BitcoinEnrollment[]): BitcoinSharedPolicy {
  if (enrollments.length < 2 || enrollments.length > 5)
    throw new Error('Shared Bitcoin currently supports 2–5 participants');
  const members = [...enrollments].sort((a, b) => a.partyIndex - b.partyIndex),
    first = members[0]!;
  if (first.network !== 'testnet4') throw new Error('Shared Bitcoin is Testnet4 research preview only');
  const expected = [
    first.walletId,
    first.accountId,
    first.keygenId,
    first.membershipVersion,
    first.network,
    first.derivationIndex,
    first.threshold,
    first.parties,
    first.raccoonPublicKey,
  ];
  const identities = new Set<string>(),
    keys = new Set<string>();
  if (
    enrollments[0]!.network !== 'testnet4' ||
    enrollments[0]!.parties !== enrollments.length ||
    !Number.isInteger(enrollments[0]!.threshold) ||
    enrollments[0]!.threshold < 1 ||
    enrollments[0]!.threshold > enrollments.length
  )
    throw new Error('Invalid Bitcoin threshold context');
  boundedIndex(enrollments[0]!.derivationIndex);
  for (let i = 0; i < members.length; i++) {
    const member = members[i]!;
    const identity = [
      member.walletId,
      member.accountId,
      member.keygenId,
      member.membershipVersion,
      member.network,
      member.derivationIndex,
      member.threshold,
      member.parties,
      member.raccoonPublicKey,
    ];
    if (
      JSON.stringify(expected) !== JSON.stringify(identity) ||
      member.partyIndex !== i + 1 ||
      identities.has(member.participantId)
    )
      throw new Error('Enrollment context or participant mismatch');
    const pub = nativePublicKey(member, 0, 0),
      key = bytesToHex(pub);
    if (
      keys.has(key) ||
      !secp256k1.verify(fromHex(member.proof), enrollmentMessage(member), pub, { prehash: false, lowS: true })
    )
      throw new Error('Invalid or duplicate native key enrollment');
    identities.add(member.participantId);
    keys.add(key);
  }
  if (first.parties !== members.length || first.threshold < 2 || first.threshold > members.length)
    throw new Error('Invalid Raccoon threshold');
  decodePublicKey(base64.decode(first.raccoonPublicKey));
  return {
    version: 1,
    context: {
      walletId: first.walletId,
      accountId: first.accountId,
      keygenId: first.keygenId,
      membershipVersion: first.membershipVersion,
      network: 'testnet4',
    },
    derivationIndex: first.derivationIndex,
    raccoonPublicKey: first.raccoonPublicKey,
    raccoonThreshold: first.threshold,
    nativeThreshold: Math.floor(members.length / 2) + 1,
    members,
  };
}

export function bitcoinPolicyId(policy: BitcoinSharedPolicy): string {
  const expected = createBitcoinPolicy(policy.members);
  const fields = (p: BitcoinSharedPolicy) => [
    p.version,
    p.context.walletId,
    p.context.accountId,
    p.context.keygenId,
    p.context.membershipVersion,
    p.context.network,
    p.derivationIndex,
    p.raccoonPublicKey,
    p.raccoonThreshold,
    p.nativeThreshold,
  ];
  if (JSON.stringify(fields(policy)) !== JSON.stringify(fields(expected)))
    throw new Error('Policy fields differ from authenticated enrollment');
  return hexHash([
    'QDWallet-BitcoinPolicy/v1',
    fields(expected),
    expected.members.map((m) => [m.participantId, m.partyIndex, m.xpub, m.proof, bytesToHex(enrollmentMessage(m))]),
  ]);
}

export function sharedBitcoinOutput(policy: BitcoinSharedPolicy, branch: 0 | 1, index: number) {
  const pubs = policy.members
    .map((m) => nativePublicKey(m, branch, index))
    // Binary lexical order is deterministic across participants' locales.
    .sort((a, b) => {
      const left = bytesToHex(a),
        right = bytesToHex(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  if (new Set(pubs.map(bytesToHex)).size !== pubs.length) throw new Error('Duplicate native signing keys');
  return p2wsh(p2ms(policy.nativeThreshold, pubs), TEST_NETWORK);
}

/** Conservative bound: maximum DER signatures and the complete witness script. */
export function sharedBitcoinVsize(policy: BitcoinSharedPolicy, inputs: number, outputs = 2): number {
  if (!Number.isInteger(inputs) || inputs < 1 || inputs > 100)
    throw new Error('Shared Bitcoin supports at most 100 inputs');
  const script = sharedBitcoinOutput(policy, 0, 0).witnessScript.length;
  return (
    11 +
    inputs * (41 + Math.ceil((3 + 74 * policy.nativeThreshold + (script < 253 ? 1 : 3) + script) / 4)) +
    outputs * 43
  );
}

export function makeSharedBitcoinProposal(
  policy: BitcoinSharedPolicy,
  coins: SharedBitcoinCoin[],
  recipient: string,
  amount: bigint,
  feeRate: number,
  changeIndex: number,
  active: number[],
  now = Date.now(),
): SharedBitcoinProposal {
  const policyId = bitcoinPolicyId(policy);
  boundedIndex(changeIndex);
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > 5000 || amount < 330n || amount > MAX_BITCOIN_SATS)
    throw new Error('Invalid amount or fee rate');
  const selected: SharedBitcoinCoin[] = [];
  let total = 0n;
  validateUtxos(coins);
  for (const coin of [...coins].sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0))) {
    if (coin.confirmations < 1) continue;
    verifyPreviousOutput(coin);
    if (coin.scriptPubKey !== bytesToHex(sharedBitcoinOutput(policy, coin.branch, coin.addressIndex).script))
      throw new Error('Foreign shared Bitcoin input');
    selected.push(coin);
    total += coin.value;
    if (total >= amount + BigInt(Math.ceil(sharedBitcoinVsize(policy, selected.length) * feeRate))) break;
  }
  if (!selected.length) throw new Error('No confirmed shared Bitcoin coins');
  let fee = BigInt(Math.ceil(sharedBitcoinVsize(policy, selected.length) * feeRate));
  let change = total - amount - fee;
  if (change < 0n) throw new Error('Not enough shared Bitcoin funds');
  if (change < 330n) {
    change = 0n;
    fee = total - amount;
  }
  const tx = new Transaction({ version: 2 });
  for (const coin of selected) {
    const output = sharedBitcoinOutput(policy, coin.branch, coin.addressIndex);
    tx.addInput({
      txid: coin.txid,
      index: coin.vout,
      sequence: 0xffffffff,
      sighashType: 1,
      witnessUtxo: { amount: coin.value, script: output.script },
      nonWitnessUtxo: fromHex(coin.previousTx!),
      witnessScript: output.witnessScript,
    });
  }
  tx.addOutputAddress(recipient, amount, TEST_NETWORK);
  if (change) tx.addOutputAddress(sharedBitcoinOutput(policy, 1, changeIndex).address, change, TEST_NETWORK);
  const proposal: SharedBitcoinProposal = {
    version: 2,
    id: crypto.randomUUID(),
    policyId,
    genesis: BITCOIN_TESTNET4_GENESIS,
    sid: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    active: [...active],
    expiresAt: now + 30 * 60_000,
    psbt: base64.encode(tx.toPSBT()),
    recipient,
    amount: amount.toString(),
    maxFee: fee.toString(),
    changeIndex: change ? changeIndex : null,
    inputPaths: selected.map((c) => ({ branch: c.branch, index: c.addressIndex })),
  };
  validateSharedBitcoinProposal(policy, proposal, now);
  return proposal;
}

export function validateSharedBitcoinProposal(
  policy: BitcoinSharedPolicy,
  p: SharedBitcoinProposal,
  now = Date.now(),
): Transaction {
  if (
    ![1, 2].includes(p.version) ||
    p.policyId !== bitcoinPolicyId(policy) ||
    p.genesis !== BITCOIN_TESTNET4_GENESIS ||
    !/^[0-9a-f]{64}$/.test(p.sid) ||
    !/^[0-9a-f-]{36}$/.test(p.id) ||
    !Number.isSafeInteger(p.expiresAt) ||
    p.expiresAt <= now ||
    p.expiresAt > now + 24 * 60 * 60_000 ||
    p.psbt.length > 12_000_000
  )
    throw new Error('Stale or invalid Bitcoin proposal');
  if (
    p.active.length !== policy.raccoonThreshold ||
    new Set(p.active).size !== p.active.length ||
    p.active.some(
      (v, i) => !Number.isInteger(v) || v < 1 || v > policy.members.length || (i > 0 && v <= p.active[i - 1]!),
    )
  )
    throw new Error('Invalid Raccoon signer set');
  if (!/^[1-9][0-9]*$/.test(p.amount) || !/^(0|[1-9][0-9]*)$/.test(p.maxFee)) throw new Error('Invalid review amounts');
  const tx = Transaction.fromPSBT(base64.decode(p.psbt));
  if (
    tx.version !== 2 ||
    tx.lockTime !== 0 ||
    tx.inputsLength < 1 ||
    tx.inputsLength > 100 ||
    p.inputPaths.length !== tx.inputsLength ||
    tx.outputsLength < 1 ||
    tx.outputsLength > 2
  )
    throw new Error('Unsupported shared Bitcoin structure');
  const seen = new Set<string>();
  let total = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i),
      path = p.inputPaths[i]!;
    const output = sharedBitcoinOutput(policy, path.branch, path.index);
    if (
      !input.txid ||
      input.index === undefined ||
      !input.witnessUtxo ||
      !input.nonWitnessUtxo ||
      !input.witnessScript ||
      input.sighashType !== 1 ||
      input.sequence !== 0xffffffff ||
      input.partialSig?.length ||
      input.finalScriptWitness?.length ||
      input.finalScriptSig?.length ||
      input.redeemScript ||
      input.tapKeySig
    )
      throw new Error('Unsupported or unverified shared input');
    const point = outpoint({ txid: bytesToHex(input.txid), vout: input.index });
    if (seen.has(point)) throw new Error('Duplicate shared input');
    seen.add(point);
    if (
      bytesToHex(input.witnessUtxo.script) !== bytesToHex(output.script) ||
      bytesToHex(input.witnessScript) !== bytesToHex(output.witnessScript)
    )
      throw new Error('Foreign multisignature input');
    const prev = input.nonWitnessUtxo.outputs[input.index];
    if (!prev || prev.amount !== input.witnessUtxo.amount || bytesToHex(prev.script) !== bytesToHex(output.script))
      throw new Error('Shared previous output mismatch');
    const previous = Transaction.fromRaw(RawTx.encode(input.nonWitnessUtxo), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    if (previous.id !== bytesToHex(input.txid)) throw new Error('Shared previous transaction ID mismatch');
    if (prev.amount <= 0n || prev.amount > MAX_BITCOIN_SATS) throw new Error('Invalid previous value');
    total += prev.amount;
  }
  const recipient = tx.getOutput(0);
  if (
    recipient.amount !== BigInt(p.amount) ||
    !recipient.script ||
    bytesToHex(recipient.script) !== scriptPubKeyHex(p.recipient)
  )
    throw new Error('Shared recipient changed');
  if (tx.outputsLength === 2) {
    if (p.changeIndex === null) throw new Error('Missing shared change index');
    const output = tx.getOutput(1),
      expected = sharedBitcoinOutput(policy, 1, p.changeIndex);
    if (
      !output.script ||
      bytesToHex(output.script) !== bytesToHex(expected.script) ||
      !output.amount ||
      output.amount < 330n
    )
      throw new Error('Invalid shared change');
  } else if (p.changeIndex !== null) throw new Error('Unexpected shared change');
  let spent = 0n;
  for (let i = 0; i < tx.outputsLength; i++) spent += tx.getOutput(i).amount!;
  const fee = total - spent;
  if (p.migration) {
    if (
      p.version !== 2 ||
      !/^[0-9a-f-]{36}$/.test(p.migration.id) ||
      p.migration.targetPolicy.context.walletId === policy.context.walletId ||
      bitcoinPolicyId(p.migration.targetPolicy) === p.policyId ||
      p.recipient !== sharedBitcoinOutput(p.migration.targetPolicy, 0, 0).address ||
      tx.outputsLength !== 1 ||
      p.changeIndex !== null
    )
      throw new Error('Migration must sweep to the exact approved replacement policy');
  }
  if (
    total > MAX_BITCOIN_SATS ||
    fee < 0n ||
    fee !== BigInt(p.maxFee) ||
    fee > BigInt(sharedBitcoinVsize(policy, tx.inputsLength, tx.outputsLength) * 5000)
  )
    throw new Error('Shared fee exceeds policy');
  return tx;
}

export function sharedBitcoinMessage(
  policy: BitcoinSharedPolicy,
  p: SharedBitcoinProposal,
  now = Date.now(),
): Uint8Array {
  validateSharedBitcoinProposal(policy, p, now);
  return jsonHash([
    `QDWallet-BitcoinApproval/v${p.version}`,
    p.policyId,
    p.genesis,
    p.id,
    p.sid,
    p.active,
    p.expiresAt,
    p.psbt,
    p.recipient,
    p.amount,
    p.maxFee,
    p.changeIndex,
    p.inputPaths.map((i) => [i.branch, i.index]),
    ...(p.migration ? [p.migration.id, bitcoinPolicyId(p.migration.targetPolicy)] : []),
  ]);
}

/** A membership migration spends every supplied confirmed source coin and has
 * one destination: the new group's independently verified native script. */
export function makeSharedBitcoinMigration(
  source: BitcoinSharedPolicy,
  target: BitcoinSharedPolicy,
  migrationId: string,
  coins: SharedBitcoinCoin[],
  feeRate: number,
  active: number[],
  now = Date.now(),
): SharedBitcoinProposal {
  bitcoinPolicyId(source);
  bitcoinPolicyId(target);
  validateUtxos(coins);
  if (
    !coins.length ||
    coins.length > 100 ||
    coins.some((c) => c.confirmations < 1) ||
    !Number.isFinite(feeRate) ||
    feeRate < 1 ||
    feeRate > 5000
  )
    throw new Error('Migration requires between 1 and 100 confirmed inputs and a bounded fee rate');
  const tx = new Transaction({ version: 2 });
  let total = 0n;
  for (const coin of coins) {
    verifyPreviousOutput(coin);
    const output = sharedBitcoinOutput(source, coin.branch, coin.addressIndex);
    if (bytesToHex(output.script) !== coin.scriptPubKey)
      throw new Error('Migration input is not owned by the old policy');
    tx.addInput({
      txid: coin.txid,
      index: coin.vout,
      sequence: 0xffffffff,
      sighashType: 1,
      witnessUtxo: { amount: coin.value, script: output.script },
      nonWitnessUtxo: fromHex(coin.previousTx!),
      witnessScript: output.witnessScript,
    });
    total += coin.value;
  }
  const fee = BigInt(Math.ceil(sharedBitcoinVsize(source, coins.length, 1) * feeRate)),
    amount = total - fee,
    recipient = sharedBitcoinOutput(target, 0, 0).address;
  if (amount < 330n) throw new Error('Source funds do not cover the migration fee and a spendable output');
  tx.addOutputAddress(recipient, amount, TEST_NETWORK);
  const p: SharedBitcoinProposal = {
    version: 2,
    id: crypto.randomUUID(),
    policyId: bitcoinPolicyId(source),
    genesis: BITCOIN_TESTNET4_GENESIS,
    sid: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    active: [...active],
    expiresAt: now + 30 * 60000,
    psbt: base64.encode(tx.toPSBT()),
    recipient,
    amount: amount.toString(),
    maxFee: fee.toString(),
    changeIndex: null,
    inputPaths: coins.map((c) => ({ branch: c.branch, index: c.addressIndex })),
    migration: { id: migrationId, targetPolicy: target },
  };
  validateSharedBitcoinProposal(source, p, now);
  return p;
}

export function combineBitcoinApproval(
  policy: BitcoinSharedPolicy,
  p: SharedBitcoinProposal,
  r1: BitcoinRound[],
  r2: BitcoinRound[],
  r3: BitcoinRound[],
  now = Date.now(),
  consents: BitcoinConsent[] = [],
): BitcoinApproval {
  const msg = sharedBitcoinMessage(policy, p, now);
  const ordered = (round: BitcoinRound[]) =>
    p.active.map((index) => {
      const found = round.filter((r) => r.from === index);
      if (found.length !== 1) throw new Error('Incomplete or duplicate Raccoon messages');
      return base64.decode(found[0]!.payload);
    });
  const first = ordered(r1),
    second = ordered(r2),
    third = ordered(r3);
  const signature = combine(
    decodePublicKey(base64.decode(policy.raccoonPublicKey)),
    { sid: bitcoinSigningSid(policy, p, consents, now), act: p.active, derivationIndex: policy.derivationIndex, msg },
    first.map((b, i) => decodeRound1(p.active[i]!, b)),
    second.map((b, i) => decodeRound2(p.active[i]!, b, p.active)),
    third.map((b, i) => decodeRound3(p.active[i]!, b)),
  );
  return { policyId: p.policyId, message: bytesToHex(msg), signature: base64.encode(encodeSignature(signature)) };
}

/** Per-signer entropy prevents mask reuse after restoring a stale backup.
 * v1 is retained only to verify legacy evidence; workers start new v2 sessions. */
export function bitcoinSigningSid(
  policy: BitcoinSharedPolicy,
  p: SharedBitcoinProposal,
  consents: BitcoinConsent[],
  now = Date.now(),
): Uint8Array {
  const message = sharedBitcoinMessage(policy, p, now);
  if (p.version === 1) return fromHex(p.sid);
  if (consents.length !== p.active.length) throw new Error('Every selected signer must provide consent randomness');
  const ordered = p.active.map((from) => {
    const matches = consents.filter((c) => c.from === from);
    if (matches.length !== 1 || !/^[0-9a-f]{64}$/.test(matches[0]!.nonce))
      throw new Error('Invalid or duplicate Bitcoin signer consent');
    return [from, matches[0]!.nonce];
  });
  return jsonHash(['QDWallet-BitcoinJointSession/v2', bytesToHex(message), ordered]);
}

export function verifyBitcoinApproval(
  policy: BitcoinSharedPolicy,
  p: SharedBitcoinProposal,
  approval: BitcoinApproval,
  now = Date.now(),
): void {
  const msg = sharedBitcoinMessage(policy, p, now);
  if (
    approval.policyId !== p.policyId ||
    approval.message !== bytesToHex(msg) ||
    !verify(
      decodePublicKey(base64.decode(policy.raccoonPublicKey)),
      msg,
      decodeSignature(base64.decode(approval.signature)),
    )
  )
    throw new Error('Valid Threshold Raccoon approval is required');
}

/** Native key access is scoped by the caller's worker; every input is signed separately. */
export function signSharedBitcoin(
  policy: BitcoinSharedPolicy,
  p: SharedBitcoinProposal,
  approval: BitcoinApproval,
  partyIndex: number,
  withKey: <T>(branch: 0 | 1, index: number, fn: (key: Uint8Array) => T) => T,
  now = Date.now(),
): string {
  verifyBitcoinApproval(policy, p, approval, now);
  const tx = validateSharedBitcoinProposal(policy, p, now),
    member = policy.members.find((m) => m.partyIndex === partyIndex);
  if (!member) throw new Error('Not a native signer');
  for (let i = 0; i < tx.inputsLength; i++) {
    const path = p.inputPaths[i]!;
    withKey(path.branch, path.index, (key) => {
      if (
        bytesToHex(secp256k1.getPublicKey(key, true)) !== bytesToHex(nativePublicKey(member, path.branch, path.index))
      )
        throw new Error('Native key is not enrolled');
      tx.signIdx(key, i);
    });
  }
  return base64.encode(tx.toPSBT());
}

export function finalizeSharedBitcoin(
  policy: BitcoinSharedPolicy,
  p: SharedBitcoinProposal,
  approval: BitcoinApproval,
  partials: string[],
  now = Date.now(),
) {
  verifyBitcoinApproval(policy, p, approval, now);
  const expected = validateSharedBitcoinProposal(policy, p, now);
  if (partials.length < policy.nativeThreshold || partials.length > policy.members.length)
    throw new Error('Native signing quorum is incomplete');
  // Only verified signature tuples are imported. Other fields from an untrusted
  // participant's PSBT must never replace the reviewed input metadata.
  const signatures = new Map<number, Map<string, [Uint8Array, Uint8Array]>>();
  for (const psbt of partials) {
    const part = Transaction.fromPSBT(base64.decode(psbt));
    if (bytesToHex(part.unsignedTx) !== bytesToHex(expected.unsignedTx))
      throw new Error('Partial signature is for another transaction');
    for (let i = 0; i < part.inputsLength; i++) {
      const path = p.inputPaths[i]!,
        input = part.getInput(i),
        allowed = new Set(policy.members.map((m) => bytesToHex(nativePublicKey(m, path.branch, path.index))));
      const reference = expected.getInput(i);
      const hash = expected.preimageWitnessV0(i, reference.witnessScript!, 1, reference.witnessUtxo!.amount);
      for (const [pub, sig] of input.partialSig ?? []) {
        if (
          !allowed.has(bytesToHex(pub)) ||
          sig[sig.length - 1] !== 1 ||
          !secp256k1.verify(sig.subarray(0, -1), hash, pub, { format: 'der', prehash: false, lowS: true })
        )
          throw new Error('Invalid native partial signature');
        const collected = signatures.get(i) ?? new Map<string, [Uint8Array, Uint8Array]>();
        collected.set(bytesToHex(pub), [pub, sig]);
        signatures.set(i, collected);
      }
    }
  }
  const combined = expected;
  for (let i = 0; i < combined.inputsLength; i++) {
    const collected = signatures.get(i);
    if (!collected || collected.size < policy.nativeThreshold) throw new Error('Native signing quorum is incomplete');
    combined.updateInput(i, { partialSig: [...collected.values()] });
  }
  combined.finalize();
  return { txid: combined.id, raw: bytesToHex(combined.extract()), vsize: combined.vsize };
}

/** Validate stored evidence independently of its encryption or display metadata. */
export function verifySavedBitcoinPartial(
  policy: BitcoinSharedPolicy,
  proposal: SharedBitcoinProposal,
  partial: string,
  partyIndex: number,
): void {
  const now = Math.min(Date.now(), proposal.expiresAt - 1),
    expected = validateSharedBitcoinProposal(policy, proposal, now),
    signed = Transaction.fromPSBT(base64.decode(partial)),
    member = policy.members.find((m) => m.partyIndex === partyIndex);
  if (!member || bytesToHex(signed.unsignedTx) !== bytesToHex(expected.unsignedTx))
    throw new Error('Saved partial is for another transaction or signer');
  for (let i = 0; i < expected.inputsLength; i++) {
    const path = proposal.inputPaths[i]!,
      input = expected.getInput(i),
      key = nativePublicKey(member, path.branch, path.index),
      signatures = signed.getInput(i).partialSig ?? [];
    if (signatures.length !== 1) throw new Error('Invalid saved native partial');
    const [pub, sig] = signatures[0]!;
    if (
      bytesToHex(pub) !== bytesToHex(key) ||
      sig[sig.length - 1] !== 1 ||
      !secp256k1.verify(
        sig.subarray(0, -1),
        expected.preimageWitnessV0(i, input.witnessScript!, 1, input.witnessUtxo!.amount),
        pub,
        { format: 'der', prehash: false, lowS: true },
      )
    )
      throw new Error('Invalid saved native partial');
  }
}

export function verifySavedBitcoinTransaction(
  policy: BitcoinSharedPolicy,
  proposal: SharedBitcoinProposal,
  raw: string,
): { txid: string; raw: string; vsize: number } {
  if (!/^(?:[0-9a-f]{2})+$/.test(raw) || raw.length > 8000000) throw new Error('Invalid saved transaction bytes');
  const expected = validateSharedBitcoinProposal(policy, proposal, Math.min(Date.now(), proposal.expiresAt - 1)),
    signed = Transaction.fromRaw(fromHex(raw));
  if (bytesToHex(signed.unsignedTx) !== bytesToHex(expected.unsignedTx))
    throw new Error('Saved transaction differs from the reviewed payment');
  for (let i = 0; i < signed.inputsLength; i++) {
    const input = expected.getInput(i),
      witness = signed.getInput(i).finalScriptWitness,
      path = proposal.inputPaths[i]!,
      keys = policy.members
        .map((m) => nativePublicKey(m, path.branch, path.index))
        .sort((a, b) => {
          const x = bytesToHex(a),
            y = bytesToHex(b);
          return x < y ? -1 : x > y ? 1 : 0;
        });
    if (
      !witness ||
      witness.length !== policy.nativeThreshold + 2 ||
      witness[0]!.length ||
      bytesToHex(witness[witness.length - 1]!) !== bytesToHex(input.witnessScript!)
    )
      throw new Error('Saved witness does not match the native policy');
    const hash = expected.preimageWitnessV0(i, input.witnessScript!, 1, input.witnessUtxo!.amount);
    let nextKey = 0;
    const verified: [Uint8Array, Uint8Array][] = [];
    for (const sig of witness.slice(1, -1)) {
      if (sig[sig.length - 1] !== 1) throw new Error('Unsupported saved signature mode');
      let found = false;
      while (nextKey < keys.length) {
        const pub = keys[nextKey++]!;
        if (secp256k1.verify(sig.subarray(0, -1), hash, pub, { format: 'der', prehash: false, lowS: true })) {
          verified.push([pub, sig]);
          found = true;
          break;
        }
      }
      if (!found) throw new Error('Saved native quorum is invalid');
    }
    expected.updateInput(i, { partialSig: verified });
  }
  expected.finalize();
  if (bytesToHex(expected.extract()) !== raw) throw new Error('Saved native transaction is noncanonical');
  return { txid: expected.id, raw, vsize: expected.vsize };
}
