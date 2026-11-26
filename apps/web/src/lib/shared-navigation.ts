/** Presentation only: these destinations never select a signing account or network. */
export type SharedAsset = 'evm' | 'bitcoin' | 'hedera';
export type SharedView = 'home' | 'assets' | 'requests' | 'activity' | 'people' | 'setup';
export type SharedLocation = { view: SharedView; asset: SharedAsset };

export const SHARED_ASSETS = [
  {
    id: 'evm',
    name: 'Ethereum & networks',
    symbol: 'ETH / POL',
    network: 'Ethereum, Base, Arbitrum & Polygon testnets',
    mark: 'Ξ',
  },
  {
    id: 'bitcoin',
    name: 'Bitcoin',
    symbol: 'BTC',
    network: 'Bitcoin Testnet4',
    mark: '₿',
  },
  {
    id: 'hedera',
    name: 'Hedera',
    symbol: 'HBAR',
    network: 'Hedera Testnet',
    mark: 'ℏ',
  },
] as const;

/** Keep existing links useful while giving each task its own uncluttered view. */
export function sharedLocation(
  hash: string,
  previous: SharedLocation = { view: 'home', asset: 'evm' },
): SharedLocation {
  const anchor = hash.replace(/^#/, '');
  if (anchor === 'sw-blockchains') return { ...previous, view: 'assets' };
  if (anchor === 'sw-payments') return { ...previous, view: 'requests' };
  if (anchor === 'sw-participants') return { ...previous, view: 'people' };
  if (anchor === 'sw-setup') return { ...previous, view: 'setup' };
  if (anchor === 'sw-accounts') return { view: 'assets', asset: 'evm' };
  if (anchor === 'sw-proposals') return { view: 'requests', asset: 'evm' };
  if (anchor === 'sw-wallet-history') return { ...previous, view: 'activity' };
  for (const asset of ['bitcoin', 'hedera'] as const) {
    if (anchor === `sw-${asset}`) return { view: 'assets', asset };
    if (anchor === `sw-${asset}-payments`) return { view: 'requests', asset };
    if (anchor === `sw-${asset}-history`) return { view: 'activity', asset };
  }
  return { ...previous, view: 'home' };
}

export function sharedAnchor(view: SharedView, asset: SharedAsset): string {
  if (view === 'home') return 'sw-overview';
  if (view === 'people') return 'sw-participants';
  if (view === 'setup') return 'sw-setup';
  if (view === 'activity') return asset === 'evm' ? 'sw-wallet-history' : `sw-${asset}-history`;
  if (view === 'requests') return asset === 'evm' ? 'sw-proposals' : `sw-${asset}-payments`;
  return asset === 'evm' ? 'sw-accounts' : `sw-${asset}`;
}
