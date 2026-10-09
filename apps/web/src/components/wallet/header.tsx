'use client';
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Lock, MoreVertical, QrCode, Shield } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useNetwork } from '@/lib/hooks';
import { useSelectedAccount, useSession } from '@/lib/store';
import { vault } from '@/lib/vault-client';
import { Identicon, CopyButton, shortAddress } from '../ui/identity';
import { AccountSheet } from './account-sheet';
import { NetworkSheet, NetworkDot } from './network-sheet';
import { ReceiveSheet } from './receive-sheet';
import { t } from '../ui/motion';

export function WalletHeader() {
  const account = useSelectedAccount();
  const network = useNetwork();
  const [sheet, setSheet] = useState<'account' | 'network' | 'receive' | null>(null);
  const [menu, setMenu] = useState(false);
  const router = useRouter();

  return (
    <header className="relative mb-2 flex items-center justify-between gap-2">
      <button
        type="button"
        onClick={() => setSheet('network')}
        className="inline-flex h-9 max-w-[38%] items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[13px] font-medium hover:bg-surface-hover"
        aria-label={`Network: ${network.name}. Change network`}
      >
        <NetworkDot network={network} />
        <span className="truncate">{network.shortName}</span>
        <ChevronDown size={14} className="shrink-0 text-subtle" />
      </button>

      <div className="flex min-w-0 flex-col items-center">
        <button
          type="button"
          onClick={() => setSheet('account')}
          className="inline-flex h-9 min-w-0 items-center gap-2 rounded-full px-2 hover:bg-surface-hover"
          aria-label={`Account: ${account?.name}. Switch account`}
        >
          {account && <Identicon address={account.address} size={22} />}
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={account?.index} className="truncate text-[15px] font-semibold" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={t.fast}>
              {account?.name ?? '—'}
            </motion.span>
          </AnimatePresence>
          <ChevronDown size={16} className="shrink-0 text-subtle" />
        </button>
        {account && (
          <div className="-mt-0.5 flex items-center text-xs text-subtle">
            <span className="font-mono">{shortAddress(account.address)}</span>
            <CopyButton value={account.address} className="h-7 w-7" />
          </div>
        )}
      </div>

      <div className="relative flex w-[38%] justify-end">
        <button type="button" aria-label="Wallet menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-ink">
          <MoreVertical size={20} />
        </button>
        <AnimatePresence>
          {menu && (
            <>
              <button aria-hidden tabIndex={-1} className="fixed inset-0 z-30 cursor-default" onClick={() => setMenu(false)} />
              <motion.div
                role="menu"
                initial={{ opacity: 0, scale: 0.95, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, transition: t.exit }}
                transition={t.fast}
                style={{ transformOrigin: 'top right' }}
                className="absolute right-0 top-11 z-40 w-56 overflow-hidden rounded-2xl border border-line bg-elevated p-1.5 shadow-xl"
              >
                <MenuItem icon={<QrCode size={18} />} onClick={() => { setMenu(false); setSheet('receive'); }}>Account details</MenuItem>
                <MenuItem icon={<Shield size={18} />} onClick={() => { setMenu(false); router.push('/security'); }}>Security & privacy</MenuItem>
                <MenuItem
                  icon={<Lock size={18} />}
                  onClick={async () => {
                    setMenu(false);
                    await vault.call('lock');
                    useSession.getState().set({ status: 'locked' });
                  }}
                >
                  Lock wallet
                </MenuItem>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      <AccountSheet open={sheet === 'account'} onOpenChange={(o) => setSheet(o ? 'account' : null)} />
      <NetworkSheet open={sheet === 'network'} onOpenChange={(o) => setSheet(o ? 'network' : null)} />
      <ReceiveSheet open={sheet === 'receive'} onOpenChange={(o) => setSheet(o ? 'receive' : null)} />
    </header>
  );
}

function MenuItem({ icon, children, onClick }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium hover:bg-surface-hover">
      <span className="text-muted">{icon}</span>
      {children}
    </button>
  );
}
