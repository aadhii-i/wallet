'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'motion/react';
import { Activity, Coins, Home, Settings, Shield, Sparkles } from 'lucide-react';
import { useEffect } from 'react';
import { useActivityKeepAlive, useVaultGate } from '@/lib/gate';
import { useMeta, useSession } from '@/lib/store';
import { syncWithBackend } from '@/lib/sync';
import { Spinner } from '../ui/spinner';
import { Logo } from './logo';
import { t } from '../ui/motion';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  status: 'live' | 'soon';
  mobile: boolean;
}

/** Data-driven navigation (spec §7.3): enabling Web3 later changes one field. */
export const NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: Home, status: 'live', mobile: true },
  { href: '/assets', label: 'Assets', icon: Coins, status: 'live', mobile: true },
  { href: '/activity', label: 'Activity', icon: Activity, status: 'live', mobile: true },
  { href: '/web3', label: 'Swap & Web3', icon: Sparkles, status: 'soon', mobile: true },
  { href: '/security', label: 'Security', icon: Shield, status: 'live', mobile: false },
  { href: '/settings', label: 'Settings', icon: Settings, status: 'live', mobile: true },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { ready } = useVaultGate('unlocked');
  const path = usePathname();
  const accounts = useMeta((s) => s.accounts.length);
  useActivityKeepAlive();

  useEffect(() => {
    if (ready && accounts > 0) void syncWithBackend();
  }, [ready, accounts]);

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-primary">
        <Spinner size={28} />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh">
      <nav aria-label="Main" className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-1 border-r border-line px-4 py-6 lg:flex">
        <div className="mb-6 px-2">
          <Logo />
        </div>
        {NAV.map((item) => (
          <NavLink key={item.href} item={item} active={path.startsWith(item.href)} layout="rail" />
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 justify-center">
        <main className="w-full max-w-[480px] px-4 pb-[calc(96px+env(safe-area-inset-bottom))] pt-3 lg:pb-12 lg:pt-8">
          <BackendBanner />
          {children}
        </main>
      </div>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-elevated/90 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
      >
        {NAV.filter((n) => n.mobile).map((item) => (
          <NavLink key={item.href} item={item} active={path.startsWith(item.href)} layout="tab" />
        ))}
      </nav>
    </div>
  );
}

function NavLink({ item, active, layout }: { item: NavItem; active: boolean; layout: 'rail' | 'tab' }) {
  const Icon = item.icon;
  if (layout === 'tab') {
    return (
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={`relative flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium ${active ? 'text-primary' : 'text-subtle'}`}
      >
        {active && <motion.span layoutId="tab-indicator" className="absolute top-0 h-0.5 w-8 rounded-full bg-primary" transition={t.snappy} />}
        <Icon size={22} strokeWidth={active ? 2.2 : 1.8} />
        <span>{item.label.split(' ')[0]}</span>
      </Link>
    );
  }
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`relative flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-medium transition-colors ${active ? 'text-ink' : 'text-muted hover:bg-surface-hover hover:text-ink'}`}
    >
      {active && <motion.span layoutId="rail-indicator" className="absolute inset-0 rounded-xl bg-primary-soft" transition={t.snappy} />}
      <span className="relative flex items-center gap-3">
        <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
        {item.label}
        {item.status === 'soon' && <span className="rounded-full bg-sunken px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-subtle">Soon</span>}
      </span>
    </Link>
  );
}

function BackendBanner() {
  const online = useSession((s) => s.apiOnline);
  const custom = useMeta((s) => Object.keys(s.customRpc).length > 0);
  if (online) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={t.base}
      className="mb-3 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-2.5 text-[13px] text-ink"
      role="status"
    >
      QD services are unreachable. {custom ? 'Using your custom RPC for balances.' : 'Balances and history may be unavailable.'} Your funds are safe.
    </motion.div>
  );
}
