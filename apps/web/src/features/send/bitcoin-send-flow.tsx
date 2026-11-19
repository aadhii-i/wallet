'use client';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, Check, ClipboardPaste, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AmountParseError,
  formatDisplay,
  formatUnits,
  formatUsdCents,
  parseUnits,
  toUsdCents,
  type Asset,
  type BitcoinNetwork,
  type FeeQuote,
  type FeeTier,
} from '@qd/blockchain';
import type { BitcoinFeeParams, BitcoinUnsignedTx } from '@qd/bitcoin';
import {
  assessFee,
  assessRecipient,
  blockingFindings,
  initialSendState,
  isInFlight,
  mapError,
  sendReducer,
  QUOTE_TTL_MS,
  type RiskFinding,
} from '@qd/transaction';
import type { ConfirmationToken } from '@qd/wallet-core';
import { useAccountAddress, useBitcoinAdapter, usePrices, useValuedHoldings, type ValuedHolding } from '@/lib/hooks';
import { useMeta, useSelectedAccount, toast } from '@/lib/store';
import { vault } from '@/lib/vault-client';
import { Button } from '@/components/ui/button';
import { ChunkedAddress, Identicon, TokenIcon, shortAddress } from '@/components/ui/identity';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/spinner';
import { NetworkDot } from '@/components/wallet/network-sheet';
import { stepVariants, t } from '@/components/ui/motion';
import { ErrorPanel, ReviewRow, RiskList, StatusView, tierLabel } from './send-flow';

type Step = 'recipient' | 'amount' | 'review';
const ORDER: Step[] = ['recipient', 'amount', 'review'];

/**
 * Bitcoin send flow.
 *
 * The shape mirrors the EVM flow, but the payload is a PSBT rather than a
 * typed transaction, fees are quoted in sat/vB, and the amount is always
 * native BTC. The worker confirmation model is identical: a token is bound to
 * the exact PSBT bytes the user reviewed (threat T7).
 */
