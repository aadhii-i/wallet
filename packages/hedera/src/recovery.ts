import { proto } from '@hiero-ledger/proto';
import { base64 } from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, fromHex } from '@qd/wallet-core';
import { validateHederaPlan, type HederaPlan, type HederaSharedPolicy } from './shared';

/** Audit saved native bytes before exposing a recovery retry. Authentication
 * of a backup file alone is insufficient to validate its display metadata. */
export function verifyHederaSavedPlan(
  policy: HederaSharedPolicy,
  plan: HederaPlan,
  raw: string,
  creationPublicKey?: string,
): void {
  const expected = validateHederaPlan(policy, plan, Math.min(Date.now(), plan.expiresAt - 1)),
    bytes = base64.decode(raw);
  if (bytes.length > 32768) throw new Error('Saved Hedera transaction is oversized');
  const list = proto.TransactionList.decode(bytes),
    transaction = list.transactionList[0];
  if (
    list.transactionList.length !== 1 ||
    !transaction?.signedTransactionBytes?.length ||
    transaction.bodyBytes?.length ||
    transaction.sigMap ||
    transaction.body
  )
    throw new Error('Invalid saved Hedera envelope');
  if (bytesToHex(proto.TransactionList.encode(list).finish()) !== bytesToHex(bytes))
    throw new Error('Noncanonical saved Hedera envelope');
  const signed = proto.SignedTransaction.decode(transaction.signedTransactionBytes);
  if (!signed.bodyBytes || bytesToHex(signed.bodyBytes) !== bytesToHex(expected))
    throw new Error('Saved Hedera bytes differ from the reviewed operation');
  const allowed =
    plan.kind === 'create'
      ? new Set([creationPublicKey])
      : new Set(
          (plan.kind === 'keyUpdate'
            ? [...plan.sourcePolicy!.members, ...plan.targetPolicy!.members]
            : policy.members
          ).map((m) => m.publicKey),
        );
  if (plan.kind === 'create' && !creationPublicKey) throw new Error('Missing personal creation payer key');
  const signers = new Set<string>();
  for (const pair of signed.sigMap?.sigPair ?? []) {
    const pub = bytesToHex(pair.pubKeyPrefix ?? new Uint8Array());
    if (
      signers.has(pub) ||
      !allowed.has(pub) ||
      !pair.ECDSASecp256k1 ||
      Object.keys(pair).some((k) => !['pubKeyPrefix', 'ECDSASecp256k1'].includes(k)) ||
      !secp256k1.verify(pair.ECDSASecp256k1, keccak_256(expected), fromHex(pub), { prehash: false, lowS: true })
    )
      throw new Error('Invalid saved native signature');
    signers.add(pub);
  }
  if (plan.kind === 'keyUpdate') {
    for (const group of [plan.sourcePolicy!, plan.targetPolicy!])
      if (group.members.filter((m) => signers.has(m.publicKey)).length < group.nativeThreshold)
        throw new Error('Saved rotation is missing a native quorum');
  }
  if (signers.size < (plan.kind === 'create' ? 1 : policy.nativeThreshold))
    throw new Error('Saved native quorum is incomplete');
}
