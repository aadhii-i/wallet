import { beforeEach, describe, expect, it } from 'vitest';
import { useMeta } from './store';
import {
  individualReturnHref,
  sharedDeviceHref,
  sharedWalletHref,
  useWalletNavigation,
  walletModeForRoute,
} from './wallet-navigation';

beforeEach(() => useWalletNavigation.setState({ individualHref: '/home', sharedHref: '/shared', sharedWallet: null }));

describe('wallet mode navigation boundaries', () => {
  it('never labels individual send, asset or activity screens as shared', () => {
    for (const path of ['/home', '/assets', '/activity', '/send', '/web3']) {
      expect(walletModeForRoute(path, 'shared')).toBe('individual');
    }
    expect(walletModeForRoute('/shared', null)).toBe('shared');
  });
  it('keeps device settings in the requested context without changing their route', () => {
    expect(walletModeForRoute('/settings', null)).toBe('individual');
    expect(walletModeForRoute('/security', 'shared')).toBe('shared');
    expect(sharedDeviceHref('/settings', 'group-1')).toBe('/settings?mode=shared&wallet=group-1');
  });
  it('does not restore an unfinished individual send as a mode destination', () => {
    useWalletNavigation.getState().rememberIndividual('/assets');
    useWalletNavigation.getState().rememberIndividual('/send');
    expect(useWalletNavigation.getState().individualHref).toBe('/assets');
    expect(individualReturnHref('https://example.com')).toBeUndefined();
    expect(individualReturnHref('/shared')).toBeUndefined();
  });
  it('remembers a shared group and list independently of the individual screen', () => {
    const ui = useWalletNavigation.getState();
    ui.rememberIndividual('/activity');
    ui.selectShared({ id: 'group-1', name: 'Family' });
    expect(useWalletNavigation.getState().sharedHref).toBe(sharedWalletHref('group-1'));
    ui.showSharedList();
    expect(useWalletNavigation.getState().sharedWallet).toBeNull();
    expect(useWalletNavigation.getState().sharedHref).toBe('/shared?view=list');
    expect(useWalletNavigation.getState().individualHref).toBe('/activity');
  });
  it('keeps remembered destinations internal and strips unrelated query values', () => {
    const ui = useWalletNavigation.getState();
    ui.rememberSharedLocation('/shared?wallet=group%2F1&mode=individual&next=https://example.com');
    expect(useWalletNavigation.getState().sharedHref).toBe('/shared?wallet=group%2F1');
    ui.rememberSharedLocation('/send?wallet=other');
    expect(useWalletNavigation.getState().sharedHref).toBe('/shared?wallet=group%2F1');
  });
  it('does not change individual account, network or preferences when selecting groups', () => {
    const before = useMeta.getState();
    const ui = useWalletNavigation.getState();
    ui.selectShared({ id: 'group-1', name: 'Family' });
    ui.selectShared({ id: 'group-2', name: 'Team' });
    ui.showSharedList();
    expect(useMeta.getState()).toBe(before);
  });
});
