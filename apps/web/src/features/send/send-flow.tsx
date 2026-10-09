'use client';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, ArrowLeft, Check, ChevronRight, ClipboardPaste, Info, X, XCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AmountParseError,
  formatDisplay,
  formatUnits,
  formatUsdCents,
  parseUnits,
  toUsdCents,
  type Asset,
  type FeeQuote,
  type FeeTier,
  type ReviewSummary,
  type WalletError,
} from '@qd/blockchain';
import type { EvmFeeParams, EvmUnsignedTx } from '@qd/evm';
import {
  assessFee,
  assessNonce,
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
import { useAdapter, useNetwork, usePrices, useValuedHoldings, type ValuedHolding } from '@/lib/hooks';
import { getApi } from '@/lib/api';
import { useMeta, useSelectedAccount, useSession, toast } from '@/lib/store';
import { vault } from '@/lib/vault-client';
import { Button } from '@/components/ui/button';
import { ChunkedAddress, Identicon, TokenIcon, shortAddress } from '@/components/ui/identity';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/spinner';
import { NetworkDot } from '@/components/wallet/network-sheet';
import { stepVariants, t } from '@/components/ui/motion';

type Step = 'asset' | 'recipient' | 'amount' | 'review';
const ORDER: Step[] = ['asset', 'recipient', 'amount', 'review'];

interface Prepared {
  unsigned: EvmUnsignedTx;
  review: ReviewSummary;
  token: ConfirmationToken;
  quote: FeeQuote<EvmFeeParams>;
}

export function SendFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const account = useSelectedAccount();
  const network = useNetwork();
  const adapter = useAdapter();
  const { valued, holdings } = useValuedHoldings(account?.address);
  const accounts = useMeta((s) => s.accounts);
  const knownRecipients = useMeta((s) => (account ? s.knownRecipients[account.address.toLowerCase()] : undefined));

  const [step, setStep] = useState<Step>(params.get('asset') ? 'recipient' : 'asset');
  const [dir, setDir] = useState(1);
  const [assetId, setAssetId] = useState<string | null>(params.get('asset'));
  const [recipient, setRecipient] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [tier, setTier] = useState<FeeTier>('market');
  // Once signing starts the review component must stay mounted (it owns the in-flight send);
  // only the chrome changes.
  const [submitting, setSubmitting] = useState(false);

  const holding = valued?.find((h) => h.asset.id === assetId) ?? null;
  const asset = holding?.asset ?? adapter.listAssets().find((a) => a.id === assetId) ?? null;

  const go = (next: Step) => {
    setDir(ORDER.indexOf(next) >= ORDER.indexOf(step) ? 1 : -1);
    setStep(next);
  };

  const back = () => {
    if (step === 'asset' || (step === 'recipient' && params.get('asset'))) router.back();
    else if (step === 'recipient') go('asset');
    else if (step === 'amount') go('recipient');
    else if (step === 'review') go('amount');
  };

  const titles: Record<Step, string> = {
    asset: 'Select asset',
    recipient: 'Send to',
    amount: 'Amount',
    review: 'Review',
  };

  if (!account) return null;

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
          {step === 'asset' && (
            <AssetStep
              valued={valued}
              loading={holdings.isLoading}
              onPick={(a) => {
                setAssetId(a.id);
                go('recipient');
              }}
            />
          )}
          {step === 'recipient' && (
            <RecipientStep
              value={recipient}
              onChange={setRecipient}
              from={account.address}
              ownAccounts={accounts.filter((a) => a.index !== account.index)}
              known={knownRecipients ?? []}
              networkId={network.id}
              onNext={(normalized) => {
                setRecipient(normalized);
                go('amount');
              }}
            />
          )}
          {step === 'amount' && asset && (
            <AmountStep
              asset={asset}
              holding={holding}
              value={amountInput}
              onChange={setAmountInput}
              from={account.address}
              to={recipient}
              onNext={() => go('review')}
            />
          )}
          {step === 'review' && asset && (
            <ReviewAndSend
              asset={asset}
              from={account.address}
              accountIndex={account.index}
              accountName={account.name}
              accountApiId={account.apiId}
              to={recipient}
              amount={parseUnits(amountInput || '0', asset.decimals)}
              tier={tier}
              onTier={setTier}
              knownRecipients={knownRecipients ?? []}
              onStatus={() => setSubmitting(true)}
              onEdit={() => go('amount')}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------- asset

function AssetStep({ valued, loading, onPick }: { valued: ValuedHolding[] | undefined; loading: boolean; onPick: (a: Asset) => void }) {
  if (loading)
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-2xl" />
        ))}
      </div>
    );
  return (
    <ul className="space-y-1">
      {(valued ?? []).map((h) => (
        <li key={h.asset.id}>
          <button type="button" onClick={() => onPick(h.asset)} className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left hover:bg-surface-hover">
            <TokenIcon symbol={h.asset.symbol} />
            <span className="flex-1">
              <span className="block font-semibold">{h.asset.symbol}</span>
              <span className="tabular block text-sm text-muted">
                {h.balance === null ? 'Balance unavailable' : `${formatDisplay(h.balance, h.asset.decimals)} available`}
              </span>
            </span>
            <ChevronRight size={18} className="text-subtle" />
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- recipient

function RecipientStep({
  value,
  onChange,
  from,
  ownAccounts,
  known,
  networkId,
  onNext,
}: {
  value: string;
  onChange: (v: string) => void;
  from: string;
  ownAccounts: { index: number; name: string; address: string }[];
  known: string[];
  networkId: string;
  onNext: (normalized: string) => void;
}) {
  const adapter = useAdapter();
  const trimmed = value.trim();
  const validation = trimmed ? adapter.validateAddress(trimmed) : null;
  const findings = useMemo(() => {
    if (!validation?.valid) return [];
    return assessRecipient({
      networkId,
      from,
      to: validation.normalized!,
      ownAccounts: new Map([[from.toLowerCase(), 'this account'], ...ownAccounts.map((a) => [a.address.toLowerCase(), a.name] as [string, string])]),
      knownAddresses: known,
    });
  }, [validation?.valid, validation?.normalized, networkId, from, ownAccounts, known]);
  const blocked = blockingFindings(findings).length > 0;

  const error =
    validation && !validation.valid
      ? validation.reason === 'checksum'
        ? 'This address has an invalid checksum. Check for typos.'
        : 'Enter a valid address (0x followed by 40 characters).'
      : null;

  return (
    <div className="flex flex-1 flex-col">
      <label htmlFor="recipient" className="mb-2 text-sm font-medium text-muted">
        Recipient address
      </label>
      <div className={`flex items-start gap-2 rounded-2xl border bg-surface px-4 py-3 transition-colors focus-within:border-primary ${error ? 'border-danger' : 'border-line-strong'}`}>
        <textarea
          id="recipient"
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-invalid={!!error}
          aria-describedby="recipient-help"
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
      <div id="recipient-help" className="min-h-6 pt-2 text-sm" aria-live="polite">
        {error && <span className="text-danger">{error}</span>}
      </div>

      {validation?.valid && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={t.base} className="mb-3 flex items-center gap-3 rounded-2xl bg-sunken p-3">
          <Identicon address={validation.normalized!} size={36} />
          <ChunkedAddress address={validation.normalized!} className="min-w-0" />
        </motion.div>
      )}
      <RiskList findings={findings} />

      {!trimmed && ownAccounts.length > 0 && (
        <section className="mt-2">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">Your accounts</h2>
          {ownAccounts.map((a) => (
            <button key={a.index} type="button" onClick={() => onChange(a.address)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-surface-hover">
              <Identicon address={a.address} size={32} />
              <span>
                <span className="block font-medium">{a.name}</span>
                <span className="block font-mono text-xs text-subtle">{shortAddress(a.address)}</span>
              </span>
            </button>
          ))}
        </section>
      )}

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
  asset,
  holding,
  value,
  onChange,
  from,
  to,
  onNext,
}: {
  asset: Asset;
  holding: ValuedHolding | null;
  value: string;
  onChange: (v: string) => void;
  from: string;
  to: string;
  onNext: () => void;
}) {
  const adapter = useAdapter();
  const network = useNetwork();
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
    if (asset.kind !== 'native') {
      onChange(formatUnits(balance, asset.decimals));
      return;
    }
    setMaxLoading(true);
    try {
      const q = await adapter.estimateFee({ from, to, asset, amount: balance });
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

function ReviewAndSend(props: {
  asset: Asset;
  from: string;
  accountIndex: number;
  accountName: string;
  accountApiId: string | undefined;
  to: string;
  amount: bigint;
  tier: FeeTier;
  onTier: (t: FeeTier) => void;
  knownRecipients: string[];
  onStatus: () => void;
  onEdit: () => void;
}) {
  const { asset, from, to, amount, tier } = props;
  const adapter = useAdapter();
  const network = useNetwork();
  const qc = useQueryClient();
  const router = useRouter();
  const upsertLocalTx = useMeta((s) => s.upsertLocalTx);
  const rememberRecipient = useMeta((s) => s.rememberRecipient);
  const nativePriceRef = network.nativeCurrency.priceRef;
  const prices = usePrices([asset.priceRef, nativePriceRef].filter(Boolean) as string[]);
  const [state, dispatch] = useReducer(sendReducer, initialSendState);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [feeSheet, setFeeSheet] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const aborter = useRef<AbortController | null>(null);

  const prepare = useCallback(async () => {
    dispatch({ type: 'ESTIMATE' });
    try {
      const intent = { from, to, asset, amount };
      const quote = await adapter.estimateFee(intent);
      const unsigned = await adapter.buildTransaction(intent, quote.options[tier]);
      const review = adapter.describe(unsigned);
      // Token is bound to exactly these bytes inside the KeyWorker (threat T7).
      const token = await vault.call('issueConfirmation', { payload: adapter.signingPayload(unsigned) });
      setPrepared({ unsigned, review, token, quote });
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

  const review = prepared?.review;
  const nativeAsset = adapter.listAssets()[0]!;
  const nativeBalance = useValuedHoldings(from).valued?.find((h) => h.asset.kind === 'native')?.balance ?? null;
  const findings: RiskFinding[] = useMemo(() => {
    if (!review) return [];
    const recipient = assessRecipient({
      networkId: network.id,
      from,
      to: review.to,
      ownAccounts: new Map(useMeta.getState().accounts.map((a) => [a.address.toLowerCase(), a.name])),
      knownAddresses: props.knownRecipients,
    }).filter((f) => f.code !== 'FIRST_TIME_RECIPIENT' && f.code !== 'OWN_ACCOUNT');
    const fee = assessFee({
      maxFee: review.maxFee,
      feeWarningNative: parseUnits(network.feeWarningNative, network.nativeCurrency.decimals),
      amount: review.amount,
      isNativeTransfer: review.asset.kind === 'native',
    });
    return [...recipient, ...fee, ...assessNonce(prepared?.unsigned.warnings ?? [])];
  }, [review, network, from, props.knownRecipients, prepared]);

  const insufficientForFee =
    review && nativeBalance !== null && nativeBalance < review.maxFee + (review.asset.kind === 'native' ? review.amount : 0n);
  const needAck = findings.filter((f) => f.requiresAck && !acks[f.code]);
  const blocked = blockingFindings(findings).length > 0;

  const fiat = (value: bigint, a: Asset) => {
    const p = a.priceRef ? prices.data?.[a.priceRef]?.usd : undefined;
    return p ? formatUsdCents(toUsdCents(value, a.decimals, p)) : null;
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
      rememberRecipient(from, prepared.review.to);
      const local = {
        hash,
        networkId: network.id,
        from,
        to: prepared.review.to,
        assetId: prepared.review.asset.id,
        amount: prepared.review.amount.toString(),
        status: 'pending' as const,
        createdAt: Date.now(),
        nonce: prepared.unsigned.tx.nonce,
      };
      upsertLocalTx(local);
      if (props.accountApiId && useSession.getState().apiOnline) {
        void getApi()
          .then((api) => api.trackTransaction({ networkId: network.id, hash, accountId: props.accountApiId!, from, to: local.to, assetId: local.assetId, amount: local.amount, nonce: local.nonce }))
          .catch(() => undefined);
      }
      aborter.current = new AbortController();
      const final = await adapter.waitForFinal(hash, { signal: aborter.current.signal });
      upsertLocalTx({ ...local, status: final.status, ...(final.fee !== undefined ? { fee: final.fee.toString() } : {}) });
      void qc.invalidateQueries({ queryKey: ['holdings'] });
      if (final.status === 'confirmed') {
        dispatch({ type: 'TX_CONFIRMED' });
        toast.success('Transaction confirmed', `${formatDisplay(prepared.review.amount, asset.decimals)} ${asset.symbol} sent`);
        navigator.vibrate?.([10, 40, 10]);
      } else if (final.status === 'failed') {
        dispatch({ type: 'TX_FAILED', error: mapError(new Error('execution reverted'), 'track') });
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
        amountText={review ? `${formatDisplay(review.amount, review.asset.decimals, 8)} ${review.asset.symbol}` : ''}
        to={review?.to ?? to}
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

  return (
    <div className="flex flex-1 flex-col">
      {!review ? (
        <div className="space-y-3" aria-busy="true" aria-label="Preparing transaction">
          <Skeleton className="mx-auto h-10 w-40" />
          <Skeleton className="h-48 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
        </div>
      ) : (
        <>
          <div className="mb-5 text-center">
            <TokenIcon symbol={review.asset.symbol} size={48} />
            <div className="tabular mt-3 text-3xl font-bold">
              {formatDisplay(review.amount, review.asset.decimals, 8)} {review.asset.symbol}
            </div>
            <div className="tabular text-sm text-muted">{fiat(review.amount, review.asset) ?? ''}</div>
          </div>

          <dl className="mb-4 divide-y divide-line rounded-2xl border border-line bg-surface">
            <ReviewRow label="From">
              <span className="flex items-center justify-end gap-2">
                <Identicon address={review.from} size={20} />
                <span>
                  <span className="block font-semibold">{props.accountName}</span>
                  <span className="block font-mono text-xs text-subtle">{shortAddress(review.from)}</span>
                </span>
              </span>
            </ReviewRow>
            <ReviewRow label="To">
              <span className="flex items-start justify-end gap-2">
                <Identicon address={review.to} size={20} />
                <ChunkedAddress address={review.to} className="max-w-[210px] text-right" />
              </span>
            </ReviewRow>
            <ReviewRow label="Asset">{review.asset.name}</ReviewRow>
            <ReviewRow label="Network">
              <span className="inline-flex items-center gap-1.5">
                <NetworkDot network={network} size={16} /> {network.name}
                {network.kind !== 'mainnet' && <span className="rounded bg-warning-soft px-1.5 text-[10px] font-semibold text-warning">{network.kind === 'testnet' ? 'Testnet' : 'Local'}</span>}
              </span>
            </ReviewRow>
            <ReviewRow label="Network fee">
              <button type="button" onClick={() => setFeeSheet(true)} className="text-right">
                <span className="tabular block font-semibold">
                  {formatDisplay(prepared!.quote.options[tier].estimatedFee, 18, 6)} {network.nativeCurrency.symbol}
                </span>
                <span className="block text-xs text-primary">
                  {tierLabel(tier)} · ~{prepared!.quote.options[tier].etaSeconds}s · Edit
                </span>
              </button>
            </ReviewRow>
            <ReviewRow label="Total" strong>
              {review.asset.kind === 'native' ? (
                <span className="tabular">
                  {formatDisplay(review.amount + prepared!.quote.options[tier].estimatedFee, 18, 8)} {review.asset.symbol}
                  <span className="block text-xs font-normal text-muted">{fiat(review.amount + prepared!.quote.options[tier].estimatedFee, review.asset) ?? ''}</span>
                </span>
              ) : (
                <span className="tabular">
                  {formatDisplay(review.amount, review.asset.decimals, 8)} {review.asset.symbol}
                  <span className="block text-xs font-normal text-muted">
                    + {formatDisplay(prepared!.quote.options[tier].estimatedFee, 18, 6)} {network.nativeCurrency.symbol} fee
                  </span>
                </span>
              )}
            </ReviewRow>
          </dl>

          <button type="button" onClick={() => setShowDetails((s) => !s)} className="mb-3 self-start text-xs font-medium text-muted hover:text-ink">
            {showDetails ? 'Hide' : 'Show'} technical details
          </button>
          {showDetails && (
            <div className="mb-4 space-y-1 rounded-xl bg-sunken p-3 font-mono text-[11px] text-muted">
              <div>chainId: {prepared!.unsigned.tx.chainId}</div>
              <div>nonce: {prepared!.unsigned.tx.nonce}</div>
              <div>gas limit: {prepared!.unsigned.tx.gas.toString()}</div>
              <div>max fee: {formatUnits(review.maxFee, 18)} {network.nativeCurrency.symbol}</div>
              {prepared!.unsigned.warnings.length > 0 && <div className="text-warning">nonce warnings: {prepared!.unsigned.warnings.join(', ')}</div>}
            </div>
          )}

          {insufficientForFee && (
            <div className="mb-3 flex gap-2 rounded-xl bg-danger-soft p-3 text-sm" role="alert">
              <XCircle size={18} className="mt-0.5 shrink-0 text-danger" />
              Not enough {network.nativeCurrency.symbol} to cover the amount and the maximum network fee.
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

      <FeeSheet
        open={feeSheet}
        onOpenChange={setFeeSheet}
        quote={prepared?.quote}
        tier={tier}
        symbol={network.nativeCurrency.symbol}
        fiat={(v) => fiat(v, nativeAsset)}
        onPick={(tr) => {
          props.onTier(tr);
          setFeeSheet(false);
        }}
      />
    </div>
  );
}

function tierLabel(t: FeeTier) {
  return t === 'low' ? 'Low' : t === 'market' ? 'Market' : 'Aggressive';
}

function FeeSheet({
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
  quote: FeeQuote<EvmFeeParams> | undefined;
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
                  <span className="block text-xs text-muted">~{o?.etaSeconds ?? '—'} sec</span>
                </span>
                <span className="tabular text-right text-sm">
                  <span className="block font-semibold">{o ? `${formatDisplay(o.estimatedFee, 18, 6)} ${symbol}` : '—'}</span>
                  <span className="block text-xs text-muted">{o ? `max ${formatDisplay(o.maxFee, 18, 6)}${fiat(o.estimatedFee) ? ` · ${fiat(o.estimatedFee)}` : ''}` : ''}</span>
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

function ReviewRow({ label, children, strong }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3.5 text-sm">
      <dt className="shrink-0 pt-0.5 text-muted">{label}</dt>
      <dd className={`min-w-0 text-right ${strong ? 'text-base font-bold' : 'font-medium'}`}>{children}</dd>
    </div>
  );
}

function RiskList({ findings, acks, onAck }: { findings: RiskFinding[]; acks?: Record<string, boolean>; onAck?: (code: string) => void }) {
  if (findings.length === 0) return null;
  return (
    <ul className="space-y-2">
      {findings.map((f) => {
        const tone = f.severity === 'block' ? 'bg-danger-soft' : f.severity === 'warning' ? 'bg-warning-soft' : 'bg-sunken';
        const Icon = f.severity === 'info' ? Info : AlertTriangle;
        return (
          <motion.li key={f.code} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={t.base} className={`rounded-xl p-3 text-sm ${tone}`} role={f.severity === 'info' ? undefined : 'alert'}>
            <div className="flex gap-2">
              <Icon size={18} className={`mt-0.5 shrink-0 ${f.severity === 'block' ? 'text-danger' : f.severity === 'warning' ? 'text-warning' : 'text-muted'}`} />
              <div>
                <div className="font-semibold">{f.title}</div>
                <div className="text-muted">{f.message}</div>
                {f.lookalikeOf && (
                  <div className="mt-1 text-xs text-muted">
                    Looks like: <span className="font-mono">{shortAddress(f.lookalikeOf, 10, 8)}</span>
                  </div>
                )}
              </div>
            </div>
            {f.requiresAck && onAck && (
              <label className="mt-2 flex cursor-pointer items-center gap-2 pl-6 font-medium">
                <input type="checkbox" checked={!!acks?.[f.code]} onChange={() => onAck(f.code)} className="h-4 w-4 accent-[var(--qd-primary)]" />
                I understand the risk
              </label>
            )}
          </motion.li>
        );
      })}
    </ul>
  );
}

function ErrorPanel({ error, onRetry, onEdit }: { error: WalletError; onRetry?: () => void; onEdit: () => void }) {
  const [details, setDetails] = useState(false);
  return (
    <div className="flex flex-1 flex-col items-center pt-6 text-center">
      <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={t.emphasis} className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-danger-soft text-danger">
        <XCircle size={32} />
      </motion.div>
      <h2 className="text-xl font-bold">{error.userTitle}</h2>
      <p className="mt-2 max-w-xs text-muted">{error.userMessage}</p>
      {error.technical && (
        <>
          <button type="button" onClick={() => setDetails((d) => !d)} className="mt-4 text-xs font-medium text-muted hover:text-ink">
            {details ? 'Hide' : 'Show'} details
          </button>
          {details && <pre className="mt-2 max-h-32 w-full overflow-auto whitespace-pre-wrap break-all rounded-xl bg-sunken p-3 text-left font-mono text-[11px] text-muted">{error.technical}</pre>}
        </>
      )}
      <div className="mt-auto grid w-full grid-cols-2 gap-3 pt-6">
        <Button variant="secondary" size="lg" onClick={onEdit}>
          Edit
        </Button>
        <Button size="lg" onClick={onRetry} disabled={!onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

function StatusView({
  status,
  error,
  hash,
  amountText,
  to,
  onDone,
  onActivity,
}: {
  status: string;
  error: WalletError | undefined;
  hash: string | undefined;
  amountText: string;
  to: string;
  onDone: () => void;
  onActivity: () => void;
}) {
  const network = useNetwork();
  const phase =
    status === 'confirmed' ? 'success' : status === 'failed' || status === 'error' || status === 'rejected' ? 'failure' : 'progress';
  const title =
    status === 'signing'
      ? 'Signing…'
      : status === 'broadcasting'
        ? 'Submitting…'
        : status === 'pending'
          ? 'Transaction submitted'
          : status === 'confirmed'
            ? 'Transaction confirmed'
            : status === 'rejected'
              ? 'Transaction cancelled'
              : error?.userTitle ?? 'Transaction failed';
  const subtitle =
    status === 'pending'
      ? `Waiting for ${network.name} to confirm. You can safely leave this screen.`
      : status === 'confirmed'
        ? `${amountText} sent to ${shortAddress(to)}`
        : status === 'rejected'
          ? 'Nothing was sent.'
          : phase === 'failure'
            ? error?.userMessage
            : 'Keep this screen open.';

  return (
    <div className="flex flex-1 flex-col items-center pt-16 text-center" role="status" aria-live="polite">
      <div className="relative mb-6 flex h-24 w-24 items-center justify-center">
        <AnimatePresence mode="wait">
          {phase === 'progress' && (
            <motion.div key="p" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={t.base} className="absolute inset-0">
              <svg viewBox="0 0 96 96" className="h-full w-full animate-spin [animation-duration:1.4s]">
                <circle cx="48" cy="48" r="42" fill="none" stroke="var(--qd-primary-soft)" strokeWidth="6" />
                <path d="M48 6a42 42 0 0 1 42 42" fill="none" stroke="var(--qd-primary)" strokeWidth="6" strokeLinecap="round" />
              </svg>
            </motion.div>
          )}
          {phase === 'success' && (
            <motion.div key="s" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={t.emphasis} className="absolute inset-0 flex items-center justify-center rounded-full bg-success text-white">
              <motion.svg viewBox="0 0 24 24" width="44" height="44">
                <motion.path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.35, delay: 0.15 }} />
              </motion.svg>
            </motion.div>
          )}
          {phase === 'failure' && (
            <motion.div key="f" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={t.emphasis} className={`absolute inset-0 flex items-center justify-center rounded-full ${status === 'rejected' ? 'bg-sunken text-muted' : 'bg-danger text-white'}`}>
              <X size={44} strokeWidth={2.6} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={status} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={t.fast}>
          <h2 className="text-2xl font-bold">{title}</h2>
          {subtitle && <p className="mx-auto mt-2 max-w-xs text-muted">{subtitle}</p>}
        </motion.div>
      </AnimatePresence>
      {hash && network.explorer && (
        <a href={network.explorer.txUrl(hash)} target="_blank" rel="noopener noreferrer" className="mt-4 text-sm font-semibold text-primary hover:underline">
          View on {network.explorer.name}
        </a>
      )}
      <div className="mt-auto grid w-full grid-cols-2 gap-3 pt-8">
        <Button variant="secondary" size="lg" onClick={onActivity} disabled={phase === 'progress' && status !== 'pending'}>
          View activity
        </Button>
        <Button size="lg" onClick={onDone} disabled={phase === 'progress' && status !== 'pending'}>
          Done
        </Button>
      </div>
    </div>
  );
}
