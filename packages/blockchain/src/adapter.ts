import type { ActivityItem, ChainFamily, TxStatus } from '@qd/shared-types';
import type { Asset } from './assets';
import type { Network } from './networks';

export interface AddressValidation {
  valid: boolean;
  /** Canonical display form (e.g. EIP-55 checksummed). */
  normalized?: string;
  reason?: 'format' | 'checksum' | 'network';
}

export interface TransferIntent {
  from: string;
  to: string;
  asset: Asset;
  /** Base units. */
  amount: bigint;
}

export type FeeTier = 'low' | 'market' | 'aggressive';

export interface FeeOption {
  tier: FeeTier;
  /** Worst-case fee in native base units (what the user may pay at most). */
  maxFee: bigint;
  /** Likely fee in native base units, shown as the headline number. */
  estimatedFee: bigint;
  /** Rough time estimate for the UI. */
  etaSeconds: number;
}

export interface FeeQuote<TParams = unknown> {
  options: Record<FeeTier, FeeOption & { params: TParams }>;
  /** Unix ms. Quotes older than 30 s are re-estimated before review (spec §16.1). */
  quotedAt: number;
}

/** Everything the Review screen renders, derived from the unsigned payload itself. */
export interface ReviewSummary {
  networkId: string;
  from: string;
  to: string;
  asset: Asset;
  amount: bigint;
  maxFee: bigint;
  nonce?: number;
}

export interface SignedTx {
  networkId: string;
  raw: `0x${string}`;
  hash: `0x${string}`;
}

export interface TxLookup {
  hash: string;
  status: TxStatus;
  blockNumber?: bigint;
  fee?: bigint;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * Chain-family-agnostic adapter (spec §11.2). Everything chain-specific lives in
 * the implementing package; UI and transaction code depend only on this interface.
 */
export interface BlockchainAdapter<TUnsigned = unknown, TFeeParams = unknown> {
  readonly family: ChainFamily;
  readonly network: Network;
  validateAddress(input: string): AddressValidation;
  getBalance(address: string): Promise<bigint>;
  getTokenBalance(address: string, asset: Asset): Promise<bigint>;
  getTransaction(hash: string): Promise<TxLookup | null>;
  getTransactionHistory(address: string, cursor?: string): Promise<Page<ActivityItem>>;
  estimateFee(intent: TransferIntent): Promise<FeeQuote<TFeeParams>>;
  buildTransaction(intent: TransferIntent, fee: FeeOption & { params: TFeeParams }): Promise<TUnsigned>;
  describe(unsigned: TUnsigned): ReviewSummary;
  broadcastTransaction(signed: SignedTx): Promise<string>;
  waitForFinal(hash: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<TxLookup>;
}
