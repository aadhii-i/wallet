/** Public native-custody migration metadata. Never contains private key material. */
export interface NativePolicyContext {
  walletId: string;
  accountId: string;
  keygenId: string;
  membershipVersion: number;
  network: 'testnet4' | 'testnet';
}
export interface NativeEnrollment extends NativePolicyContext {
  participantId: string;
  partyIndex: number;
  derivationIndex: number;
  threshold: number;
  parties: number;
  raccoonPublicKey: string;
  proof: string;
  xpub?: string;
  publicKey?: string;
}
export interface NativePolicy {
  version: 1;
  context: NativePolicyContext;
  derivationIndex: number;
  raccoonPublicKey: string;
  raccoonThreshold: number;
  nativeThreshold: number;
  members: NativeEnrollment[];
}
export interface NativeRosterMember {
  id: string;
  name: string;
  role: 'owner' | 'member';
  deviceKey: string;
}
export interface NativeMigrationCoin {
  txid: string;
  vout: number;
  value: string;
  branch: 0 | 1;
  index: number;
}
export interface NativeMigrationIntent {
  id: string;
  chain: 'bitcoin' | 'hedera';
  sourceAccountId: string;
  targetAccountId: string;
  sourcePolicyId: string;
  targetPolicyId: string;
  sourcePolicy: NativePolicy;
  targetPolicy: NativePolicy;
  bitcoinCoins: NativeMigrationCoin[] | null;
  changeCursor: number;
  destination: string;
  destinationScript: string;
  hederaAccountId: string;
  targetKey: string;
  maxFee: string;
}
export interface NativeMigrationManifest {
  version: 1;
  id: string;
  sourceWalletId: string;
  targetWalletId: string;
  sourceEpoch: number;
  targetEpoch: number;
  sourceKeygenId: string;
  targetKeygenId: string;
  sourceRoster: NativeRosterMember[];
  targetRoster: NativeRosterMember[];
  intents: NativeMigrationIntent[];
  requiredApprovals: number;
  requiredTargetApprovals: number;
}
export interface NativeMigrationAttempt {
  intentId: string;
  session: string;
  txid: string;
  maxFee: string;
  memo: string;
  sourceProposal: unknown;
  targetProposal?: unknown;
  registeredAt: string;
  registeredBy: string;
  archived?: boolean;
}
export interface NativeMigration {
  manifest: NativeMigrationManifest;
  digest: string;
  status: 'draft' | 'frozen' | 'partial' | 'complete' | 'cancelled';
  revision: number;
  approvals: { side: 'source' | 'target'; participantId: string; signature: string; at: string }[];
  attempts: NativeMigrationAttempt[];
  progress: {
    intentId: string;
    state: 'pending' | 'unknown' | 'confirmed';
    txid?: string;
    detail: string;
    checkedAt: string;
  }[];
  reviewPending: boolean;
  reviewHistory?: {
    manifest: NativeMigrationManifest;
    digest: string;
    approvals: NativeMigration['approvals'];
    at: string;
  }[];
  completedAt?: string;
  monitoringWarning?: string;
  createdAt: string;
  frozenAt?: string;
  updatedAt: string;
}
export interface NativeMigrationView {
  migration: NativeMigration;
  access: { sourceParticipantId: string; targetParticipantId: string };
  verificationRunning?: boolean;
  verificationError?: string;
}
export interface NativeAccountMapping {
  sourceAccountId: string;
  targetAccountId: string;
  bitcoinCoins: NativeMigrationCoin[];
  changeCursor: number;
  bitcoinMaxFee: string;
  hederaMaxFee: string;
}
export const nativeMigrationFields = (m: NativeMigrationManifest): unknown[] => {
  const name = (text: string) =>
    btoa(Array.from(new TextEncoder().encode(text), (n) => String.fromCharCode(n)).join(''))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const roster = (members: NativeRosterMember[]) => members.map((r) => [r.id, name(r.name), r.role, r.deviceKey]);
  return [
    'QDWallet-NativeMigrationManifest/v1',
    m.version,
    m.id,
    m.sourceWalletId,
    m.targetWalletId,
    m.sourceEpoch,
    m.targetEpoch,
    m.sourceKeygenId,
    m.targetKeygenId,
    roster(m.sourceRoster),
    roster(m.targetRoster),
    m.intents.map((i) => [
      i.id,
      i.chain,
      i.sourceAccountId,
      i.targetAccountId,
      i.sourcePolicyId,
      i.targetPolicyId,
      (i.bitcoinCoins ?? []).map((c) => [c.txid, c.vout, c.value, c.branch, c.index]),
      i.changeCursor,
      i.destination,
      i.destinationScript,
      i.hederaAccountId,
      i.targetKey,
      i.maxFee,
    ]),
    m.requiredApprovals,
    m.requiredTargetApprovals,
  ];
};
export const nativeMigrationApprovalMessage = (m: NativeMigration, side: 'source' | 'target') =>
  JSON.stringify([
    'QDWallet-NativeMigrationApproval/v1',
    side,
    m.manifest.id,
    m.digest,
    m.manifest.sourceWalletId,
    m.manifest.targetWalletId,
    m.manifest.sourceEpoch,
    m.manifest.targetEpoch,
  ]);

export interface NativeMigrationReview {
  intentId: string;
  maxFee: string;
  bitcoinCoins?: NativeMigrationCoin[];
}

export interface NativeInventoryEntry {
  chain: 'bitcoin' | 'hedera';
  accountId: string;
  policyId: string;
  policy: NativePolicy;
  hederaAccountId: string;
  boundCount: number;
}
