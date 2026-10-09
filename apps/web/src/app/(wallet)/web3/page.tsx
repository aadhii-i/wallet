'use client';
import { motion } from 'motion/react';
import { ArrowLeftRight, Link2, Repeat } from 'lucide-react';
import { WalletHeader } from '@/components/wallet/header';
import { t } from '@/components/ui/motion';

const PLANNED = [
  { icon: Repeat, title: 'Swap', body: 'Exchange tokens at the best available rate.' },
  { icon: ArrowLeftRight, title: 'Bridge', body: 'Move assets between networks.' },
  { icon: Link2, title: 'Connect to apps', body: 'Use WalletConnect to sign in to decentralized apps.' },
];

/** Placeholder slot so these features can ship without changing navigation (spec §7.3). */
export default function Web3Page() {
  return (
    <>
      <WalletHeader />
      <h1 className="mb-1 mt-4 text-2xl font-bold">Swap & Web3</h1>
      <p className="mb-6 text-muted">These features are on the way. Nothing here is active yet.</p>
      <ul className="space-y-3">
        {PLANNED.map((p, i) => (
          <motion.li key={p.title} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...t.base, delay: i * 0.05 }} className="flex items-start gap-4 rounded-2xl border border-line bg-surface p-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sunken text-subtle">
              <p.icon size={20} />
            </span>
            <span>
              <span className="flex items-center gap-2 font-semibold">
                {p.title}
                <span className="rounded-full bg-sunken px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-subtle">Soon</span>
              </span>
              <span className="text-sm text-muted">{p.body}</span>
            </span>
          </motion.li>
        ))}
      </ul>
    </>
  );
}
