/**
 * Wire types for the wallet-api (docs/api/openapi.yaml). Hand-maintained until the
 * OpenAPI codegen step lands (Makefile `gen`); keep field names identical to the spec.
 */

export type ChainFamily = 'evm' | 'bitcoin' | 'monero' | 'hedera';
/**
 * `unknown` is only ever produced by the backend, for a chain id supplied by
 * configuration that has no entry in its known-network table. The client
 * registry never declares it.
 */
export type NetworkKind = 'mainnet' | 'testnet' | 'local' | 'unknown';
export type SigningMode = 'hd' | 'mpc' | 'qd';
export type Platform = 'web' | 'ios' | 'android';
export type TxStatus = 'pending' | 'confirmed' | 'failed' | 'replaced' | 'dropped';

/** Decimal string of base units (wei). Never a JS number. */
export type BaseUnits = string;

export interface Problem {
  type?: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
}

export interface Challenge {
  challengeId: string;
  nonce: string;
  message: string;
  expiresAt: string;
}

export interface Session {
  userId: string;
  deviceId: string;
  accessExpiresAt: string;
  csrfToken?: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface Device {
  id: string;
  platform: Platform;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
  current: boolean;
}

export interface ApiAddress {
  id: string;
  networkFamily: 'evm' | 'bitcoin' | 'hedera';
  address: string;
  /** Bitcoin only: which derivation/address scheme the address belongs to. */
  addressType?: 'p2wpkh' | 'p2tr';
  /** Hedera only: the shard.realm.num account identifier. */
  hederaAccountId?: string;
}

export interface ApiAccount {
  id: string;
  walletId: string;
  hdIndex?: number;
  name: string;
  signingMode: SigningMode;
  hidden: boolean;
  addresses: ApiAddress[];
}

export interface ApiWallet {
  id: string;
  label: string;
  defaultSigningMode: SigningMode;
  accounts: ApiAccount[];
  createdAt: string;
}

export interface ApiNetwork {
  id: string;
  family: ChainFamily;
  chainId?: number;
  name: string;
  kind: NetworkKind;
  nativeSymbol: string;
  nativeDecimals: number;
}

export interface ApiTransaction {
  id: string;
  networkId: string;
  hash: string;
  from: string;
  to: string;
  assetId: string;
  amount: BaseUnits;
  fee?: BaseUnits;
  nonce?: number;
  status: TxStatus;
  blockNumber?: number;
  createdAt: string;
  events?: { fromStatus?: string; toStatus: string; observedAt: string }[];
}

export interface ActivityItem {
  hash: string;
  networkId: string;
  direction: 'in' | 'out' | 'self';
  from: string;
  to: string;
  assetId: string;
  amount: BaseUnits;
  fee?: BaseUnits;
  status: TxStatus;
  blockNumber?: number;
  timestamp: string;
  flags: 'suspected_poisoning'[];
}

export interface SecurityEvent {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  deviceId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export type ClientSecurityEventType =
  | 'phrase_revealed'
  | 'unlock_failed_burst'
  | 'wallet_created'
  | 'wallet_imported'
  | 'wallet_wiped'
  | 'backup_verified';

export interface PricesResponse {
  prices: Record<string, { usd: string }>;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Bitcoin (`/v1/btc/*`, docs/api/openapi.yaml)
// ---------------------------------------------------------------------------

/** Bitcoin chain name as used in API paths and derivation paths. */
export type BitcoinNetworkName = 'mainnet' | 'testnet4';
export type BitcoinAddressType = 'p2wpkh' | 'p2tr';

/** One spendable output from the Esplora blockchain index. */
export interface ApiBtcUtxo {
  txid: string;
  vout: number;
  /** Sats, decimal string (never a JS number). */
  value: BaseUnits;
  /** Previous output scriptPubKey, hex. */
  scriptPubKey: string;
  confirmations: number;
  blockHeight?: number;
}

/** `estimatesmartfee` results in sat/vB, already clamped server-side. */
export interface ApiBtcFees {
  low: number;
  market: number;
  aggressive: number;
  tipHeight: number;
  /** ISO-8601. */
  quotedAt: string;
}

export interface ApiBtcTransaction {
  txid: string;
  status: TxStatus;
  confirmations: number;
  blockHeight?: number;
  /** ISO-8601, when the block is known. */
  blockTime?: string;
  fee?: BaseUnits;
  /** Sum of outputs, sats. */
  value: BaseUnits;
  inputs: { address?: string; value: BaseUnits }[];
  outputs: { address?: string; value: BaseUnits }[];
}

export interface ApiBtcBroadcastResult {
  txid: string;
}

// ---------------------------------------------------------------------------
// Hedera (`/v1/hedera/*`)
// ---------------------------------------------------------------------------

export interface ApiHederaBalance {
  accountId: string;
  tinybars: number;
  hbar: string;
}

/**
 * A single activity entry from a Mirror Node CRYPTOTRANSFER transaction,
 * classified relative to the queried account. Mirrors the Go `HederaActivityItem`;
 * int64 amounts become JS numbers (tinybars fit losslessly in 2^53).
 */
export interface ApiHederaActivityItem {
  transactionId: string;
  timestamp: string;
  type: string;
  direction: 'in' | 'out' | 'self';
  from: string;
  to: string;
  /** 1 HBAR = 100,000,000 tinybars. */
  amountTinybars: number;
  /** Pre-formatted display string (truncated, never rounded), e.g. "1.00000000 HBAR". */
  hbar: string;
  feeTinybars: number;
  status: 'confirmed' | 'failed';
  networkId: string;
}

/** One page of Hedera activity; `nextCursor` is passed back as `?cursor=`. */
export interface ApiHederaHistoryPage {
  items: ApiHederaActivityItem[];
  nextCursor?: string;
}
