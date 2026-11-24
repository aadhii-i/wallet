import type { ActivityItem } from '@qd/shared-types';
import type { BitcoinReview } from '@qd/wallet-core';
import type { BitcoinAddressType, BitcoinChain, Page, TxLookup } from '@qd/blockchain';

/** A spendable output, as reported by the Esplora blockchain index. */
export interface BtcUtxo {
  txid: string;
  vout: number;
  value: bigint;
  /** Previous output script, hex. Required to build the PSBT. */
  scriptPubKey: string;
  confirmations: number;
  blockHeight?: number;
  /** Raw previous transaction, verified against txid and the referenced output. */
  previousTx?: string;
  coinbase?: boolean;
  /** Set by local discovery, never accepted as an arbitrary signing path. */
  address?: string;
  changeIndex?: number;
}

export interface BitcoinWalletScope {
  discover(): Promise<{ addresses: { address: string; changeIndex?: number }[]; highestUsed: number }>;
  change(): Promise<{ address: string; index: number }>;
  unavailable(): Promise<Set<string>>;
}

/** Fee estimates from `estimatesmartfee`, in sat/vB. */
export interface BtcFeeEstimates {
  low: number;
  market: number;
  aggressive: number;
  tipHeight: number;
  /** Unix ms. */
  quotedAt: number;
}

/**
 * Everything `BitcoinAdapter` needs from the network. Implemented by the web
 * client against wallet-api; tests use a stub. No key material ever crosses it.
 */
export interface BitcoinDataSource {
  readonly chain: BitcoinChain;
  getTipHeight(): Promise<bigint>;
  getUtxos(address: string): Promise<BtcUtxo[]>;
  getRawTransaction?(txid: string): Promise<string>;
  isAddressUsed?(address: string): Promise<boolean>;
  getFees(): Promise<BtcFeeEstimates>;
  getTransaction(hash: string): Promise<TxLookup | null>;
  getHistory(address: string, cursor?: string): Promise<Page<ActivityItem>>;
  getWalletHistory?(addresses: readonly string[], cursor?: string): Promise<Page<ActivityItem>>;
  broadcast(rawHex: string): Promise<string>;
}

/** Fee parameters carried in `FeeQuote.options[tier].params`. */
export interface BitcoinFeeParams {
  /** sat/vB. */
  feeRate: number;
  /** Target confirmation blocks. */
  targetBlocks: number;
  /** Virtual size used for the quote. */
  vsize: number;
}

/** Unsigned Bitcoin transaction: a PSBT plus what the review screen needs. */
export interface BitcoinUnsignedTx {
  networkId: string;
  addressType: BitcoinAddressType;
  /** Base64 PSBT, signed by the KeyWorker. */
  psbt: string;
  from: string;
  to: string;
  amount: bigint;
  fee: bigint;
  change: bigint;
  inputCount: number;
  vsize: number;
  /** x-only internal key, hex. Only for `p2tr`. */
  tapInternalKey?: string;
  inputs: readonly BtcUtxo[];
  changeAddress: string;
  review: BitcoinReview;
}
