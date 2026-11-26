import { create } from 'zustand';

export type WalletMode = 'individual' | 'shared';
const individualScreens = new Set(['/home', '/assets', '/activity', '/web3', '/security', '/settings']);

/** The URL owns the mode. A stale preference must never relabel a personal
 * transaction screen as a shared wallet. Settings/security are device screens. */
export function walletModeForRoute(path: string, mode: string | null): WalletMode {
  if (path === '/shared') return 'shared';
  return (path === '/settings' || path === '/security') && mode === 'shared' ? 'shared' : 'individual';
}

export function individualReturnHref(path: string): string | undefined {
  return individualScreens.has(path) ? path : undefined;
}

export function sharedWalletHref(id: string): string {
  return `/shared?wallet=${encodeURIComponent(id)}`;
}

export function sharedDeviceHref(path: '/settings' | '/security', walletId?: string): string {
  const query = new URLSearchParams({ mode: 'shared' });
  if (walletId) query.set('wallet', walletId);
  return `${path}?${query}`;
}

interface WalletNavigationState {
  individualHref: string;
  sharedHref: string;
  sharedWallet: { id: string; name: string } | null;
  rememberIndividual(path: string): void;
  rememberSharedLocation(path: string): void;
  selectShared(wallet: { id: string; name: string }): void;
  showSharedList(): void;
}

/** Public, session-only navigation hints. This store is deliberately separate
 * from account/network selection, vaults, shares and transaction state. */
export const useWalletNavigation = create<WalletNavigationState>()((set) => ({
  individualHref: '/home',
  sharedHref: '/shared',
  sharedWallet: null,
  rememberIndividual(path) {
    const href = individualReturnHref(path);
    if (href) set({ individualHref: href });
  },
  rememberSharedLocation(path) {
    const url = new URL(path, 'https://wallet.invalid');
    if (url.pathname !== '/shared') return;
    const id = url.searchParams.get('wallet');
    set({
      sharedHref: id ? sharedWalletHref(id) : url.searchParams.get('view') === 'list' ? '/shared?view=list' : '/shared',
    });
  },
  selectShared(wallet) {
    set({ sharedWallet: wallet, sharedHref: sharedWalletHref(wallet.id) });
  },
  showSharedList() {
    set({ sharedWallet: null, sharedHref: '/shared?view=list' });
  },
}));
