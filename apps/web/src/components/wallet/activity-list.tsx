'use client';
import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowDownLeft, ArrowUpRight, ExternalLink, RefreshCcw, ShieldAlert, XCircle } from 'lucide-react';
import { assetsForNetwork, formatDisplay, type Network } from '@qd/blockchain';
import type { ActivityItem } from '@qd/shared-types';
import { useMeta } from '@/lib/store';
import { ChunkedAddress, CopyButton, shortAddress } from '../ui/identity';
import { Sheet } from '../ui/sheet';
import { Skeleton, Spinner } from '../ui/spinner';
import { t } from '../ui/motion';

function assetOf(network: Network, assetId: string) {
  const all = assetsForNetwork(network);
  return all.find((a) => a.id === assetId) ?? all[0]!;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function ActivityList({ items, loading, network, emptyHint = true }: { items: ActivityItem[]; loading: boolean; network: Network; emptyHint?: boolean }) {
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<ActivityItem | null>(null);
  const hiddenCount = items.filter((i) => i.flags.includes('suspected_poisoning')).length;
  const visible = showHidden ? items : items.filter((i) => !i.flags.includes('suspected_poisoning'));

  const groups = useMemo(() => {
    const m = new Map<string, ActivityItem[]>();
    for (const i of visible) {
      const k = dayLabel(i.timestamp);
      m.set(k, [...(m.get(k) ?? []), i]);
    }
    return [...m.entries()];
  }, [visible]);

  if (loading) {
    return (
      <div aria-busy="true" className="space-y-4 py-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted">
        {emptyHint ? 'No transactions yet on this network.' : 'Nothing here yet.'}
        {hiddenCount > 0 && <HiddenToggle count={hiddenCount} shown={showHidden} onToggle={() => setShowHidden((s) => !s)} />}
      </div>
    );
  }

  return (
    <div>
      {groups.map(([day, list]) => (
        <section key={day} className="mb-2">
          <h3 className="py-2 text-xs font-semibold uppercase tracking-wide text-subtle">{day}</h3>
          <ul>
            {list.map((item) => (
              <motion.li key={item.hash} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={t.base}>
                <TxRow item={item} network={network} onClick={() => setSelected(item)} />
              </motion.li>
            ))}
          </ul>
        </section>
      ))}
      {hiddenCount > 0 && <HiddenToggle count={hiddenCount} shown={showHidden} onToggle={() => setShowHidden((s) => !s)} />}
      <TxDetailSheet item={selected} network={network} onClose={() => setSelected(null)} />
    </div>
  );
}

function HiddenToggle({ count, shown, onToggle }: { count: number; shown: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} className="mx-auto mt-3 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-muted hover:bg-surface-hover">
      <ShieldAlert size={14} /> {shown ? 'Hide' : 'Show'} {count} suspicious transfer{count > 1 ? 's' : ''}
    </button>
  );
}

function TxRow({ item, network, onClick }: { item: ActivityItem; network: Network; onClick: () => void }) {
  const asset = assetOf(network, item.assetId);
  const out = item.direction === 'out';
  const hidden = useMeta((s) => s.hideBalances);
  const title = item.direction === 'self' ? 'Self transfer' : out ? `Sent ${asset.symbol}` : `Received ${asset.symbol}`;
  const suspicious = item.flags.includes('suspected_poisoning');
  return (
    <button type="button" onClick={onClick} className="-mx-2 flex w-[calc(100%+16px)] items-center gap-3 rounded-2xl px-2 py-3 text-left hover:bg-surface-hover">
      <span className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${item.status === 'failed' ? 'bg-danger-soft text-danger' : 'bg-primary-soft text-primary'}`}>
        {item.status === 'failed' ? <XCircle size={20} /> : out ? <ArrowUpRight size={20} /> : <ArrowDownLeft size={20} />}
        {item.status === 'pending' && (
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-elevated p-0.5 text-warning">
            <Spinner size={12} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 font-semibold">
          {title}
          {item.status !== 'confirmed' && <StatusChip status={item.status} />}
          {suspicious && <span className="rounded bg-danger-soft px-1.5 text-[10px] font-semibold text-danger">Suspicious</span>}
        </span>
        <span className="block truncate text-sm text-muted">
          {out ? 'To' : 'From'} <span className="font-mono">{shortAddress(out ? item.to : item.from)}</span>
        </span>
      </span>
      <span className={`tabular text-right font-semibold ${out ? '' : 'text-success'}`}>
        {hidden ? '••••' : `${out ? '−' : '+'}${formatDisplay(BigInt(item.amount), asset.decimals)} ${asset.symbol}`}
      </span>
    </button>
  );
}

function StatusChip({ status }: { status: ActivityItem['status'] }) {
  const map = {
    pending: 'bg-warning-soft text-warning',
    failed: 'bg-danger-soft text-danger',
    replaced: 'bg-sunken text-muted',
    dropped: 'bg-sunken text-muted',
    confirmed: 'bg-success-soft text-success',
  } as const;
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${map[status]}`}>{status}</span>;
}

export function TxDetailSheet({ item, network, onClose }: { item: ActivityItem | null; network: Network; onClose: () => void }) {
  const asset = item ? assetOf(network, item.assetId) : null;
  return (
    <Sheet open={!!item} onOpenChange={(o) => !o && onClose()} title={item ? (item.direction === 'out' ? 'Sent' : item.direction === 'self' ? 'Self transfer' : 'Received') : ''}>
      {item && asset && (
        <div className="space-y-4">
          <div className="text-center">
            <div className="tabular text-3xl font-bold">
              {item.direction === 'out' ? '−' : '+'}
              {formatDisplay(BigInt(item.amount), asset.decimals, 8)} {asset.symbol}
            </div>
            <div className="mt-2 flex justify-center">
              <StatusChip status={item.status} />
            </div>
          </div>
          {item.flags.includes('suspected_poisoning') && (
            <div className="rounded-xl bg-danger-soft p-3 text-[13px]">
              This looks like an address-poisoning attempt. Never copy addresses from your activity list.
            </div>
          )}
          <dl className="divide-y divide-line rounded-2xl border border-line">
            <Row label="From">
              <ChunkedAddress address={item.from} className="" />
            </Row>
            <Row label="To">
              <ChunkedAddress address={item.to} className="" />
            </Row>
            <Row label="Network">{network.name}</Row>
            {item.fee && <Row label="Network fee">{formatDisplay(BigInt(item.fee), 18, 8)} {network.nativeCurrency.symbol}</Row>}
            <Row label="Date">{new Date(item.timestamp).toLocaleString()}</Row>
            <Row label="Transaction ID">
              <span className="flex items-center gap-1">
                <span className="font-mono text-[13px]">{shortAddress(item.hash, 10, 8)}</span>
                <CopyButton value={item.hash} label="Copy transaction ID" toastText="Transaction ID copied" />
              </span>
            </Row>
          </dl>
          {network.explorer && (
            <a href={network.explorer.txUrl(item.hash)} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 rounded-full py-2 text-sm font-semibold text-primary hover:underline">
              View on {network.explorer.name} <ExternalLink size={14} />
            </a>
          )}
          {item.status === 'pending' && (
            <p className="flex items-center justify-center gap-2 text-center text-[13px] text-muted">
              <RefreshCcw size={13} /> Updating automatically
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{children}</dd>
    </div>
  );
}