export function BitcoinSendFlow({ network }: { network: BitcoinNetwork }) {
  const router = useRouter();
  const adapter = useBitcoinAdapter();
  const account = useSelectedAccount();
  const from = useAccountAddress();
  const { valued } = useValuedHoldings(from);

  const [step, setStep] = useState<Step>('recipient');
  const [dir, setDir] = useState(1);
  const [recipient, setRecipient] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [tier, setTier] = useState<FeeTier>('market');
  const [submitting, setSubmitting] = useState(false);

  const asset = adapter.listAssets()[0]!;
  const holding = valued?.find((h) => h.asset.id === asset.id) ?? null;

  const go = (next: Step) => {
    setDir(ORDER.indexOf(next) >= ORDER.indexOf(step) ? 1 : -1);
    setStep(next);
  };

  const back = () => {
    if (step === 'recipient') router.back();
    else if (step === 'amount') go('recipient');
    else go('amount');
  };

  const titles: Record<Step, string> = {
    recipient: 'Send to',
    amount: 'Amount',
    review: 'Review',
  };

  // The address is derived in the worker; until it is ready there is nothing
  // to send from, so the flow waits rather than showing a placeholder.
  if (!account || !from) return null;

  return (
    <div className="flex min-h-[calc(100dvh-120px)] flex-col">
      {!submitting && (
        <div className="mb-4 flex items-center justify-between">
          <button type="button" onClick={back} aria-label="Back" className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-surface-hover">
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-lg font-semibold">{titles[step]}</h1>
          <button type="button" onClick={() => router.push('/home')} aria-label="Cancel" className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-surface-hover">
            <X size={20} />
          </button>
        </div>
      )}
      <AnimatePresence mode="wait" custom={dir} initial={false}>
        <motion.div key={step} custom={dir} variants={stepVariants} initial="enter" animate="center" exit="exit" transition={t.base} className="flex flex-1 flex-col">
          {step === 'recipient' && (
            <RecipientStep
              network={network}
              value={recipient}
              onChange={setRecipient}
              from={from}
              onNext={(normalized) => {
                setRecipient(normalized);
                go('amount');
              }}
            />
          )}
          {step === 'amount' && (
            <AmountStep
              network={network}
              asset={asset}
              holding={holding}
              value={amountInput}
              onChange={setAmountInput}
              from={from}
              to={recipient}
              onNext={() => go('review')}
            />
          )}
          {step === 'review' && (
            <ReviewAndSend
              network={network}
              asset={asset}
              from={from}
              accountIndex={account.index}
              accountName={account.name}
              accountApiId={account.apiId}
              to={recipient}
              amount={parseUnits(amountInput || '0', asset.decimals)}
              tier={tier}
              onTier={setTier}
              onStatus={() => setSubmitting(true)}
              onEdit={() => go('amount')}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------- recipient

function RecipientStep({
  network,
  value,
  onChange,
  from,
  onNext,
}: {
  network: BitcoinNetwork;
  value: string;
  onChange: (v: string) => void;
  from: string;
  onNext: (normalized: string) => void;
}) {
  const adapter = useBitcoinAdapter();
  const trimmed = value.trim();
  const validation = trimmed ? adapter.validateAddress(trimmed) : null;

  const findings = useMemo(() => {
    if (!validation?.valid) return [];
    return assessRecipient({
      networkId: network.id,
      from,
      to: validation.normalized!,
      ownAccounts: new Map([[from.toLowerCase(), 'this account']]),
      knownAddresses: [],
    }).filter((f) => f.code !== 'FIRST_TIME_RECIPIENT');
  }, [validation?.valid, validation?.normalized, network.id, from]);

  const blocked = blockingFindings(findings).length > 0;

  const error =
    validation && !validation.valid
      ? validation.reason === 'network'
        ? `This address belongs to another network. ${network.name} addresses start with ${network.bitcoin.bech32Hrp}1.`
        : validation.reason === 'checksum'
          ? 'This address has an invalid checksum. Check for typos.'
          : 'Enter a valid Bitcoin address.'
      : null;

  return (
    <div className="flex flex-1 flex-col">
      <label htmlFor="btc-recipient" className="mb-2 text-sm font-medium text-muted">
        Recipient address
      </label>
      <div className={`flex items-start gap-2 rounded-2xl border bg-surface px-4 py-3 transition-colors focus-within:border-primary ${error ? 'border-danger' : 'border-line-strong'}`}>
        <textarea
          id="btc-recipient"
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`${network.bitcoin.bech32Hrp}1…`}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-invalid={!!error}
          aria-describedby="btc-recipient-help"
          className="min-w-0 flex-1 resize-none bg-transparent font-mono text-[15px] outline-none placeholder:text-subtle"
        />
        {value ? (
          <button type="button" onClick={() => onChange('')} aria-label="Clear" className="mt-0.5 text-subtle hover:text-ink">
            <X size={18} />
          </button>
        ) : (
          <button
            type="button"
            onClick={async () => {
              try {
                onChange((await navigator.clipboard.readText()).trim());
              } catch {
                toast.error('Couldn’t read clipboard');
              }
            }}
            className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary"
          >
            <ClipboardPaste size={14} /> Paste
          </button>
        )}
      </div>
      <div id="btc-recipient-help" className="min-h-6 pt-2 text-sm" aria-live="polite">
        {error && <span className="text-danger">{error}</span>}
      </div>

      {validation?.valid && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={t.base} className="mb-3 flex items-center gap-3 rounded-2xl bg-sunken p-3">
          <Identicon address={validation.normalized!} size={36} />
          <ChunkedAddress address={validation.normalized!} className="min-w-0" />
        </motion.div>
      )}
      <RiskList findings={findings} />

      <div className="mt-auto pt-6">
        <Button block size="lg" disabled={!validation?.valid || blocked} onClick={() => onNext(validation!.normalized!)}>
          Continue
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- amount

function AmountStep({
  network,
  asset,
  holding,
  value,
  onChange,
  from,
  to,
  onNext,
}: {
  network: BitcoinNetwork;
  asset: Asset;
  holding: ValuedHolding | null;
  value: string;
  onChange: (v: string) => void;
  from: string;
  to: string;
  onNext: () => void;
}) {
  const adapter = useBitcoinAdapter();
  const prices = usePrices(asset.priceRef ? [asset.priceRef] : []);
  const price = asset.priceRef ? prices.data?.[asset.priceRef]?.usd : undefined;
  const [maxLoading, setMaxLoading] = useState(false);
  const balance = holding?.balance ?? null;
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  let parsed: bigint | null = null;
  let error: string | null = null;
  if (value) {
    try {
      parsed = parseUnits(value, asset.decimals);
      if (parsed === 0n) error = 'Enter an amount greater than 0';
      else if (balance !== null && parsed > balance) error = `Insufficient ${asset.symbol} balance`;
    } catch (e) {
      error = e instanceof AmountParseError && e.code === 'PRECISION' ? `${asset.symbol} supports up to ${asset.decimals} decimals` : 'Enter a valid amount';
    }
  }
  const fiat = parsed !== null && price ? formatUsdCents(toUsdCents(parsed, asset.decimals, price)) : null;

  const setMax = async () => {
    if (balance === null) return;
    setMaxLoading(true);
    try {
      const q = await adapter.estimateFee({ from, to, asset, amount: balance });
      // "Max" must leave room for the fee, otherwise the transaction cannot be
      // built at all.
      const max = balance - q.options.aggressive.maxFee;
      onChange(max > 0n ? formatUnits(max, asset.decimals) : '0');
      if (max <= 0n) toast.error('Balance too low', 'Not enough to cover the network fee.');
    } catch {
      toast.error('Couldn’t estimate the network fee');
    } finally {
      setMaxLoading(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-6 flex items-center justify-center gap-2 text-sm text-muted">
        <TokenIcon symbol={asset.symbol} size={22} /> {asset.symbol} on {network.shortName}
      </div>
      <div className="flex flex-col items-center">
        <div className="flex max-w-full items-baseline justify-center gap-2">
          <input
            ref={input}
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(e) => {
              const v = e.target.value.replace(',', '.');
              if (/^\d*\.?\d*$/.test(v)) onChange(v);
            }}
            placeholder="0"
            aria-label={`Amount in ${asset.symbol}`}
            aria-invalid={!!error}
            className="tabular w-full min-w-[1ch] bg-transparent text-center text-5xl font-bold outline-none placeholder:text-line-strong"
            style={{ width: `${Math.max(1, value.length || 1) + 0.5}ch` }}
          />
          <span className="text-2xl font-semibold text-muted">{asset.symbol}</span>
        </div>
        <div className="tabular mt-2 h-5 text-sm text-muted">{fiat ?? ''}</div>
        <div className="mt-1 h-5 text-sm" aria-live="polite">
          {error && <span className="text-danger">{error}</span>}
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between rounded-2xl bg-sunken px-4 py-3 text-sm">
        <span className="text-muted">
          Balance:{' '}
          <span className="tabular font-medium text-ink">{balance === null ? '—' : `${formatDisplay(balance, asset.decimals, 8)} ${asset.symbol}`}</span>
        </span>
        <Button size="sm" variant="secondary" onClick={setMax} loading={maxLoading} disabled={balance === null}>
          Max
        </Button>
      </div>
      <div className="mt-auto pt-6">
        <Button block size="lg" disabled={!parsed || !!error} onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- review + status

interface Prepared {
  unsigned: BitcoinUnsignedTx;
  token: ConfirmationToken;
  quote: FeeQuote<BitcoinFeeParams>;
}

function ReviewAndSend(props: {
  network: BitcoinNetwork;
  asset: Asset;
  from: string;
  accountIndex: number;
  accountName: string;
  accountApiId: string | undefined;
  to: string;
  amount: bigint;
  tier: FeeTier;
  onTier: (t: FeeTier) => void;
  onStatus: () => void;
  onEdit: () => void;
}) {
  const { asset, from, to, amount, tier } = props;
  const adapter = useBitcoinAdapter();
  const network = props.network;
  const qc = useQueryClient();
  const router = useRouter();
  const upsertLocalTx = useMeta((s) => s.upsertLocalTx);
  const prices = usePrices(asset.priceRef ? [asset.priceRef] : []);
  const [state, dispatch] = useReducer(sendReducer, initialSendState);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [feeSheet, setFeeSheet] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const aborter = useRef<AbortController | null>(null);

  const prepare = useCallback(async () => {
    dispatch({ type: 'ESTIMATE' });
    try {
      await adapter.getChainStatus();
      const intent = { from, to, asset, amount };
      const quote = await adapter.estimateFee(intent);
      const unsigned = await adapter.buildTransaction(intent, quote.options[tier]);
      // The token is bound to exactly these PSBT bytes inside the KeyWorker.
      const token = await vault.call('issueConfirmation', { payload: adapter.signingPayload(unsigned) });
      setPrepared({ unsigned, token, quote });
      dispatch({ type: 'ESTIMATED', at: Date.now() });
    } catch (e) {
      dispatch({ type: 'ERROR', error: mapError(e, 'estimate') });
    }
  }, [adapter, from, to, asset, amount, tier]);

  useEffect(() => {
    void prepare();
  }, [prepare]);

  // Re-quote while the user sits on the review screen (spec §16.1).
  useEffect(() => {
    if (state.status !== 'ready_for_review') return;
    const id = setTimeout(() => void prepare(), QUOTE_TTL_MS);
    return () => clearTimeout(id);
  }, [state.status, state.quotedAt, prepare]);

  // Warn before leaving mid-signature.
  useEffect(() => {
    if (!isInFlight(state.status)) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [state.status]);

  useEffect(() => () => aborter.current?.abort(), []);

  const unsigned = prepared?.unsigned;
  const worstCaseFee = prepared?.quote.options[tier].maxFee ?? 0n;
  const nativeBalance = useValuedHoldings(from).valued?.find((h) => h.asset.kind === 'native')?.balance ?? null;

  const findings: RiskFinding[] = useMemo(() => {
    if (!unsigned) return [];
    const recipient = assessRecipient({
      networkId: network.id,
      from,
      to: unsigned.to,
      ownAccounts: new Map([[from.toLowerCase(), 'this account']]),
      knownAddresses: [],
    }).filter((f) => f.code !== 'FIRST_TIME_RECIPIENT' && f.code !== 'OWN_ACCOUNT');
    // Bitcoin fees are quoted in satoshis, so the warning threshold is sats too.
    const fee = assessFee({
      maxFee: worstCaseFee,
      feeWarningNative: BigInt(network.bitcoin.feeWarningSats),
      amount: unsigned.amount,
      isNativeTransfer: true,
    });
    return [...recipient, ...fee];
  }, [unsigned, network, from, worstCaseFee]);

  const insufficientForFee = nativeBalance !== null && nativeBalance < worstCaseFee + amount;
  const needAck = findings.filter((f) => f.requiresAck && !acks[f.code]);
  const blocked = blockingFindings(findings).length > 0;

  const fiat = (value: bigint) => {
    const p = asset.priceRef ? prices.data?.[asset.priceRef]?.usd : undefined;
    return p ? formatUsdCents(toUsdCents(value, asset.decimals, p)) : null;
  };

  const confirm = async () => {
    if (!prepared) return;
    dispatch({ type: 'CONFIRM' });
    props.onStatus();
    let signed;
    try {
      const sig = await vault.call('sign', {
        account: { id: props.accountApiId ?? `hd-${props.accountIndex}`, hdIndex: props.accountIndex },
        payload: adapter.signingPayload(prepared.unsigned),
        confirmation: prepared.token,
      });
      signed = adapter.assembleSigned(prepared.unsigned, sig);
      dispatch({ type: 'SIGNED' });
    } catch (e) {
      dispatch({ type: 'ERROR', error: mapError(e, 'sign') });
      return;
    }
    try {
      const hash = await adapter.broadcastTransaction(signed);
      dispatch({ type: 'BROADCAST_OK', hash });
      const local = {
        hash,
        networkId: network.id,
        from,
        to: prepared.unsigned.to,
        assetId: asset.id,
        amount: prepared.unsigned.amount.toString(),
        status: 'pending' as const,
        createdAt: Date.now(),
      };
      upsertLocalTx(local);
      aborter.current = new AbortController();
      const final = await adapter.waitForFinal(hash, { signal: aborter.current.signal });
      upsertLocalTx({ ...local, status: final.status, ...(final.fee !== undefined ? { fee: final.fee.toString() } : {}) });
      void qc.invalidateQueries({ queryKey: ['holdings'] });
      if (final.status === 'confirmed') {
        dispatch({ type: 'TX_CONFIRMED' });
        toast.success('Transaction confirmed', `${formatDisplay(prepared.unsigned.amount, asset.decimals)} ${asset.symbol} sent`);
        navigator.vibrate?.([10, 40, 10]);
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      dispatch({ type: 'ERROR', error: mapError(e, 'broadcast') });
    }
  };

  if (['signing', 'broadcasting', 'pending', 'confirmed', 'failed', 'rejected'].includes(state.status)) {
    return (
      <StatusView
        status={state.status}
        error={state.error}
        hash={state.txHash}
        amountText={unsigned ? `${formatDisplay(unsigned.amount, asset.decimals, 8)} ${asset.symbol}` : ''}
        to={unsigned?.to ?? to}
        onDone={() => router.push('/home')}
        onActivity={() => router.push('/activity')}
      />
    );
  }

  if (state.status === 'error' && state.error) {
    const e = state.error;
    const afterSign = e.fundsMoved !== 'no';
    return afterSign ? (
      <StatusView status="error" error={e} hash={state.txHash} amountText="" to={to} onDone={() => router.push('/home')} onActivity={() => router.push('/activity')} />
    ) : (
      <ErrorPanel error={e} onRetry={e.retryable ? () => void prepare() : undefined} onEdit={props.onEdit} />
    );
  }

  const option = prepared?.quote.options[tier];

  return (
    <div className="flex flex-1 flex-col">
      {!unsigned ? (
        <div className="space-y-3" aria-busy="true" aria-label="Preparing transaction">
          <Skeleton className="mx-auto h-10 w-40" />
          <Skeleton className="h-48 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
        </div>
      ) : (
        <>
          <div className="mb-5 text-center">
            <TokenIcon symbol={asset.symbol} size={48} />
            <div className="tabular mt-3 text-3xl font-bold">
              {formatDisplay(unsigned.amount, asset.decimals, 8)} {asset.symbol}
            </div>
            <div className="tabular text-sm text-muted">{fiat(unsigned.amount) ?? ''}</div>
          </div>

          <dl className="mb-4 divide-y divide-line rounded-2xl border border-line bg-surface">
            <ReviewRow label="From">
              <span className="flex items-center justify-end gap-2">
                <Identicon address={unsigned.from} size={20} />
                <span>
                  <span className="block font-semibold">{props.accountName}</span>
                  <span className="block font-mono text-xs text-subtle">{shortAddress(unsigned.from)}</span>
                </span>
              </span>
            </ReviewRow>
            <ReviewRow label="To">
              <span className="flex items-start justify-end gap-2">
                <Identicon address={unsigned.to} size={20} />
                <ChunkedAddress address={unsigned.to} className="max-w-[210px] text-right" />
              </span>
            </ReviewRow>
            <ReviewRow label="Asset">{asset.name}</ReviewRow>
            <ReviewRow label="Network">
              <span className="inline-flex items-center gap-1.5">
                <NetworkDot network={network} size={16} /> {network.name}
                {network.kind !== 'mainnet' && <span className="rounded bg-warning-soft px-1.5 text-[10px] font-semibold text-warning">{network.kind === 'testnet' ? 'Testnet' : 'Unrecognised'}</span>}
              </span>
            </ReviewRow>
            <ReviewRow label="Network fee">
              <button type="button" onClick={() => setFeeSheet(true)} className="text-right">
                <span className="tabular block font-semibold">
                  {formatDisplay(option?.estimatedFee ?? 0n, 8, 6)} {asset.symbol}
                </span>
                <span className="block text-xs text-primary">
                  {tierLabel(tier)} · ~{option?.etaSeconds ?? 0}s · Edit
                </span>
              </button>
            </ReviewRow>
            <ReviewRow label="Total" strong>
              <span className="tabular">
                {formatDisplay(unsigned.amount + (option?.estimatedFee ?? 0n), 8, 8)} {asset.symbol}
                <span className="block text-xs font-normal text-muted">{fiat(unsigned.amount + (option?.estimatedFee ?? 0n)) ?? ''}</span>
              </span>
            </ReviewRow>
          </dl>

          <button type="button" onClick={() => setShowDetails((s) => !s)} className="mb-3 self-start text-xs font-medium text-muted hover:text-ink">
            {showDetails ? 'Hide' : 'Show'} technical details
          </button>
          {showDetails && (
            <div className="mb-4 space-y-1 rounded-xl bg-sunken p-3 font-mono text-[11px] text-muted">
              <div>address type: {unsigned.addressType}</div>
              <div>inputs: {unsigned.inputCount}</div>
              <div>change: {formatDisplay(unsigned.change, 8, 8)} {asset.symbol}</div>
              <div>virtual size: {unsigned.vsize} vB</div>
              <div>fee rate: {prepared?.quote.options[tier].params.feeRate} sat/vB</div>
              <div>max fee: {formatDisplay(worstCaseFee, 8, 6)} {asset.symbol}</div>
            </div>
          )}

          {insufficientForFee && (
            <div className="mb-3 flex gap-2 rounded-xl bg-danger-soft p-3 text-sm" role="alert">
              <X size={18} className="mt-0.5 shrink-0 text-danger" />
              Not enough {asset.symbol} to cover the amount and the maximum network fee.
            </div>
          )}
          <RiskList findings={findings} acks={acks} onAck={(code) => setAcks((a) => ({ ...a, [code]: !a[code] }))} />

          <div className="mt-auto grid grid-cols-2 gap-3 pt-4">
            <Button variant="secondary" size="lg" onClick={() => router.push('/home')}>
              Reject
            </Button>
            <Button size="lg" onClick={confirm} disabled={state.status !== 'ready_for_review' || needAck.length > 0 || blocked || !!insufficientForFee} loading={state.status === 'estimating'} loadingText="Updating">
              Confirm
            </Button>
          </div>
        </>
      )}

      <BitcoinFeeSheet
        open={feeSheet}
        onOpenChange={setFeeSheet}
        quote={prepared?.quote}
        tier={tier}
        symbol={asset.symbol}
        fiat={(v) => fiat(v)}
        onPick={(tr) => {
          props.onTier(tr);
          setFeeSheet(false);
        }}
      />
    </div>
  );
}

function BitcoinFeeSheet({
  open,
  onOpenChange,
  quote,
  tier,
  symbol,
  fiat,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  quote: FeeQuote<BitcoinFeeParams> | undefined;
  tier: FeeTier;
  symbol: string;
  fiat: (v: bigint) => string | null;
  onPick: (t: FeeTier) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Network fee" description="Higher fees are usually confirmed faster. You never pay more than the max fee.">
      <ul className="space-y-2">
        {(['low', 'market', 'aggressive'] as FeeTier[]).map((tr) => {
          const o = quote?.options[tr];
          return (
            <li key={tr}>
              <button
                type="button"
                onClick={() => onPick(tr)}
                aria-pressed={tr === tier}
                className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors ${tr === tier ? 'border-primary bg-primary-soft' : 'border-line hover:bg-surface-hover'}`}
              >
                <span className="flex-1">
                  <span className="block font-semibold">{tierLabel(tr)}</span>
                  <span className="block text-xs text-muted">
                    ~{o?.etaSeconds ?? '—'} sec{o ? ` · ${o.params.feeRate} sat/vB` : ''}
                  </span>
                </span>
                <span className="tabular text-right text-sm">
                  <span className="block font-semibold">{o ? `${formatDisplay(o.estimatedFee, 8, 6)} ${symbol}` : '—'}</span>
                  <span className="block text-xs text-muted">{o ? `max ${formatDisplay(o.maxFee, 8, 6)}${fiat(o.estimatedFee) ? ` · ${fiat(o.estimatedFee)}` : ''}` : ''}</span>
                </span>
                {tr === tier && <Check size={18} className="text-primary" />}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
