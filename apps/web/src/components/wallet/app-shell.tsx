'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { motion } from 'motion/react';
import { Activity, Coins, Home, Settings, Shield, Sparkles, Users, ClipboardCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useActivityKeepAlive, useVaultGate } from '@/lib/gate';
import { useMeta, useSession } from '@/lib/store';
import { syncWithBackend } from '@/lib/sync';
import { Spinner } from '../ui/spinner';
import { Logo } from './logo';
import { t } from '../ui/motion';
import { WalletModeSwitch } from './wallet-mode-switch';
import { sharedDeviceHref, sharedWalletHref, useWalletNavigation, walletModeForRoute } from '@/lib/wallet-navigation';
import { sharedLocation } from '@/lib/shared-navigation';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  status: 'live' | 'soon';
  mobile: boolean;
  anchor?: string;
}

/** Data-driven navigation (spec §7.3): enabling Web3 later changes one field. */
export const NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: Home, status: 'live', mobile: true },
  {
    href: '/assets',
    label: 'Assets',
    icon: Coins,
    status: 'live',
    mobile: true,
  },
  {
    href: '/activity',
    label: 'Activity',
    icon: Activity,
    status: 'live',
    mobile: true,
  },
  {
    href: '/web3',
    label: 'Swap & Web3',
    icon: Sparkles,
    status: 'soon',
    mobile: true,
  },
  {
    href: '/security',
    label: 'Security',
    icon: Shield,
    status: 'live',
    mobile: false,
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: Settings,
    status: 'live',
    mobile: true,
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { ready } = useVaultGate('unlocked');
  const path = usePathname();
  const params = useSearchParams();
  const sharedEnabled = process.env.NEXT_PUBLIC_ENABLE_SHARED_WALLETS === 'true';
  const mode = sharedEnabled ? walletModeForRoute(path, params.get('mode')) : 'individual';
  const navigation = useWalletNavigation();
  const [anchor, setAnchor] = useState('sw-overview');
  const walletParam = params.get('wallet');
  const group =
    params.get('view') !== 'list' && (!walletParam || navigation.sharedWallet?.id === walletParam)
      ? navigation.sharedWallet
      : null;
  const sharedHome = group ? sharedWalletHref(group.id) : '/shared';
  const items: NavItem[] =
    mode === 'individual'
      ? NAV
      : [
          {
            href: `${sharedHome}#sw-overview`,
            anchor: 'sw-overview',
            label: group ? 'Overview' : 'Wallets',
            icon: Home,
            status: 'live',
            mobile: true,
          },
          ...(group
            ? [
                {
                  href: `${sharedHome}#sw-blockchains`,
                  anchor: 'sw-blockchains',
                  label: 'Assets',
                  icon: Coins,
                  status: 'live' as const,
                  mobile: true,
                },
                {
                  href: `${sharedHome}#sw-payments`,
                  anchor: 'sw-payments',
                  label: 'Requests',
                  icon: ClipboardCheck,
                  status: 'live' as const,
                  mobile: true,
                },
                {
                  href: `${sharedHome}#sw-wallet-history`,
                  anchor: 'sw-wallet-history',
                  label: 'Activity',
                  icon: Activity,
                  status: 'live' as const,
                  mobile: true,
                },
                {
                  href: `${sharedHome}#sw-participants`,
                  anchor: 'sw-participants',
                  label: 'People',
                  icon: Users,
                  status: 'live' as const,
                  mobile: false,
                },
              ]
            : []),
          {
            href: sharedDeviceHref('/security', group?.id),
            label: 'Security',
            icon: Shield,
            status: 'live',
            mobile: false,
          },
          {
            href: sharedDeviceHref('/settings', group?.id),
            label: 'Settings',
            icon: Settings,
            status: 'live',
            mobile: true,
          },
        ];
  const isActive = (item: NavItem) =>
    item.anchor
      ? path === '/shared' && sharedLocation(anchor).view === sharedLocation(item.anchor).view
      : path.startsWith(item.href.split('?')[0]!);
  const navigateItem = (item: NavItem, event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!item.anchor) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    setAnchor(item.anchor);
    // In-page navigation keeps signing components mounted and notifies their
    // hash listeners. Cross-page links still use the Next.js router.
    if (path === '/shared' && group) {
      event.preventDefault();
      window.location.hash = item.anchor;
    }
  };
  useEffect(() => {
    if (mode === 'individual') navigation.rememberIndividual(path);
    else if (path === '/shared') navigation.rememberSharedLocation(`${path}?${params.toString()}`);
  }, [path, params, mode, navigation.rememberIndividual, navigation.rememberSharedLocation]);
  useEffect(() => {
    const update = () => setAnchor(window.location.hash.slice(1) || 'sw-overview');
    update();
    window.addEventListener('hashchange', update);
    window.addEventListener('popstate', update);
    return () => {
      window.removeEventListener('hashchange', update);
      window.removeEventListener('popstate', update);
    };
  }, [path, params]);
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
      <nav
        aria-label="Main"
        className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-1 border-r border-line px-4 py-6 lg:flex"
      >
        <div className="mb-6 px-2">
          <Logo />
        </div>
        <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-subtle">
          {mode === 'shared' ? 'Shared Wallet' : 'Individual Wallet'}
        </p>
        {items.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(item)}
            layout="rail"
            onNavigate={(event) => navigateItem(item, event)}
          />
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 justify-center">
        <main className="w-full max-w-[480px] px-4 pb-[calc(96px+env(safe-area-inset-bottom))] pt-3 lg:pb-12 lg:pt-8">
          {sharedEnabled && (
            <WalletModeSwitch
              mode={mode}
              individualHref={navigation.individualHref}
              sharedHref={navigation.sharedHref}
              sending={path === '/send'}
            />
          )}
          {mode === 'shared' && (path === '/settings' || path === '/security') && (
            <p className="mb-4 text-sm text-muted">
              Device settings apply to both wallet types.{' '}
              <Link href={sharedHome} className="font-semibold text-primary">
                Return to shared wallet
              </Link>
            </p>
          )}
          <BackendBanner />
          {children}
        </main>
      </div>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-elevated/90 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
      >
        {items
          .filter((n) => n.mobile)
          .map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isActive(item)}
              layout="tab"
              onNavigate={(event) => navigateItem(item, event)}
            />
          ))}
      </nav>
    </div>
  );
}

