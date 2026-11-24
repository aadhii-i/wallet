/**
 * Client side of networked Threshold Raccoon signing. Only public protocol
 * data passes through here: account public keys, round messages (which the
 * key worker produces from its share), transcript hashes, the combined
 * signature and execution status. Message formats mirror
 * services/wallet-api/internal/sharedwallet/signing.go.
 */
import { sha256Hex } from './shared-keygen';

export type SigningSessionStatus = 'round1' | 'round2' | 'round3' | 'combining' | 'complete' | 'failed';
export type SigningFailReason =
  | 'expired' | 'cancelled' | 'membership_changed' | 'invalid_commitment' | 'invalid_signature' | 'participant_abort'
  | 'signer_state_lost';
export type SigningAbortReason = 'cancelled' | 'participant_abort' | 'signer_state_lost';

/**
 * awaiting_approvals → (threshold reached) awaiting_key_generation | awaiting_account_key
 * → awaiting_signers → signing → signature_verified → submitting → submitted → confirmed;
 * or signing_failed / execution_failed / rejected / expired / superseded.
 */
export type ProposalLifecycle =
  | 'awaiting_approvals' | 'threshold_reached' | 'awaiting_key_generation' | 'awaiting_account_key' | 'awaiting_signers'
  | 'signing' | 'signing_failed' | 'signature_verified'
  // Relayer stages between a verified signature and submission:
  | 'checking_relayer' | 'relayer_unavailable' | 'insufficient_account_funds' | 'insufficient_relayer_funds'
  | 'setting_up_verifier' | 'preparing_account' | 'waiting_nonce'
  | 'submitting' | 'submitted' | 'confirmed' | 'execution_failed'
  | 'rejected' | 'expired' | 'superseded';

/** What the relayer is doing or waiting for (ExecutionInfo.stage). */
export type ExecutionStage =
  | 'queued' | 'checking_relayer' | 'relayer_unavailable' | 'insufficient_account_funds' | 'insufficient_relayer_funds'
  | 'setting_up_verifier' | 'preparing_account' | 'waiting_nonce' | 'submitting' | 'submitted' | 'confirmed' | 'failed' | 'expired';

export interface AccountKeyInfo {
  keyGenerationId: string;
  derivationIndex: number;
  publicKeyHash: string; // 0x keccak256("QD-VK-v1" ‖ pk)
  address: string;
  attestations: { participantId: string; at: string }[];
  createdAt: string;
  publicKey?: string; // base64url, only from the account-key endpoint
}

export interface SigningSessionSummary {
  id: string;
  proposalId: string;
  attempt: number;
  status: SigningSessionStatus;
  round: number;
  failureReason: string;
  failedBy?: string;
  keyGenerationId: string;
  threshold: number;
  parties: number;
  membershipVersion: number;
  derivationIndex: number;
  chainId: number;
  signerPartyIndexes: number[];
  signerParticipantIds: string[];
  sid: string; // hex
  message: string; // 0x execution message
  accountAddress: string;
  publicKeyHash: string;
  progress: Record<'1' | '2' | '3', number[]>;
  createdAt: string;
  expiresAt: string;
  endedAt?: string;
  signatureSha256?: string;
  signatureVerified?: boolean;
}

export interface SigningMessageInfo {
  round: number;
  partyIndex: number;
  participantId: string;
  payloadSha256: string;
  payload?: string; // base64url
  createdAt: string;
}

export interface ExecutionInfo {
  status: 'pending' | 'submitting' | 'submitted' | 'confirmed' | 'failed';
  chainId: number;
  accountAddress: string;
  lastError: string;
  relayer: string;
  txHash: string;
  blockNumber?: number;
  gasUsed?: number;
  callSuccess?: boolean;
  submittedAt?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
  stage: ExecutionStage;
  /** One-time setup transactions mined successfully, in order. */
  setupTxs: string[];
  setupAttempts: number;
  pendingSetupTx?: string;
  nextAttemptAt?: string;
  /** From the chain, once the execute transaction is known/mined. */
  txNonce?: number;
  effectiveGasPrice?: string; // wei, decimal
  blockTime?: string;
  executedTo?: string;
  executedValue?: string; // wei, decimal
}

