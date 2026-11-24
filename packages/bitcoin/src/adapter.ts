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
import { bytesToHex } from '@qd/wallet-core';
import { Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { checkBitcoinAddress } from './address';
import { FEE_TARGETS, clampFeeRate, etaSeconds } from './fees';
import { buildPsbt, describePsbt, extractSignedTx } from './psbt';
import { selectCoins } from './utxo';
import type { BitcoinDataSource, BitcoinFeeParams, BitcoinUnsignedTx, BitcoinWalletScope, BtcUtxo } from './types';
import { outpoint, validateUtxos, verifyPreviousOutput } from './validation';
import { estimateVsize } from './fees';

export interface BitcoinAdapterOptions {
  network: BitcoinNetwork;
  dataSource: BitcoinDataSource;
  /** Preferred address type for spending. Defaults to the network's default. */
  addressType?: BitcoinAddressType;
  wallet?: BitcoinWalletScope;
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
  private readonly wallet: BitcoinWalletScope | undefined;

  constructor(opts: BitcoinAdapterOptions) {
    this.network = opts.network;
    this.dataSource = opts.dataSource;
    this.addressType = opts.addressType ?? opts.network.bitcoin.defaultAddressType;
    this.now = opts.now ?? Date.now;
    this.wallet = opts.wallet;
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
    const utxos = await this.coins(address, false);
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
    if (this.wallet && this.dataSource.getWalletHistory) {
      const discovery = await this.wallet.discover();
      if (discovery.addresses[0]?.address !== address) throw new Error('Wallet account changed');
      return this.dataSource.getWalletHistory(
        discovery.addresses.map((a) => a.address),
        cursor,
      );
    }
    return this.dataSource.getHistory(address, cursor);
  }

  private async coins(from: string, spendable = true): Promise<BtcUtxo[]> {
    const addresses = this.wallet ? (await this.wallet.discover()).addresses : [{ address: from }];
    if (addresses[0]?.address !== from) throw new Error('Wallet account changed');
    const unavailable = spendable && this.wallet ? await this.wallet.unavailable() : new Set<string>();
    const coins: BtcUtxo[] = [];
    for (const entry of addresses) {
      for (const coin of await this.dataSource.getUtxos(entry.address)) {
        coins.push({
          ...coin,
          address: entry.address,
          ...('changeIndex' in entry && entry.changeIndex !== undefined ? { changeIndex: entry.changeIndex } : {}),
        });
      }
    }
    validateUtxos(coins);
    return coins.filter((c) => !unavailable.has(outpoint(c)));
  }

  async maxAmount(from: string): Promise<bigint> {
    const coins = (await this.coins(from)).filter(
      (c) => c.confirmations > 0 && (!c.coinbase || c.confirmations >= 100),
    );
    if (!coins.length || coins.length > 200) throw new Error('No supported spendable coin set');
    const rate = clampFeeRate((await this.dataSource.getFees()).aggressive);
    const total = coins.reduce((n, c) => n + c.value, 0n);
    const maximum = total - BigInt(Math.ceil(estimateVsize(coins.length, this.addressType, 1) * rate));
    return maximum > 0n ? maximum : 0n;
  }

  /** Re-read spend status; raw previous bytes alone cannot prove unspentness. */
  async revalidate(unsigned: BitcoinUnsignedTx): Promise<void> {
    for (const address of new Set(unsigned.inputs.map((i) => i.address ?? unsigned.from))) {
      const current = await this.dataSource.getUtxos(address);
      validateUtxos(current);
      for (const input of unsigned.inputs.filter((i) => (i.address ?? unsigned.from) === address)) {
        const found = current.find((u) => outpoint(u) === outpoint(input));
        if (
          !found ||
          found.value !== input.value ||
          found.scriptPubKey !== input.scriptPubKey ||
          found.confirmations < 1
        ) {
          throw new Error('Selected Bitcoin coins changed or are no longer confirmed and unspent; review again');
        }
      }
    }
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
    const [utxos, fees] = await Promise.all([this.coins(intent.from), this.dataSource.getFees()]);
    const rates: Record<FeeTier, number> = {
      low: fees.low,
      market: fees.market,
      aggressive: fees.aggressive,
    };
    const options = {} as Record<FeeTier, FeeOption & { params: BitcoinFeeParams }>;
    for (const tier of ['low', 'market', 'aggressive'] as const) {
      const feeRate = clampFeeRate(rates[tier]);
      const selection = selectCoins(
        utxos,
        intent.amount,
        feeRate,
        this.addressType,
        checkBitcoinAddress(intent.to, this.network).type,
      );
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
    const utxos = await this.coins(intent.from);
    const selection = selectCoins(
      utxos,
      intent.amount,
      fee.params.feeRate,
      this.addressType,
      checkBitcoinAddress(intent.to, this.network).type,
    );
    if (selection.fee > fee.maxFee) throw new Error('Bitcoin fee changed; request a fresh quote');
    if (!this.wallet || !this.dataSource.getRawTransaction)
      throw new Error('Recoverable change and previous transaction verification are required');
    if (!this.validateAddress(intent.to).valid) throw new Error('Invalid recipient network or address');
    const previous = new Map<string, string>();
    for (const coin of selection.inputs) {
      if (!previous.has(coin.txid)) previous.set(coin.txid, await this.dataSource.getRawTransaction(coin.txid));
      coin.previousTx = previous.get(coin.txid)!;
      verifyPreviousOutput(coin);
    }
    const change = selection.change > 0n ? await this.wallet.change() : undefined;
    return buildPsbt({
      network: this.network,
      addressType: this.addressType,
      from: intent.from,
      to: intent.to,
      changeAddress: change?.address ?? intent.from,
      ...(change ? { changeIndex: change.index } : {}),
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
      review: unsigned.review,
    };
  }

  /** Turns the worker's signed PSBT into the raw transaction Core broadcasts. */
  assembleSigned(unsigned: BitcoinUnsignedTx, sig: SignatureResult): SignedTx {
    if (sig.kind !== 'btc-psbt') throw new Error('Unexpected signature kind');
    const expected = Transaction.fromPSBT(base64.decode(unsigned.psbt)).unsignedTx;
    const returned = Transaction.fromPSBT(base64.decode(sig.psbt)).unsignedTx;
    if (bytesToHex(expected) !== bytesToHex(returned))
      throw new Error('Signed Bitcoin transaction differs from the reviewed payment');
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

  async waitForFinal(hash: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TxLookup> {
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
