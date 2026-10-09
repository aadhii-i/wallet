'use client';
import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import type { Network } from '@qd/blockchain';
import { useQueryClient } from '@tanstack/react-query';
import { registry } from '@/lib/chains';
import { toast, useMeta } from '@/lib/store';
import { Sheet } from '../ui/sheet';
import { t } from '../ui/motion';

const ACCENTS: Record<string, string> = {
  eth: '#627EEA',
  base: '#1C5CFF',
  arbitrum: '#28A0F0',
  polygon: '#8247E5',
  testnet: '#F2A900',
  local: '#8390AA',
};

export function NetworkDot({ network, size = 18 }: { network: Network; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
      style={{ width: size, height: size, background: ACCENTS[network.accent] ?? '#5A6782' }}
    >
      {network.shortName.slice(0, 1)}
    </span>
  );
}

const GROUPS: { kind: Network['kind']; label: string }[] = [
  { kind: 'mainnet', label: 'Networks' },
  { kind: 'testnet', label: 'Test networks' },
  { kind: 'local', label: 'Local development' },
];

export function NetworkSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const current = useMeta((s) => s.networkId);
  const select = useMeta((s) => s.selectNetwork);
  const qc = useQueryClient();

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Select a network">
      {GROUPS.map((g) => {
        const items = registry.all().filter((n) => n.kind === g.kind);
        if (items.length === 0) return null;
        return (
          <section key={g.kind} className="mb-4">
            <h3 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-subtle">{g.label}</h3>
            <ul role="listbox" aria-label={g.label}>
              {items.map((n) => {
                const active = n.id === current;
                return (
                  <li key={n.id}>
                    <motion.button
                      type="button"
                      role="option"
                      aria-selected={active}
                      whileTap={{ scale: 0.98 }}
                      transition={t.instant}
                      onClick={() => {
                        if (!active) {
                          select(n.id);
                          void qc.invalidateQueries();
                          toast.info(`Switched to ${n.name}`);
                        }
                        onOpenChange(false);
                      }}
                      className={`relative flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-surface-hover ${active ? 'bg-primary-soft' : ''}`}
                    >
                      {active && <span className="absolute left-0 top-2 bottom-2 w-1 rounded-full bg-primary" />}
                      <NetworkDot network={n} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{n.name}</span>
                        <span className="block text-xs text-subtle">{n.nativeCurrency.symbol}{n.kind !== 'mainnet' ? ' · no real value' : ''}</span>
                      </span>
                      {active && <Check size={18} className="text-primary" />}
                    </motion.button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </Sheet>
  );
}
