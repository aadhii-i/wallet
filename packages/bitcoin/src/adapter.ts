import type { ActivityItem } from '@qd/shared-types';
import {
  WalletError,
  assetsForNetwork,
  type AddressValidation,
  type Asset,
  type BitcoinAddressType,
  type BitcoinNetwork,
  type BlockchainAdapter,
  type FeeOption,
  type FeeQuote,
  type FeeTier,
  type Page,
  type ReviewSummary,
  type SignedTx,
  type TransferIntent,
  type TxLookup,
} from '@qd/blockchain';
import type { SignatureResult, SigningPayload } from '@qd/wallet-core';
import { checkBitcoinAddress } from './address';
import { FEE_TARGETS, clampFeeRate, etaSeconds } from './fees';
import { buildPsbt, describePsbt, extractSignedTx } from './psbt';
import { selectCoins } from './utxo';
import type { BitcoinDataSource, BitcoinFeeParams, BitcoinUnsignedTx } from './types';

export interface BitcoinAdapterOptions {
  network: BitcoinNetwork;
  dataSource: BitcoinDataSource;
  /** Preferred address type for spending. Defaults to the network's default. */
  addressType?: BitcoinAddressType;
  /** Test hook. */
  now?: () => number;
}

const POLL_MS = 15_000;

export class BitcoinAdapter implements BlockchainAdapter<BitcoinUnsignedTx, BitcoinFeeParams> {
  readonly family = 'bitcoin' as const;
  readonly network: BitcoinNetwork;
  private readonly dataSource: BitcoinDataSource;
  private readonly addressType: BitcoinAddressType;
  private readonly now: () => number;

  constructor(opts: BitcoinAdapterOptions) {
    this.network = opts.network;
    this.dataSource = opts.dataSource;
    this.addressType = opts.addressType ?? opts.network.bitcoin.defaultAddressType;
    this.now = opts.now ?? Date.now;
  }

  listAssets(): readonly Asset[] {
    return assetsForNetwork(this.network);
  }

  validateAddress(input: string): AddressValidation {
    const check = checkBitcoinAddress(input, this.network);
    if (check.valid && check.normalized) {
      return { valid: true, normalized: check.normalized };
    }
    return {
      valid: false,
      ...(check.normalized ? { normalized: check.normalized } : {}),
      reason: check.reason ?? 'format',
    };
  }

  async getBalance(address: string): Promise<bigint> {
    const utxos = await this.dataSource.getUtxos(address);
    return utxos.reduce((acc, u) => acc + u.value, 0n);
  }

  async getTokenBalance(_address: string, asset: Asset): Promise<bigint> {
    // Bitcoin has no tokens in this iteration.
    if (asset.kind !== 'native') return 0n;
    return this.getBalance(_address);
  }

  async getAllBalances(address: string): Promise<Map<string, bigint | null>> {
    const asset = this.listAssets()[0]!;
    return new Map([[asset.id, await this.getBalance(address)]]);
  }

  async getChainStatus(): Promise<{ blockNumber: bigint; chainId?: number }> {
    return { blockNumber: await this.dataSource.getTipHeight() };
  }

  async getTransaction(hash: string): Promise<TxLookup | null> {
    return this.dataSource.getTransaction(strip0x(hash));
  }

  async getTransactionHistory(address: string, cursor?: string): Promise<Page<ActivityItem>> {
    return this.dataSource.getHistory(address, cursor);
  }

