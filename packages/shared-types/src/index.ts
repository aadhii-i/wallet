/**
 * Wire types for the wallet-api (docs/api/openapi.yaml). Hand-maintained until the
 * OpenAPI codegen step lands (Makefile `gen`); keep field names identical to the spec.
 */

export type ChainFamily = 'evm' | 'monero';
export type NetworkKind = 'mainnet' | 'testnet' | 'local';
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
  networkFamily: 'evm';
  address: string;
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
