'use client';

import Link from 'next/link';
import { UserRound, Users } from 'lucide-react';
import type { WalletMode } from '@/lib/wallet-navigation';

export function WalletModeSwitch({
  mode,
  individualHref,
  sharedHref,
  sending,
}: {
  mode: WalletMode;
  individualHref: string;
  sharedHref: string;
  sending: boolean;
}) {
  const styles = (active: boolean) =>
    `flex min-h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl px-2 py-2 text-center text-sm font-semibold transition-colors ${
      active ? 'bg-primary text-on-primary shadow-sm' : 'text-muted hover:bg-surface-hover hover:text-ink'
    }`;
  return (
    <div className="mb-4">
      <nav aria-label="Wallet type" className="flex gap-1 rounded-2xl border border-line bg-sunken p-1">
        <Link
          href={individualHref}
          onClick={(e) => {
            if (sending) e.preventDefault();
          }}
          aria-current={mode === 'individual' ? 'page' : undefined}
          className={styles(mode === 'individual')}
        >
          <UserRound size={18} className="shrink-0" aria-hidden="true" />
          <span>Individual Wallet</span>
        </Link>
        {sending ? (
          <span aria-disabled="true" className={`${styles(false)} cursor-not-allowed opacity-50`}>
            <Users size={18} className="shrink-0" aria-hidden="true" />
            <span>Shared Wallet</span>
          </span>
        ) : (
          <Link
            href={sharedHref}
            onClick={(event) => {
              if (mode === 'shared' && window.location.pathname === '/shared') event.preventDefault();
            }}
            aria-current={mode === 'shared' ? 'page' : undefined}
            className={styles(mode === 'shared')}
          >
            <Users size={18} className="shrink-0" aria-hidden="true" />
            <span>Shared Wallet</span>
          </Link>
        )}
      </nav>
      {sending && (
        <p role="note" className="mt-2 text-xs text-muted">
          Finish or cancel this send before switching wallet type.
        </p>
      )}
    </div>
  );
}