  async estimateFee(intent: TransferIntent): Promise<FeeQuote<BitcoinFeeParams>> {
    if (intent.asset.kind !== 'native') {
      throw new WalletError({
        code: 'UNSUPPORTED',
        userTitle: 'Unsupported asset',
        userMessage: 'Only native BTC transfers are supported.',
        fundsMoved: 'no',
        retryable: false,
      });
    }
    const [utxos, fees] = await Promise.all([
      this.dataSource.getUtxos(intent.from),
      this.dataSource.getFees(),
    ]);
    const rates: Record<FeeTier, number> = {
      low: fees.low,
      market: fees.market,
      aggressive: fees.aggressive,
    };
    const options = {} as Record<FeeTier, FeeOption & { params: BitcoinFeeParams }>;
    for (const tier of ['low', 'market', 'aggressive'] as const) {
      const feeRate = clampFeeRate(rates[tier]);
      const selection = selectCoins(utxos, intent.amount, feeRate, this.addressType);
      options[tier] = {
        tier,
        maxFee: selection.fee,
        estimatedFee: selection.fee,
        etaSeconds: etaSeconds(FEE_TARGETS[tier]),
        params: { feeRate, targetBlocks: FEE_TARGETS[tier], vsize: selection.vsize },
      };
    }
    return { options, quotedAt: this.now() };
  }

  async buildTransaction(
    intent: TransferIntent,
    fee: FeeOption & { params: BitcoinFeeParams },
  ): Promise<BitcoinUnsignedTx> {
    const utxos = await this.dataSource.getUtxos(intent.from);
    const selection = selectCoins(utxos, intent.amount, fee.params.feeRate, this.addressType);
    return buildPsbt({
      network: this.network,
      addressType: this.addressType,
      from: intent.from,
      to: intent.to,
      // Change reuse is a documented privacy follow-up, not a fund risk.
      changeAddress: intent.from,
      amount: intent.amount,
      selection,
    });
  }

  describe(unsigned: BitcoinUnsignedTx): ReviewSummary {
    return describePsbt(unsigned, this.network);
  }

  /**
   * The bytes the KeyWorker is asked to sign. The confirmation token is bound
   * to exactly these bytes, so the payload is the PSBT itself (threat T7).
   */
  signingPayload(unsigned: BitcoinUnsignedTx): SigningPayload {
    return {
      kind: 'btc-psbt',
      network: this.network.bitcoin.chain,
      from: unsigned.from,
      addressType: unsigned.addressType,
      psbt: unsigned.psbt,
    };
  }

  /** Turns the worker's signed PSBT into the raw transaction Core broadcasts. */
  assembleSigned(unsigned: BitcoinUnsignedTx, sig: SignatureResult): SignedTx {
    if (sig.kind !== 'btc-psbt') throw new Error('Unexpected signature kind');
    const { rawHex, txid } = extractSignedTx(sig.psbt);
    return { networkId: unsigned.networkId, raw: `0x${rawHex}`, hash: `0x${txid}` };
  }

  async broadcastTransaction(signed: SignedTx): Promise<string> {
    const rawHex = strip0x(signed.raw);
    const expected = strip0x(signed.hash).toLowerCase();
    const txid = await this.dataSource.broadcast(rawHex);
    if (txid.toLowerCase() !== expected) {
      throw new WalletError({
        code: 'BROADCAST_UNKNOWN',
        userTitle: 'Broadcast mismatch',
        userMessage: 'The network returned a different transaction id than the one we signed.',
        fundsMoved: 'unknown',
        retryable: true,
        technical: `expected ${expected} got ${txid}`,
      });
    }
    return txid;
  }

  async waitForFinal(
    hash: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<TxLookup> {
    const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (opts.signal?.aborted) throw new Error('Aborted');
      const tx = await this.dataSource.getTransaction(strip0x(hash));
      if (tx && tx.status === 'confirmed') return tx;
      if (tx && (tx.status === 'failed' || tx.status === 'dropped' || tx.status === 'replaced')) return tx;
      if (Date.now() >= deadline) {
        throw new WalletError({
          code: 'NETWORK_UNAVAILABLE',
          userTitle: 'Still confirming',
          userMessage: 'The transaction has not confirmed yet. It is safe to close this screen.',
          fundsMoved: 'yes',
          retryable: true,
        });
      }
      await sleep(POLL_MS, opts.signal);
    }
  }
}

function strip0x(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
