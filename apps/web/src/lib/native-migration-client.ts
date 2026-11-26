import * as B from '@qd/bitcoin';
import * as H from '@qd/hedera';
import { bytesToHex } from '@qd/wallet-core';
import {
  fromB64url,
  nativeMigrationFields,
  nativeMigrationApprovalMessage,
  type NativeMigration,
  type NativePolicy,
} from '@qd/rpc';
import { getApi } from './api';

export const bitcoinPolicy = (p: NativePolicy) => p as unknown as B.BitcoinSharedPolicy;
export const hederaPolicy = (p: NativePolicy) => p as unknown as H.HederaSharedPolicy;

/** Rebuild the review and both native policies locally before showing an
 * approval button. Server status alone never authorizes native signing. */
export async function verifyMigration(m: NativeMigration): Promise<void> {
  const manifest = m.manifest;
  const digest = bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(nativeMigrationFields(manifest)))),
    ),
  );
  if (
    digest !== m.digest ||
    manifest.version !== 1 ||
    manifest.sourceWalletId === manifest.targetWalletId ||
    !manifest.intents.length
  )
    throw new Error('Migration review commitment is invalid');
  for (const intent of manifest.intents) {
    for (const side of ['source', 'target'] as const) {
      const policy = side === 'source' ? intent.sourcePolicy : intent.targetPolicy;
      const expected = side === 'source' ? intent.sourcePolicyId : intent.targetPolicyId;
      const roster = side === 'source' ? manifest.sourceRoster : manifest.targetRoster;
      const id =
        intent.chain === 'bitcoin' ? B.bitcoinPolicyId(bitcoinPolicy(policy)) : H.hederaPolicyId(hederaPolicy(policy));
      if (
        id !== expected ||
        policy.context.walletId !== manifest[`${side}WalletId`] ||
        policy.context.membershipVersion !== manifest[`${side}Epoch`] ||
        policy.context.keygenId !== manifest[`${side}KeygenId`] ||
        policy.members.length !== roster.length ||
        new Set(roster.map((r) => r.id)).size !== roster.length ||
        policy.members.some((member) => !roster.some((r) => r.id === member.participantId))
      )
        throw new Error('Migration policy or participant list changed');
    }
    if (intent.chain === 'bitcoin') {
      const output = B.sharedBitcoinOutput(bitcoinPolicy(intent.targetPolicy), 0, 0);
      if (
        output.address !== intent.destination ||
        bytesToHex(output.script) !== intent.destinationScript ||
        !Array.isArray(intent.bitcoinCoins)
      )
        throw new Error('Bitcoin migration destination or coin snapshot is invalid');
    } else if (H.hederaThresholdKeyHex(hederaPolicy(intent.targetPolicy)) !== intent.targetKey)
      throw new Error('Hedera replacement key is invalid');
  }
  // Verify the public device approvals as well as the counted status. Actual
  // Raccoon and native signatures are independently checked in the worker.
  for (const side of ['source', 'target'] as const) {
    const roster = side === 'source' ? manifest.sourceRoster : manifest.targetRoster;
    const approvals = m.approvals.filter((a) => a.side === side);
    const ids = new Set<string>();
    for (const approval of approvals) {
      const member = roster.find((r) => r.id === approval.participantId);
      if (!member || ids.has(member.id)) throw new Error('Invalid migration approval participant');
      const key = await crypto.subtle.importKey(
        'spki',
        fromB64url(member.deviceKey) as Uint8Array<ArrayBuffer>,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      if (
        !(await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          key,
          fromB64url(approval.signature) as Uint8Array<ArrayBuffer>,
          new TextEncoder().encode(nativeMigrationApprovalMessage(m, side)),
        ))
      )
        throw new Error('Invalid migration approval signature');
      ids.add(member.id);
    }
    const required = side === 'source' ? manifest.requiredApprovals : manifest.requiredTargetApprovals;
    const minimum = Math.max(
      Math.floor(roster.length / 2) + 1,
      ...manifest.intents.map((i) => (side === 'source' ? i.sourcePolicy : i.targetPolicy).raccoonThreshold),
    );
    if (
      required < minimum ||
      required > roster.length ||
      (m.status !== 'draft' && m.status !== 'cancelled' && !m.reviewPending && ids.size < required)
    )
      throw new Error('Both groups must confirm the current migration review');
  }
}

/** Only real authenticated relay messages are returned. The immutable proposal
 * is supplied separately from the coordinator registry to the signing view. */
export async function migrationMessages(
  id: string,
  intentId: string,
  side: 'source' | 'target',
  session: string,
  policy: NativePolicy,
) {
  const { messages } = await (await getApi()).nativeMigrationMessages(id, intentId, side, session);
  for (const message of messages) {
    if (!['proposal', 'approve', 'r1', 'r2', 'r3', 'partial', 'final'].includes(message.kind))
      throw new Error('Unexpected migration signing message');
    const value = JSON.parse(new TextDecoder().decode(fromB64url(message.payload))) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid migration signing message');
    if (
      ['approve', 'r1', 'r2', 'r3', 'partial'].includes(message.kind) &&
      !policy.members.some((m) => m.participantId === message.from && m.partyIndex === value.from)
    )
      throw new Error('Migration signing author mismatch');
  }
  return messages;
}

export async function verifiedNativeMigrations(walletId: string) {
  const { migrations } = await (await getApi()).nativeMigrations(walletId);
  for (const view of migrations) await verifyMigration(view.migration);
  return migrations;
}
