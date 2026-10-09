import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Hex,
  type PublicClient,
  type TransactionSerializableEIP1559,
  type Transport,
} from 'viem';
import {
  WalletError,
  assetsForNetwork,
  type AddressValidation,
  type Asset,
  type BlockchainAdapter,
  type EvmNetwork,
  type FeeOption,
  type FeeQuote,
  type FeeTier,
  type Page,
  type ReviewSummary,
  type SignedTx,
  type TransferIntent,
  type TxLookup,
} from '@qd/blockchain';
import type { ActivityItem } from '@qd/shared-types';
import type { SignatureResult, SigningPayload } from '@qd/wallet-core';

export interface EvmFeeParams {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface EvmUnsignedTx {
  networkId: string;
  tx: TransactionSerializableEIP1559 & { chainId: number; nonce: number; gas: bigint };
  from: Hex;
  serializedUnsigned: Hex;
  warnings: ('NONCE_GAP' | 'NONCE_BEHIND_LOCAL')[];
}

export interface HistorySource {
  list(address: string, networkId: string, cursor?: string): Promise<Page<ActivityItem>>;
}

export interface EvmAdapterOptions {
  network: EvmNetwork;
  transport: Transport;
  /** Extra user-added tokens (unverified). */
  extraAssets?: readonly Asset[];
  history?: HistorySource;
  nonceTracker?: NonceTracker;
  /** Test hook. */
  now?: () => number;
}

/** Bounds from spec §16.3. Transfers never need more than this. */
export const GAS_LIMIT_MIN = 21_000n;
export const GAS_LIMIT_MAX = 5_000_000n;
const MIN_PRIORITY_FEE = 1_000_000n; // 0.001 gwei

/**
 * Remembers the last nonce this device used per (chain, address), so a lying or
 * lagging RPC cannot make us reuse or skip nonces silently (spec §11.4).
 */
export class NonceTracker {
  private readonly last: Map<string, number>;

  /** `initial`/`onChange` let the app persist the tracker across reloads. */
  constructor(
    initial: Record<string, number> = {},
    private readonly onChange?: (snapshot: Record<string, number>) => void,
  ) {
    this.last = new Map(Object.entries(initial));
  }

  private key(chainId: number, address: string) {
    return `${chainId}:${address.toLowerCase()}`;
  }
  lastUsed(chainId: number, address: string): number | undefined {
    return this.last.get(this.key(chainId, address));
  }
  markUsed(chainId: number, address: string, nonce: number): void {
    const k = this.key(chainId, address);
    const prev = this.last.get(k);
    if (prev === undefined || nonce > prev) {
      this.last.set(k, nonce);
      this.onChange?.(Object.fromEntries(this.last));
    }
  }
}

export class EvmAdapter implements BlockchainAdapter<EvmUnsignedTx, EvmFeeParams> {
  readonly family = 'evm' as const;
  readonly network: EvmNetwork;
  readonly client: PublicClient;
  private readonly assets: Asset[];
  private readonly history: HistorySource | undefined;
  private readonly nonces: NonceTracker;
  private readonly now: () => number;

  constructor(opts: EvmAdapterOptions) {
    this.network = opts.network;
    this.client = createPublicClient({ transport: opts.transport }) as PublicClient;
    this.assets = assetsForNetwork(opts.network, opts.extraAssets);
    this.history = opts.history;
    this.nonces = opts.nonceTracker ?? new NonceTracker();
    this.now = opts.now ?? Date.now;
  }

  listAssets(): readonly Asset[] {
    return this.assets;
  }

  validateAddress(input: string): AddressValidation {
    const s = input.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { valid: false, reason: 'format' };
    if (!isAddress(s, { strict: true })) return { valid: false, reason: 'checksum' };
    return { valid: true, normalized: getAddress(s) };
  }

  async getBalance(address: string): Promise<bigint> {
    return this.client.getBalance({ address: getAddress(address) });
  }

  async getTokenBalance(address: string, asset: Asset): Promise<bigint> {
    if (asset.kind === 'native') return this.getBalance(address);
    return this.client.readContract({
      address: asset.contract!,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [getAddress(address)],
    });
  }

  /** Balances for every listed asset; failures for single tokens become `null`. */
  async getAllBalances(address: string): Promise<Map<string, bigint | null>> {
    const entries = await Promise.all(
      this.assets.map(async (a) => {
        try {
          return [a.id, await this.getTokenBalance(address, a)] as const;
        } catch (e) {
          if (a.kind === 'native') throw e;
          return [a.id, null] as const;
        }
      }),
    );
    return new Map(entries);
  }

