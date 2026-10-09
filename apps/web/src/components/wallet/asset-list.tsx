'use client';
import { motion } from 'motion/react';
import { AlertCircle } from 'lucide-react';
import { formatDisplay, formatUsdCents } from '@qd/blockchain';
import type { ValuedHolding } from '@/lib/hooks';
import { useMeta } from '@/lib/store';
import { Button } from '../ui/button';
import { TokenIcon } from '../ui/identity';
import { Skeleton } from '../ui/spinner';
import { t } from '../ui/motion';

export function AssetList({
  valued,
  loading,
  error,
  onRetry,
  onSelect,
}: {
  valued: ValuedHolding[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onSelect?: (h: ValuedHolding) => void;
}) {
  const hidden = useMeta((s) => s.hideBalances);

  if (loading) {
    return (
      <ul aria-busy="true" aria-label="Loading assets">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex items-center gap-3 py-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-4 w-16" />
          </li>
        ))}
      </ul>
    );
  }

  if (error && !valued) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <AlertCircle className="text-warning" size={28} />
        <div>
          <p className="font-semibold">Couldn’t load balances</p>
          <p className="text-sm text-muted">The network didn’t respond. Your funds are not affected.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  const list = (valued ?? []).filter((h) => h.asset.kind === 'native' || (h.balance ?? 0n) > 0n);

  return (
    <ul>
      {list.map((h, i) => (
        <motion.li key={h.asset.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...t.base, delay: i * 0.03 }}>
          <button
            type="button"
            onClick={() => onSelect?.(h)}
            className="-mx-2 flex w-[calc(100%+16px)] items-center gap-3 rounded-2xl px-2 py-3 text-left hover:bg-surface-hover"
          >
            <TokenIcon symbol={h.asset.symbol} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 font-semibold">
                {h.asset.name}
                {!h.asset.verified && <span className="rounded bg-warning-soft px-1.5 text-[10px] font-semibold text-warning">Unverified</span>}
              </span>
              <span className="tabular block text-sm text-muted">
                {hidden ? '••••' : h.balance === null ? '—' : `${formatDisplay(h.balance, h.asset.decimals)} ${h.asset.symbol}`}
              </span>
            </span>
            <span className="tabular text-right font-semibold">{hidden ? '••••' : h.usdCents !== null ? formatUsdCents(h.usdCents) : ''}</span>
          </button>
        </motion.li>
      ))}
      {list.length === 1 && (list[0]?.balance ?? 0n) === 0n && (
        <li className="mt-2 rounded-2xl border border-dashed border-line px-4 py-5 text-center text-sm text-muted">
          Your wallet is empty. Tap <strong>Receive</strong> to get your address.
        </li>
      )}
    </ul>
  );
}