/** GET /v1/relayers: relayer diagnostics per chain (no key material). */
export interface RelayerChainStatus {
  chainId: number;
  rpcConfigured: boolean;
  rpcOk: boolean;
  rpcChainId?: number;
  relayerConfigured: boolean;
  relayerAddress?: string;
  relayerBalanceWei?: string;
  deployerPresent?: boolean;
  verifierAddress: string;
  verifierDeployed?: boolean;
  factoryAddress: string;
  factoryDeployed?: boolean;
  ready: boolean;
  problems: string[];
  // Gas Service Account funding view (present when the RPC and relayer key work).
  blockNumber?: number;
  baseFeeWei?: string;
  tipWei?: string;
  /** Base fee + tip: what a transaction pays per gas now. */
  gasPriceWei?: string;
  /** Fee cap the relayer signs with (3 × base fee + tip). */
  feeCapWei?: string;
  /** Upper-bound cost of one execution once the wallet key is set up on chain. */
  executionCostWei?: string;
  /** Upper-bound cost of setting up one new wallet key on this chain and executing once. */
  newWalletCostWei?: string;
  pendingOperations?: number;
  pendingRequiredWei?: string;
  lowBalanceWei?: string;
  lowBalanceConfigured?: boolean;
  shortfallWei?: string;
  executionsCovered?: number;
  health?: GasHealth;
  healthMessage?: string;
  checkedAt?: string;
  scannedThroughBlock?: number;
  historyAvailableSinceBlock?: number;
}

export type GasHealth = 'healthy' | 'low' | 'insufficient' | 'unknown';

/** What executing one proposal requires right now (the relayer's own preflight; read-only). */
export interface GasEstimate {
  chainId: number;
  checkedAt: string;
  rpcOk: boolean;
  relayerConfigured: boolean;
  relayerAddress?: string;
  /** null: unavailable (not zero). */
  relayerBalanceWei: string | null;
  accountAddress: string;
  accountDeployed: boolean | null;
  accountBalanceWei: string | null;
  transferWei: string;
  setupSteps: string[];
  gasUnits: number;
  baseFeeWei?: string;
  gasPriceWei?: string;
  feeCapWei?: string;
  requiredRelayerWei?: string;
  estimatedFeeWei?: string;
  /** Additional L1-data and operator fee reserve, already included in totals. */
  additionalFeeReserveWei?: string;
  relayerShortfallWei?: string;
  accountShortfallWei?: string;
  canProceed: boolean;
  blocker?: string;
}

export type GasTransferKind = 'recharge' | 'recharge_internal' | 'setup' | 'execute' | 'other';

export interface GasTransfer {
  /** "internal:<block>" for a recharge without a direct transaction. */
  txHash: string;
  direction: 'in' | 'out';
  kind: GasTransferKind;
  counterparty: string;
  valueWei: string;
  gasUsed: number;
  gasPriceWei: string;
  feeWei: string;
  success: boolean;
  blockNumber: number;
  blockTime: string;
  proposalId?: string;
}

export interface GasHistory {
  chainId: number;
  address: string;
  transfers: GasTransfer[];
  scannedThroughBlock?: number | null;
  historyAvailableSinceBlock?: number | null;
}

export interface SigningSession extends SigningSessionSummary {
  header: string;
  transcriptHash?: string;
  messages: SigningMessageInfo[];
  signature?: string; // base64url, once complete
  execution?: ExecutionInfo;
}

export class SigningRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningRefusedError';
  }
}

export function accountKeyMessage(walletId: string, accountId: string, derivationIndex: number, keygenId: string, publicKeyHash: string, address: string): string {
  return ['QDWallet-AccountKey', 'v1', walletId, accountId, derivationIndex, keygenId, publicKeyHash.replace(/^0x/, ''), address.toLowerCase()].join('|');
}

/** The header the coordinator must have frozen for this session (SessionHeader in Go). */
export function sessionHeader(s: SigningSessionSummary, walletId: string, proposalDigest: string): string {
  return [
    'QDWallet-SignSession', 'v1', s.id, walletId, s.proposalId, proposalDigest, s.keyGenerationId, s.membershipVersion,
    s.threshold, s.parties, s.signerPartyIndexes.join(','), s.signerParticipantIds.join(','), s.derivationIndex, s.chainId,
    s.accountAddress, s.publicKeyHash.replace(/^0x/, ''), s.message.replace(/^0x/, ''), s.sid,
    Math.floor(Date.parse(s.expiresAt) / 1000),
  ].join('|');
}