  async getTransaction(hash: string): Promise<TxLookup | null> {
    const h = hash as Hex;
    const receipt = await this.client.getTransactionReceipt({ hash: h }).catch(() => null);
    if (receipt) {
      return {
        hash,
        status: receipt.status === 'success' ? 'confirmed' : 'failed',
        blockNumber: receipt.blockNumber,
        fee: receipt.gasUsed * receipt.effectiveGasPrice,
      };
    }
    const tx = await this.client.getTransaction({ hash: h }).catch(() => null);
    return tx ? { hash, status: 'pending' } : null;
  }

  async getTransactionHistory(address: string, cursor?: string): Promise<Page<ActivityItem>> {
    if (!this.history) return { items: [] };
    return this.history.list(address, this.network.id, cursor);
  }

  async estimateFee(intent: TransferIntent): Promise<FeeQuote<EvmFeeParams>> {
    const call = this.callFor(intent);
    const [gas, history] = await Promise.all([this.estimateGas(intent, call), this.client.getFeeHistory({ blockCount: 10, rewardPercentiles: [10, 50, 90], blockTag: 'latest' })]);

    const nextBase = history.baseFeePerGas[history.baseFeePerGas.length - 1] ?? 0n;
    const rewards = history.reward ?? [];
    const priority = (col: number) => {
      const vals = rewards.map((r) => r[col] ?? 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const median = vals.length ? vals[Math.floor(vals.length / 2)]! : 0n;
      return median < MIN_PRIORITY_FEE ? MIN_PRIORITY_FEE : median;
    };
    const blockSec = Math.max(1, Math.round(this.network.blockTimeMs / 1000));
    const make = (tier: FeeTier, col: number, baseMultiplier: bigint, blocks: number) => {
      const maxPriorityFeePerGas = priority(col);
      const maxFeePerGas = nextBase * baseMultiplier + maxPriorityFeePerGas;
      return {
        tier,
        maxFee: gas * maxFeePerGas,
        estimatedFee: gas * (nextBase + maxPriorityFeePerGas),
        etaSeconds: blocks * blockSec,
        params: { gas, maxFeePerGas, maxPriorityFeePerGas },
      };
    };
    return {
      options: { low: make('low', 0, 2n, 6), market: make('market', 1, 2n, 2), aggressive: make('aggressive', 2, 3n, 1) },
      quotedAt: this.now(),
    };
  }

  async buildTransaction(intent: TransferIntent, fee: FeeOption & { params: EvmFeeParams }): Promise<EvmUnsignedTx> {
    const from = getAddress(intent.from);
    const { gas, maxFeePerGas, maxPriorityFeePerGas } = fee.params;
    if (gas < GAS_LIMIT_MIN || gas > GAS_LIMIT_MAX) {
      throw new WalletError({
        code: 'GAS_ESTIMATION_FAILED',
        userTitle: 'Unexpected network response',
        userMessage: 'The network returned an unusual gas limit. Your funds have not been sent.',
        fundsMoved: 'no',
        retryable: true,
        technical: `gas=${gas}`,
      });
    }
    if (maxPriorityFeePerGas > maxFeePerGas) throw new Error('priority fee exceeds max fee');

    const rpcNonce = await this.client.getTransactionCount({ address: from, blockTag: 'pending' });
    const local = this.nonces.lastUsed(this.network.chainId, from);
    const warnings: EvmUnsignedTx['warnings'] = [];
    let nonce = rpcNonce;
    if (local !== undefined) {
      if (rpcNonce <= local) {
        // RPC lags behind what we already broadcast: never reuse a nonce.
        nonce = local + 1;
        warnings.push('NONCE_BEHIND_LOCAL');
      } else if (rpcNonce > local + 1) {
        warnings.push('NONCE_GAP');
      }
    }

    const call = this.callFor(intent);
    const tx = {
      type: 'eip1559' as const,
      chainId: this.network.chainId, // registry, never RPC (spec §11.4)
      nonce,
      to: call.to,
      value: call.value,
      ...(call.data ? { data: call.data } : {}),
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
    return { networkId: this.network.id, tx, from, serializedUnsigned: serializeTransaction(tx), warnings };
  }

  /**
   * Review data decoded from the serialized bytes that will be signed, not from
   * the intent, so the screen shows exactly what is signed (threat T7).
   */
  describe(unsigned: EvmUnsignedTx): ReviewSummary {
    const parsed = parseTransaction(unsigned.serializedUnsigned);
    if (parsed.type !== 'eip1559' || parsed.chainId !== this.network.chainId) {
      throw new Error('Transaction does not match the selected network');
    }
    if (!parsed.to) throw new Error('Contract creation is not supported');
    const maxFee = (parsed.gas ?? 0n) * (parsed.maxFeePerGas ?? 0n);
    const base = { networkId: this.network.id, from: unsigned.from, maxFee, ...(parsed.nonce !== undefined ? { nonce: parsed.nonce } : {}) };

    if (!parsed.data || parsed.data === '0x') {
      return { ...base, to: getAddress(parsed.to), asset: this.assets[0]!, amount: parsed.value ?? 0n };
    }
    const token = this.assets.find((a) => a.contract?.toLowerCase() === parsed.to!.toLowerCase());
    if (!token || (parsed.value ?? 0n) !== 0n) throw new Error('Unsupported contract interaction');
    const decoded = decodeFunctionData({ abi: erc20Abi, data: parsed.data });
    if (decoded.functionName !== 'transfer') throw new Error('Unsupported token call');
    const [to, amount] = decoded.args as readonly [Hex, bigint];
    return { ...base, to: getAddress(to), asset: token, amount };
  }

  signingPayload(unsigned: EvmUnsignedTx): SigningPayload {
    return {
      kind: 'evm-transaction',
      chainId: unsigned.tx.chainId,
      from: unsigned.from,
      serializedUnsigned: unsigned.serializedUnsigned,
    };
  }

  assembleSigned(unsigned: EvmUnsignedTx, sig: SignatureResult): SignedTx {
    if (sig.kind !== 'evm-ecdsa') throw new Error('Unexpected signature kind');
    const raw = serializeTransaction(unsigned.tx, { r: sig.r, s: sig.s, yParity: sig.yParity });
    return { networkId: this.network.id, raw, hash: keccak256(raw) };
  }

  async broadcastTransaction(signed: SignedTx): Promise<string> {
    const hash = await this.client.sendRawTransaction({ serializedTransaction: signed.raw });
    if (hash.toLowerCase() !== signed.hash.toLowerCase()) {
      throw new WalletError({
        code: 'BROADCAST_UNKNOWN',
        userTitle: 'Unexpected network response',
        userMessage: 'The network returned a different transaction id. Check Activity before trying again.',
        fundsMoved: 'unknown',
        retryable: false,
        technical: `expected ${signed.hash} got ${hash}`,
      });
    }
    const parsed = parseTransaction(signed.raw);
    if (parsed.nonce !== undefined) {
      const sender = await recoverTransactionAddress({ serializedTransaction: signed.raw as never });
      this.nonces.markUsed(this.network.chainId, sender, parsed.nonce);
    }
    return hash;
  }

  async waitForFinal(hash: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TxLookup> {
    const deadline = this.now() + (opts.timeoutMs ?? 10 * 60_000);
    const interval = Math.min(4000, Math.max(500, this.network.blockTimeMs / 2));
    for (;;) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const found = await this.getTransaction(hash).catch(() => null);
      if (found && found.status !== 'pending') return found;
      if (this.now() > deadline) return found ?? { hash, status: 'pending' };
      await sleep(interval, opts.signal);
    }
  }

  private callFor(intent: TransferIntent): { to: Hex; value: bigint; data?: Hex } {
    const to = getAddress(intent.to);
    if (intent.asset.networkId !== this.network.id) throw new Error('Asset is on a different network');
    if (intent.asset.kind === 'native') return { to, value: intent.amount };
    return {
      to: intent.asset.contract!,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, intent.amount] }),
    };
  }

  private async estimateGas(intent: TransferIntent, call: { to: Hex; value: bigint; data?: Hex }): Promise<bigint> {
    if (intent.asset.kind === 'native') {
      const code = await this.client.getCode({ address: call.to });
      if (!code || code === '0x') return GAS_LIMIT_MIN; // plain EOA transfer: exactly 21k
    }
    const est = await this.client.estimateGas({ account: getAddress(intent.from), ...call });
    return (est * 12n) / 10n;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
