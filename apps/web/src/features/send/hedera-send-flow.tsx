'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, Check, ClipboardPaste, ExternalLink, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { AccountMeta } from '@/lib/store';
import { useMeta, useSelectedAccount, toast } from '@/lib/store';
import { getApi } from '@/lib/api';
import { createStaleGuard, describeHederaError, findRemoteAccount, readLinkedHederaAccount, type StaleGuard } from '@/lib/hedera-link';
import {
  buildAndSubmitHbarTransfer,
  getHederaAccountBalance,
  hederaTransactionExplorerUrl,
  HederaTransferError,
  isSuccessfulHederaReceipt,
  tinybarsToHbarDisplay,
} from '@/lib/hedera-transfer';
import {
  assessHbarSendAmount,
  HBAR_TRANSFER_FEE_BUFFER_TINYBARS,
  HBAR_TRANSFER_FEE_LABEL,
  parseHbarAmount,
  validateHederaRecipient,
} from '@/lib/hedera-send';
import { Button } from '@/components/ui/button';
import { stepVariants, t } from '@/components/ui/motion';
import { ReviewRow } from './send-flow';

type Step = 'recipient' | 'amount' | 'review';
const ORDER: Step[] = ['recipient', 'amount', 'review'];

interface Balance {
  tinybars: bigint;
  hbar: string;
}

type Submission =
  | {
      kind: 'success';
      transactionId: string;
      status: string;
      amountTinybars: bigint;
      updatedBalance: Balance | null;
    }
  | {
      kind: 'failure';
      title: string;
      message: string;
      transactionId?: string;
      status?: string;
    };

/**
 * Three-step Hedera HBAR send flow: recipient → amount → review/status.
 *
 * The selected HD account is the sender. Its linked Hedera Account ID is
 * resolved from the same HD index that is passed to the KeyWorker, and the
 * KeyWorker signs with the derived key for that index. No key material, payer
 * key or recovery phrase ever enters this component.
 */
