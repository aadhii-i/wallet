'use client';
import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import type { Network } from '@qd/blockchain';
import { useQueryClient } from '@tanstack/react-query';
import { useSelectableNetworks, useUnmodelledNetworks } from '@/lib/hooks';
import { toast, useMeta } from '@/lib/store';
import { Sheet } from '../ui/sheet';
import { t } from '../ui/motion';
import {
  EthereumLogo,
  BitcoinLogo,
  HederaLogo,
  BaseLogo,
  ArbitrumLogo,
  PolygonLogo,
} from '../ui/chain-logos';

/** Maps a network to its official SVG logo component. */
function NetworkLogo({ network, size }: { network: Network; size: number }) {
  // Exact network ID match first (most specific)
  switch (network.id) {
    case 'eth-mainnet':    return <EthereumLogo size={size} />;
    case 'base':           return <BaseLogo size={size} />;
    case 'base-sepolia':   return <BaseLogo size={size} />;
    case 'arbitrum':       return <ArbitrumLogo size={size} />;
    case 'arbitrum-sepolia': return <ArbitrumLogo size={size} />;
    case 'polygon':        return <PolygonLogo size={size} />;
    case 'amoy':           return <PolygonLogo size={size} />;
    case 'btc-mainnet':    return <BitcoinLogo size={size} />;
    case 'btc-testnet4':   return <BitcoinLogo size={size} />;
    case 'hedera-testnet': return <HederaLogo size={size} />;
    case 'sepolia':        return <EthereumLogo size={size} />;
  }
  // Family-level fallback
  switch (network.family) {
    case 'evm':     return <EthereumLogo size={size} />;
    case 'bitcoin': return <BitcoinLogo size={size} />;
    case 'hedera':  return <HederaLogo size={size} />;
  }
}

export function NetworkDot({ network, size = 18 }: { network: Network; size?: number }) {
  return <NetworkLogo network={network} size={size} />;
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
  const selectable = useSelectableNetworks();
  const unmodelled = useUnmodelledNetworks();

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Select a network">
      {GROUPS.map((g) => {
        const items = selectable.filter((n) => n.kind === g.kind);
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
      {selectable.length === 0 && (
        <p className="px-1 text-sm text-muted">
          No network is reachable right now. wallet-api only lists chains it has an upstream for, so check its
          <code className="mx-1 rounded bg-surface-hover px-1 py-0.5 text-xs">EVM_RPC_&lt;chainId&gt;</code>
          configuration, or set your own RPC under Settings.
        </p>
      )}
      {unmodelled.length > 0 && (
        <p className="px-1 text-xs text-subtle">
          wallet-api proxies {unmodelled.length} chain{unmodelled.length === 1 ? '' : 's'} this build cannot display yet.
        </p>
      )}
    </Sheet>
  );
}
