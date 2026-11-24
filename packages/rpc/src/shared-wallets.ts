/**
 * Shared-wallet types and the client side of signed approvals.
 *
 * The client never signs a digest it was handed: it rebuilds the canonical
 * proposal string from the fields it displays, hashes it, and refuses to vote
 * if that differs from the server's digest. The encoding mirrors
 * services/wallet-api/internal/sharedwallet/canonical.go exactly.
 */

import type { SharedWalletKey } from './shared-keygen';
import type { AccountKeyInfo, ExecutionInfo, ProposalLifecycle, SigningSessionStatus, SigningSessionSummary } from './shared-signing';

export type ParticipantStatus = 'active' | 'suspended' | 'revoked';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded';
export type VoteDecision = 'approve' | 'reject';

export interface SharedPolicy {
  version: number;
  numerator: number;
  denominator: number;
  rounding: 'ceil';
  membershipVersion: number;
  activeParticipants: number;
  requiredApprovals: number;
  maxParticipants: number;
}

export interface SharedParticipant {
  id: string;
  displayName: string;
  role: 'owner' | 'member';
  status: ParticipantStatus;
  joinedAt: string;
  revokedAt?: string;
}

export interface SharedAccount {
  id: string;
  name: string;
  derivationIndex: number;
  /**
   * The QdAccount (smart account) address, derived from the account's Raccoon
   * public key pk_j once a participant's device registered it; null before.
   */
  address: string | null;
  key?: AccountKeyInfo;
  createdAt: string;
}

export interface SharedInvitation {
  id: string;
  label: string;
  status: 'invited' | 'accepted' | 'rejected' | 'revoked';
  expiresAt: string;
  createdAt: string;
}

export interface SharedWallet {
  id: string;
  name: string;
  createdAt: string;
  keyStatus: 'none' | 'rekey_required' | 'active';
  /** Threshold Raccoon key state; `initialized` only after every participant acknowledged its share. */
  key: SharedWalletKey;
  policy: SharedPolicy;
  me: SharedParticipant;
  participants: SharedParticipant[];
  accounts: SharedAccount[];
  /** Present for the owner only. */
  invitations?: SharedInvitation[];
}

export interface Proposal {
  id: string;
  walletId: string;
  accountId: string;
  derivationIndex: number;
  initiatorParticipantId: string;
  /** The sender QdAccount address, once its key is registered. */
  senderAddress: string | null;
  chainId: number;
  to: string;
  valueWei: string;
  data: string;
  nonce: number;
  gasLimit: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  policy: { version: number; numerator: number; denominator: number; rounding: string };
  membershipVersion: number;
  participantCount: number;
  requiredApprovals: number;
  eligibleParticipantIds: string[];
  digest: string;
  status: ProposalStatus;
  approvals: number;
  rejections: number;
  remainingApprovals: number;
  votes: { participantId: string; decision: VoteDecision; createdAt: string }[];
  myVote?: VoteDecision;
  /** One honest status from approval to chain (see ProposalLifecycle). */
  lifecycle: ProposalLifecycle;
  /**
   * Present once the approval threshold is reached. `status` is
   * `awaiting_key_generation` (no matching key), `awaiting_account_key`,
   * `ready` (no session yet) or the latest signing session's status.
   */
  signing?: {
    status: 'awaiting_key_generation' | 'awaiting_account_key' | 'ready' | SigningSessionStatus;
    signers: string[];
    signerPartyIndexes?: number[];
    session?: SigningSessionSummary;
    createdAt: string;
  };
  execution: ExecutionInfo | { status: 'not_started' };
  expiresAt: string;
  createdAt: string;
}

export interface CreateProposalInput {
  accountId: string;
  chainId: number;
  to: string;
  valueWei: string;
  data?: string;
  nonce: number;
  gasLimit: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  ttlSeconds?: number;
}

export class VoteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoteRefusedError';
  }
}

function unixSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms % 1000 !== 0) throw new VoteRefusedError('Malformed expiry');
  return ms / 1000;
}

/** The exact string whose SHA-256 is the proposal digest (canonical.go). */
export function proposalCanonicalString(p: Proposal): string {
  const ids = [...p.eligibleParticipantIds].sort();
  return [
    'QDWallet-Proposal', 'v1',
    p.id, p.walletId, p.accountId,
    String(p.derivationIndex),
    p.initiatorParticipantId,
    String(p.chainId),
    p.to, p.valueWei, p.data,
    String(p.nonce),
    String(p.gasLimit),
    p.maxFeePerGas, p.maxPriorityFeePerGas,
    String(p.policy.version), String(p.policy.numerator), String(p.policy.denominator), p.policy.rounding,
    String(p.membershipVersion),
    String(p.participantCount),
    String(p.requiredApprovals),
    ids.join(','),
    String(unixSeconds(p.expiresAt)),
  ].join('|');
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export async function proposalDigest(p: Proposal): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proposalCanonicalString(p)));
  return hex(new Uint8Array(d));
}

const SAFE_FIELD = /^[A-Za-z0-9_\-:.,x]*$/;

/**
 * Verifies the proposal locally and returns the vote message to sign.
 * Throws VoteRefusedError if the digest does not match what is displayed,
 * the snapshot is internally inconsistent, or a field could alter the encoding.
 */
export async function prepareVoteMessage(
  p: Proposal,
  decision: VoteDecision,
  participantId: string,
  nonce: string,
  issuedAt: number,
): Promise<string> {
  if (decision !== 'approve' && decision !== 'reject') throw new VoteRefusedError('Unknown decision');
  const fields = [p.id, p.walletId, p.accountId, p.initiatorParticipantId, p.to, p.valueWei, p.data, p.maxFeePerGas, p.maxPriorityFeePerGas, participantId, nonce, ...p.eligibleParticipantIds];
  if (!fields.every((f) => typeof f === 'string' && SAFE_FIELD.test(f))) throw new VoteRefusedError('Proposal contains unexpected characters');
  if (!/^0x[0-9a-f]{40}$/.test(p.to) || !/^0x([0-9a-f]{2})*$/.test(p.data)) throw new VoteRefusedError('Malformed recipient or data');
  if (!p.eligibleParticipantIds.includes(participantId)) throw new VoteRefusedError('You are not in this proposal’s participant snapshot');
  const expected = Math.ceil((p.participantCount * p.policy.numerator) / p.policy.denominator);
  if (p.policy.rounding !== 'ceil' || p.requiredApprovals !== expected || p.eligibleParticipantIds.length !== p.participantCount) {
    throw new VoteRefusedError('Proposal policy snapshot is inconsistent');
  }
  if ((await proposalDigest(p)) !== p.digest) throw new VoteRefusedError('Proposal digest does not match its contents');
  return [
    'QDWallet-Vote', 'v1', decision, p.id, p.walletId, p.digest,
    String(p.policy.version), String(p.membershipVersion), participantId, nonce, String(issuedAt),
  ].join('|');
}