function NavLink({
  item,
  active,
  layout,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  layout: 'rail' | 'tab';
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const Icon = item.icon;
  if (layout === 'tab') {
    return (
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={`relative flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium ${active ? 'text-primary' : 'text-subtle'}`}
      >
        {active && (
          <motion.span
            layoutId="tab-indicator"
            className="absolute top-0 h-0.5 w-8 rounded-full bg-primary"
            transition={t.snappy}
          />
        )}
        <Icon size={22} strokeWidth={active ? 2.2 : 1.8} />
        <span>{item.label.split(' ')[0]}</span>
      </Link>
    );
  }
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`relative flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-medium transition-colors ${active ? 'text-ink' : 'text-muted hover:bg-surface-hover hover:text-ink'}`}
    >
      {active && (
        <motion.span
          layoutId="rail-indicator"
          className="absolute inset-0 rounded-xl bg-primary-soft"
          transition={t.snappy}
        />
      )}
      <span className="relative flex items-center gap-3">
        <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
        {item.label}
        {item.status === 'soon' && (
          <span className="rounded-full bg-sunken px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-subtle">
            Soon
          </span>
        )}
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
      QD services are unreachable.{' '}
      {custom ? 'Using your custom RPC for balances.' : 'Balances and history may be unavailable.'} Your funds are safe.
    </motion.div>
  );
}
