'use client';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ExternalLink, Eye, EyeOff, RefreshCw, Repeat } from 'lucide-react';
import Link from 'next/link';
import { formatDisplay, formatUsdCents, isWalletError, type Network } from '@qd/blockchain';
import { useMeta } from '@/lib/store';
import { useChainStatus, type ValuedHolding } from '@/lib/hooks';
import { Skeleton } from '../ui/spinner';
import { t } from '../ui/motion';
import { NetworkDot } from './network-sheet';

/** Eases a displayed number toward the target; used for balance count-up. */
function useCountUp(target: number, ms = 600): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    if (origin === target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = target;
      setValue(target);
      return;
    }
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(origin + (target - origin) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

export function BalanceHero({
  valued,
  totalCents,
  loading,
  error,
  fetching,
  onRefresh,
  network,
  address,
}: {
  valued: ValuedHolding[] | undefined;
  totalCents: bigint | null;
  loading: boolean;
  error: boolean;
  fetching: boolean;
  onRefresh: () => void;
  network: Network;
  /** The account whose balance is shown; same address the RPC query uses. */
  address: string | undefined;
}) {
  const nativeSymbol = network.nativeCurrency.symbol;
  const hidden = useMeta((s) => s.hideBalances);
  const toggle = useMeta((s) => s.toggleHideBalances);
  const native = valued?.find((h) => h.asset.kind === 'native');
  const chain = useChainStatus();
  const chainError = isWalletError(chain.error) ? chain.error : null;
  const showFiat = totalCents !== null && (valued?.some((h) => h.usdCents !== null) ?? false);
  const cents = useCountUp(showFiat ? Number(totalCents) : 0);

  let primary: React.ReactNode;
  if (loading)
    primary = (
      <span role="status" className="flex flex-col items-center gap-2">
        <Skeleton className="mx-auto h-12 w-48 rounded-xl" />
        <span className="text-sm font-normal text-muted">Loading balance...</span>
      </span>
    );
  else if (error && !valued)
    primary = <span className="text-2xl font-semibold text-muted">{chainError?.code === 'CHAIN_MISMATCH' ? 'Wrong network' : `Unable to load ${network.shortName} balance`}</span>;
  else if (hidden) primary = <span aria-label="Balance hidden">••••••</span>;
  else if (showFiat) primary = formatUsdCents(BigInt(Math.round(cents)));
  else primary = `${formatDisplay(native?.balance ?? 0n, native?.asset.decimals ?? 18, 5)} ${nativeSymbol}`;

  return (
    <section aria-label="Total balance" className="flex flex-col items-center py-6 text-center">
      <div className="mb-1 flex items-center gap-1 text-sm text-muted">
        <span>{showFiat ? 'Total balance' : 'Balance'}</span>
        <button type="button" onClick={toggle} aria-label={hidden ? 'Show balances' : 'Hide balances'} className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-surface-hover">
          {hidden ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
        <button type="button" onClick={onRefresh} aria-label="Refresh balances" className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-surface-hover">
          <motion.span animate={{ rotate: fetching ? 360 : 0 }} transition={fetching ? { repeat: Infinity, duration: 0.9, ease: 'linear' } : t.fast} className="inline-flex">
            <RefreshCw size={14} />
          </motion.span>
        </button>
      </div>
      <div className="tabular text-[40px] font-bold leading-tight tracking-tight" aria-live="polite">
        {primary}
      </div>
      {showFiat && !hidden && native && (
        <div className="tabular mt-1 text-sm text-muted">
          {formatDisplay(native.balance ?? 0n, native.asset.decimals, 5)} {nativeSymbol}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5 text-[13px] text-muted">
        <NetworkDot network={network} size={14} />
        <span>{network.name}</span>
        {chain.data && (
          <span className="tabular" title="Latest block">
            · #{chain.data.blockNumber.toLocaleString()}
          </span>
        )}
        {chainError && <span className="text-danger">· {chainError.userTitle}</span>}
        {address && network.explorer && (
          <>
            <span aria-hidden>·</span>
            <a href={network.explorer.addressUrl(address)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
              Open in Explorer <ExternalLink size={12} />
            </a>
          </>
        )}
      </div>
    </section>
  );
}

export function ActionRow({ onReceive }: { onReceive: () => void }) {
  return (
    <div className="mb-6 grid grid-cols-4 gap-2">
      <Action href="/send" icon={<ArrowUpRight size={22} />} label="Send" primary />
      <Action onClick={onReceive} icon={<ArrowDownLeft size={22} />} label="Receive" />
      <Action icon={<Repeat size={20} />} label="Swap" soon />
      <Action icon={<ArrowLeftRight size={20} />} label="Bridge" soon />
    </div>
  );
}

function Action({ href, onClick, icon, label, primary, soon }: { href?: string; onClick?: () => void; icon: React.ReactNode; label: string; primary?: boolean; soon?: boolean }) {
  const circle = `flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
    soon ? 'bg-sunken text-subtle' : primary ? 'bg-primary text-on-primary group-hover:bg-primary-hover' : 'bg-primary-soft text-primary group-hover:brightness-95'
  }`;
  const inner = (
    <>
      <motion.span whileTap={soon ? undefined : { scale: 0.92 }} transition={t.instant} className={circle}>
        {icon}
      </motion.span>
      <span className={`text-[13px] font-medium ${soon ? 'text-subtle' : ''}`}>{label}</span>
    </>
  );
  const cls = 'group flex flex-col items-center gap-1.5 rounded-2xl py-1 outline-none';
  if (soon)
    return (
      <span className={`${cls} cursor-not-allowed`} title={`${label} is coming soon`} aria-disabled="true" role="button" tabIndex={0}>
        {inner}
      </span>
    );
  if (href)
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    );
  return (
    <button type="button" onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[] }) {
  return (
    <div role="tablist" className="relative mb-2 flex border-b border-line">
      {items.map((i) => (
        <button
          key={i.value}
          role="tab"
          type="button"
          aria-selected={value === i.value}
          onClick={() => onChange(i.value)}
          className={`relative flex-1 pb-3 pt-1 text-[15px] font-semibold transition-colors ${value === i.value ? 'text-ink' : 'text-subtle hover:text-muted'}`}
        >
          {i.label}
          <AnimatePresence>{value === i.value && <motion.span layoutId="tabs-underline" className="absolute inset-x-6 -bottom-px h-0.5 rounded-full bg-primary" transition={t.snappy} />}</AnimatePresence>
        </button>
      ))}
    </div>
  );
}