/** Hash a round-`round` message commits to: header + every earlier message. */
export async function transcriptHash(header: string, messages: { round: number; partyIndex: number; payloadSha256: string }[], round: number): Promise<string> {
  const lines = messages
    .filter((m) => m.round < round)
    .sort((a, b) => a.round - b.round || a.partyIndex - b.partyIndex)
    .map((m) => `${m.round}:${m.partyIndex}:${m.payloadSha256}`);
  const headerHash = await sha256Hex(new TextEncoder().encode(header));
  return sha256Hex(new TextEncoder().encode(`QDWallet-SignTranscript|v1|${headerHash}|${lines.join(';')}`));
}

export async function signRoundMessage(sessionId: string, round: number, partyIndex: number, participantId: string, transcript: string, payload: Uint8Array): Promise<string> {
  return ['QDWallet-SignRound', 'v1', sessionId, round, partyIndex, participantId, transcript, await sha256Hex(payload)].join('|');
}

export function signAbortMessage(sessionId: string, participantId: string, reason: SigningAbortReason): string {
  return ['QDWallet-SignAbort', 'v1', sessionId, participantId, reason].join('|');
}

/**
 * What this device expects a session to be, computed from data it checked
 * itself: the proposal it approved, its own account key, and the execution
 * message it recomputed. A session that differs is refused before round 1.
 */
export interface SessionExpectation {
  walletId: string;
  proposalId: string;
  proposalDigest: string;
  chainId: number;
  derivationIndex: number;
  accountAddress: string;
  publicKeyHash: string;
  message: string;
  signerPartyIndexes: number[];
  keyGenerationId: string;
}

export function checkSession(s: SigningSession, exp: SessionExpectation): void {
  const same = (a: string, b: string) => a.toLowerCase().replace(/^0x/, '') === b.toLowerCase().replace(/^0x/, '');
  const ok =
    s.proposalId === exp.proposalId &&
    s.chainId === exp.chainId &&
    s.derivationIndex === exp.derivationIndex &&
    s.keyGenerationId === exp.keyGenerationId &&
    same(s.accountAddress, exp.accountAddress) &&
    same(s.publicKeyHash, exp.publicKeyHash) &&
    same(s.message, exp.message) &&
    s.signerPartyIndexes.join(',') === exp.signerPartyIndexes.join(',') &&
    /^[0-9a-f]{64}$/.test(s.sid) &&
    s.header === sessionHeader(s, exp.walletId, exp.proposalDigest);
  if (!ok) throw new SigningRefusedError('The signing session does not match the approved transaction on this device');
}

/** One indexed transfer of a shared wallet's smart account (from chain receipts). */
export interface WalletHistoryItem {
  /** "internal:<block>:<address>" for value that arrived without a decodable transaction. */
  txHash: string;
  /** -1: the transaction's own value; -2: internal; >= 0: the Executed / ERC-20 log. */
  logIndex: number;
  kind: 'native' | 'qd_execute' | 'erc20' | 'internal';
  direction: 'sent' | 'received' | 'self';
  from: string;
  to: string;
  /** "" for the native coin, else the token contract. */
  token: string;
  amount: string;
  success: boolean;
  txFrom: string;
  txTo: string;
  blockNumber: number;
  blockTime: string;
  gasUsed: number;
  gasPriceWei: string;
  feeWei: string;
  status: 'confirmed' | 'failed';
  /** Block explorer page of the transaction (absent for local chains and internal transfers). */
  explorerUrl?: string;
  proposalId?: string;
}

export type WalletHistoryIndexState = 'ok' | 'indexing' | 'rpc_unavailable' | 'rpc_error' | 'disabled';

export interface WalletHistory {
  chainId: number;
  network: string;
  addresses: string[];
  items: WalletHistoryItem[];
  coverage: Record<string, { sinceBlock: number; scannedThroughBlock: number }>;
  /** Whether the chain could be read for this request; stored history is returned either way. */
  index: { state: WalletHistoryIndexState; error?: string };
}