export function HederaSendFlow() {
  const router = useRouter();
  const qc = useQueryClient();
  const account = useSelectedAccount();
  const hederaAccountIds = useMeta((s) => s.hederaAccountIds);
  const fromAccountId = readLinkedHederaAccount(hederaAccountIds, account?.index) ?? null;

  const [step, setStep] = useState<Step>('recipient');
  const [dir, setDir] = useState(1);
  const [toAccountId, setToAccountId] = useState('');
  const [amountHbar, setAmountHbar] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submission, setSubmission] = useState<Submission | null>(null);

  // One guard for every balance read: a response for a previous account must
  // never overwrite the current account's balance.
  const balanceGuardRef = useRef<StaleGuard | null>(null);
  if (balanceGuardRef.current === null) balanceGuardRef.current = createStaleGuard();

  const refreshBalance = useCallback(async (): Promise<Balance | null> => {
    if (!fromAccountId) return null;
    const guard = balanceGuardRef.current!;
    const token = guard.begin();
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const next = await getHederaAccountBalance(fromAccountId);
      if (guard.isCurrent(token)) setBalance(next);
      return next;
    } catch (error) {
      if (guard.isCurrent(token)) {
        setBalance(null);
        setBalanceError(describeHederaError(error, 'transfer').description);
      }
      return null;
    } finally {
      if (guard.isCurrent(token)) setBalanceLoading(false);
    }
  }, [fromAccountId]);

  // Switching accounts invalidates the old flow state and reloads the balance.
  useEffect(() => {
    balanceGuardRef.current!.invalidate();
    setStep('recipient');
    setToAccountId('');
    setAmountHbar('');
    setAmountError(null);
    setSubmission(null);
    void refreshBalance();
  }, [account?.index, fromAccountId, refreshBalance]);

  const go = (next: Step) => {
    setDir(ORDER.indexOf(next) >= ORDER.indexOf(step) ? 1 : -1);
    setStep(next);
  };

  const back = () => {
    if (step === 'recipient') router.back();
    else if (step === 'amount') go('recipient');
    else if (step === 'review' && !submitting) go('amount');
  };

  const submit = useCallback(async () => {
    if (!account || !fromAccountId || submitting) return;

    // Fast local check against the last known balance.
    const precheck = assessHbarSendAmount(amountHbar, balance?.tinybars ?? null);
    if (precheck.error !== null || precheck.tinybars === undefined) {
      setAmountError(precheck.error);
      setDir(-1);
      setStep('amount');
      return;
    }

    setSubmitting(true);
    setSubmission(null);
    try {
      // Re-read the balance immediately before signing so a stale cache cannot
      // let an unaffordable transfer reach the network.
      const fresh = await refreshBalance();
      if (!fresh) {
        throw new Error('Could not read your HBAR balance. Check your connection and try again.');
      }
      const check = assessHbarSendAmount(amountHbar, fresh.tinybars);
      if (check.error !== null || check.tinybars === undefined) {
        setAmountError(check.error);
        setDir(-1);
        setStep('amount');
        return;
      }

      const accountApiId = await resolveAccountApiId(account);
      const { transactionId, status } = await buildAndSubmitHbarTransfer({
        fromAccountId,
        toAccountId: toAccountId.trim(),
        amountTinybars: check.tinybars,
        hdIndex: account.index,
        accountApiId,
      });

      if (!isSuccessfulHederaReceipt(status)) {
        throw new Error(`Hedera transaction ${transactionId} failed with status ${status}`);
      }

      // The refreshed balance is the post-transfer value, not a cached one.
      const updatedBalance = await getHederaAccountBalance(fromAccountId).catch(() => null);
      if (updatedBalance) setBalance(updatedBalance);

      setSubmission({
        kind: 'success',
        transactionId,
        status,
        amountTinybars: check.tinybars,
        updatedBalance,
      });
      toast.success(
        'HBAR transfer confirmed',
        `${tinybarsToHbarDisplay(check.tinybars)} HBAR sent to ${toAccountId.trim()}`,
      );
      void qc.invalidateQueries({ queryKey: ['holdings'] });
      // Mirror Node is eventually consistent: a confirmed transaction usually
      // takes 2–10 s to be indexed. Invalidating immediately would trigger a
      // refetch before the new entry is visible, returning the stale list and
      // replacing it as the cached result.  Waiting 6 s lets the Mirror Node
      // index the transaction before we force a fresh fetch.
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['activity'] }), 6_000);
    } catch (error) {
      const info = describeHederaError(error, 'transfer');
      const transactionId =
        error instanceof HederaTransferError ? error.transactionId : undefined;
      const status = error instanceof HederaTransferError ? error.status : undefined;
      setSubmission({
        kind: 'failure',
        title: info.title,
        message: info.description,
        ...(transactionId ? { transactionId } : {}),
        ...(status ? { status } : {}),
      });
      toast.error(info.title, info.description);
    } finally {
      setSubmitting(false);
    }
  }, [
    account,
    fromAccountId,
    submitting,
    amountHbar,
    balance,
    toAccountId,
    refreshBalance,
    qc,
  ]);

  if (!account) return null;

  if (!fromAccountId) {
    return (
      <div className="flex min-h-[calc(100dvh-120px)] flex-col">
        <div className="mb-4 flex items-center justify-between">
          <button type="button" onClick={() => router.back()} aria-label="Back" className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-surface-hover">
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-lg font-semibold">Send HBAR</h1>
          <button type="button" onClick={() => router.push('/home')} aria-label="Cancel" className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-surface-hover">
            <X size={20} />
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <h2 className="text-xl font-semibold">No Hedera account linked</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            This wallet account does not have a Hedera Testnet account linked yet. Open
            Receive on Home to create or link one, then return here to send HBAR.
          </p>
          <div className="mt-6 w-full max-w-sm">
            <Button block size="lg" onClick={() => router.push('/home')}>
              Go to Home
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (submission) {
    return (
      <SubmitStatus
        submission={submission}
        toAccountId={toAccountId.trim()}
        onDone={() => router.push('/home')}
        onRetry={() => {
          setSubmission(null);
          setAmountError(null);
          go('review');
        }}
      />
    );
  }

  const titles: Record<Step, string> = {
    recipient: 'Send to',
    amount: 'Amount',
    review: 'Review',
  };

  return (
    <div className="flex min-h-[calc(100dvh-120px)] flex-col">
      <div className="mb-4 flex items-center justify-between">
        <button type="button" onClick={back} aria-label="Back" className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-surface-hover">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-lg font-semibold">{titles[step]}</h1>
        <button type="button" onClick={() => router.push('/home')} aria-label="Cancel" className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-surface-hover">
          <X size={20} />
        </button>
      </div>

      {/* Testnet warning badge */}
      <div className="mb-3 flex items-center justify-center">
        <span className="rounded bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">Testnet</span>
      </div>

      <AnimatePresence mode="wait" custom={dir} initial={false}>
        <motion.div key={step} custom={dir} variants={stepVariants} initial="enter" animate="center" exit="exit" transition={t.base} className="flex flex-1 flex-col">
          {step === 'recipient' && (
            <RecipientStep
              value={toAccountId}
              onChange={setToAccountId}
              fromAccountId={fromAccountId}
              onNext={(id) => {
                setToAccountId(id);
                go('amount');
              }}
            />
          )}
          {step === 'amount' && (
            <AmountStep
              value={amountHbar}
              onChange={(v) => {
                setAmountHbar(v);
                setAmountError(null);
              }}
              balance={balance}
              balanceLoading={balanceLoading}
              balanceError={balanceError}
              onRetryBalance={() => void refreshBalance()}
              externalError={amountError}
              onNext={() => go('review')}
            />
          )}
          {step === 'review' && (
            <ReviewStep
              fromAccountId={fromAccountId}
              toAccountId={toAccountId.trim()}
              amountHbar={amountHbar}
              balance={balance}
              accountName={account.name}
              submitting={submitting}
              onConfirm={submit}
              onEdit={() => go('amount')}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------- helpers

/**
 * Resolves the backend account id used only to identify the signing account to
 * the KeyWorker. It is never used as a Hedera sender or fee payer.
 *
 * `apiId` is normally populated by sync, but a send can happen before the
 * background sync finishes; in that case look it up scoped to the selected
 * wallet instead of inventing a placeholder id.
 */
async function resolveAccountApiId(account: AccountMeta): Promise<string> {
  if (account.apiId) return account.apiId;
  const api = await getApi();
  await api.ensureSession();
  const { wallets } = await api.wallets();
  const remote = findRemoteAccount(wallets, useMeta.getState().walletApiId, account.index);
  useMeta.getState().setAccountApiId(account.index, remote.id);
  return remote.id;
}

// ---------------------------------------------------------------- recipient step

function RecipientStep({
  value,
  onChange,
  fromAccountId,
  onNext,
}: {
  value: string;
  onChange: (v: string) => void;
  fromAccountId: string;
  onNext: (id: string) => void;
}) {
  const trimmed = value.trim();
  const error = validateHederaRecipient(trimmed, fromAccountId);
  const isValid = trimmed !== '' && error === null;

  return (
    <div className="flex flex-1 flex-col">
      <label htmlFor="hedera-recipient" className="mb-2 text-sm font-medium text-muted">
        Recipient Account ID
      </label>
      <div className={`flex items-start gap-2 rounded-2xl border bg-surface px-4 py-3 transition-colors focus-within:border-primary ${error ? 'border-danger' : 'border-line-strong'}`}>
        <input
          id="hedera-recipient"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.0.…"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-invalid={!!error}
          aria-describedby="hedera-recipient-help"
          className="min-w-0 flex-1 bg-transparent font-mono text-[15px] outline-none placeholder:text-subtle"
        />
        {value ? (
          <button type="button" onClick={() => onChange('')} aria-label="Clear" className="text-subtle hover:text-ink">
            <X size={18} />
          </button>
        ) : (
          <button
            type="button"
            onClick={async () => {
              try {
                onChange((await navigator.clipboard.readText()).trim());
              } catch {
                toast.error("Couldn\u2019t read clipboard");
              }
            }}
            className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary"
          >
            <ClipboardPaste size={14} /> Paste
          </button>
        )}
      </div>
      <div id="hedera-recipient-help" className="min-h-6 pt-2 text-sm" aria-live="polite">
        {error && <span className="text-danger">{error}</span>}
      </div>
      <p className="text-xs text-subtle">
        From <span className="font-mono">{fromAccountId}</span>
      </p>

      <div className="mt-auto pt-6">
        <Button block size="lg" disabled={!isValid} onClick={() => onNext(trimmed)}>
          Continue
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- amount step

function AmountStep({
  value,
  onChange,
  balance,
  balanceLoading,
  balanceError,
  onRetryBalance,
  externalError,
  onNext,
}: {
  value: string;
  onChange: (v: string) => void;
  balance: Balance | null;
  balanceLoading: boolean;
  balanceError: string | null;
  onRetryBalance: () => void;
  externalError: string | null;
  onNext: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const assessment = assessHbarSendAmount(value, balance?.tinybars ?? null);
  const error = externalError ?? assessment.error;
  const hasValidAmount = value.trim() !== '' && assessment.error === null;
  const canContinue = hasValidAmount && !balanceLoading && balance !== null;

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-6 flex items-center justify-center gap-2 text-sm text-muted">
        HBAR on Hedera Testnet
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
              if (/^\d*\.?\d{0,8}$/.test(v)) onChange(v);
            }}
            placeholder="0"
            aria-label="Amount in HBAR"
            aria-invalid={!!error}
            className="tabular w-full min-w-[1ch] bg-transparent text-center text-5xl font-bold outline-none placeholder:text-line-strong"
            style={{ width: `${Math.max(1, value.length || 1) + 0.5}ch` }}
          />
          <span className="text-2xl font-semibold text-muted">HBAR</span>
        </div>
        <div className="mt-1 h-5 text-sm" aria-live="polite">
          {error && <span className="text-danger">{error}</span>}
        </div>

        <div className="mt-2 text-center text-xs text-muted">
          {balanceLoading ? (
            <span>Loading available balance…</span>
          ) : balance ? (
            <span>
              Available: <span className="tabular font-semibold">{balance.hbar} HBAR</span>
            </span>
          ) : balanceError ? (
            <button type="button" onClick={onRetryBalance} className="text-danger underline">
              Could not load balance. Retry
            </button>
          ) : (
            <span>Balance unavailable</span>
          )}
          <p className="mt-1 text-subtle">Network fee reserve: {HBAR_TRANSFER_FEE_LABEL}</p>
        </div>
      </div>

      <div className="mt-auto pt-6">
        <Button block size="lg" disabled={!canContinue} onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- review step

function ReviewStep({
  fromAccountId,
  toAccountId,
  amountHbar,
  balance,
  accountName,
  submitting,
  onConfirm,
  onEdit,
}: {
  fromAccountId: string;
  toAccountId: string;
  amountHbar: string;
  balance: Balance | null;
  accountName: string;
  submitting: boolean;
  onConfirm: () => Promise<void>;
  onEdit: () => void;
}) {
  const parsed = parseHbarAmount(amountHbar);
  const amountTinybars = parsed.tinybars ?? 0n;
  const remaining = balance
    ? balance.tinybars - amountTinybars - HBAR_TRANSFER_FEE_BUFFER_TINYBARS
    : null;

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-5 text-center">
        <div className="tabular mt-3 text-3xl font-bold">{tinybarsToHbarDisplay(amountTinybars)} HBAR</div>
      </div>

      <dl className="mb-4 divide-y divide-line rounded-2xl border border-line bg-surface">
        <ReviewRow label="From">
          <span>
            <span className="block font-semibold">{accountName}</span>
            <span className="block font-mono text-xs text-subtle">{fromAccountId}</span>
          </span>
        </ReviewRow>
        <ReviewRow label="To">
          <span className="font-mono">{toAccountId}</span>
        </ReviewRow>
        <ReviewRow label="Network">
          <span className="inline-flex items-center gap-1.5">
            Hedera Testnet
            <span className="rounded bg-warning-soft px-1.5 text-[10px] font-semibold text-warning">Testnet</span>
          </span>
        </ReviewRow>
        <ReviewRow label="Available balance">
          <span className="tabular">{balance ? `${balance.hbar} HBAR` : '—'}</span>
        </ReviewRow>
        <ReviewRow label="Network fee (reserve)">
          <span className="tabular font-semibold">{HBAR_TRANSFER_FEE_LABEL}</span>
        </ReviewRow>
        <ReviewRow label="Remaining after send">
          <span className="tabular">
            {remaining !== null && remaining >= 0n ? `${tinybarsToHbarDisplay(remaining)} HBAR` : '—'}
          </span>
        </ReviewRow>
      </dl>

      <div className="mt-auto grid grid-cols-2 gap-3 pt-4">
        <Button variant="secondary" size="lg" onClick={onEdit} disabled={submitting}>
          Edit
        </Button>
        <Button size="lg" onClick={() => void onConfirm()} loading={submitting} loadingText="Signing…">
          Confirm
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- submit status

function SubmitStatus({
  submission,
  toAccountId,
  onDone,
  onRetry,
}: {
  submission: Submission;
  toAccountId: string;
  onDone: () => void;
  onRetry: () => void;
}) {
  const success = submission.kind === 'success';
  const transactionId = submission.transactionId;
  const status = submission.status;

  return (
    <div className="flex flex-1 flex-col items-center pt-16 text-center" role="status" aria-live="polite">
      <div className="relative mb-6 flex h-24 w-24 items-center justify-center">
        {success ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-success text-white">
            <Check size={44} strokeWidth={2.6} />
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-danger text-white">
            <X size={44} strokeWidth={2.6} />
          </div>
        )}
      </div>

      <h2 className="text-2xl font-bold">
        {success ? 'Transaction confirmed' : submission.title}
      </h2>

      {success ? (
        <>
          <div className="tabular mt-3 text-3xl font-bold">
            {tinybarsToHbarDisplay(submission.amountTinybars)} HBAR
          </div>
          <dl className="mt-5 w-full max-w-sm divide-y divide-line rounded-2xl border border-line bg-surface text-left">
            <ReviewRow label="To">
              <span className="font-mono">{toAccountId}</span>
            </ReviewRow>
            <ReviewRow label="Status">
              <span className="font-semibold text-success">{submission.status}</span>
            </ReviewRow>
            <ReviewRow label="Transaction ID">
              <span className="font-mono text-xs break-all">{submission.transactionId}</span>
            </ReviewRow>
            {submission.updatedBalance && (
              <ReviewRow label="Updated balance">
                <span className="tabular">{submission.updatedBalance.hbar} HBAR</span>
              </ReviewRow>
            )}
          </dl>
        </>
      ) : (
        <>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">{submission.message}</p>
          {transactionId && (
            <dl className="mt-5 w-full max-w-sm divide-y divide-line rounded-2xl border border-line bg-surface text-left">
              <ReviewRow label="Transaction ID">
                <span className="font-mono text-xs break-all">{transactionId}</span>
              </ReviewRow>
              {status && (
                <ReviewRow label="Status">
                  <span className="font-semibold text-danger">{status}</span>
                </ReviewRow>
              )}
            </dl>
          )}
        </>
      )}

      {transactionId && (
        <a
          href={hederaTransactionExplorerUrl(transactionId)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
        >
          View on HashScan <ExternalLink size={13} />
        </a>
      )}

      <div className="mt-auto w-full pt-8">
        {success ? (
          <Button block size="lg" onClick={onDone}>
            Done
          </Button>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" size="lg" onClick={onRetry}>
              Try again
            </Button>
            <Button size="lg" onClick={onDone}>
              Done
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
