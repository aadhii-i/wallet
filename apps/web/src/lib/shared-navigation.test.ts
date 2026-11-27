import { describe, expect, it } from 'vitest';
import { sharedAnchor, sharedLocation, type SharedAsset, type SharedView } from './shared-navigation';

describe('shared task navigation', () => {
  it('opens existing Bitcoin and Hedera links in the correct asset view', () => {
    expect(sharedLocation('#sw-bitcoin')).toEqual({
      view: 'assets',
      asset: 'bitcoin',
    });
    expect(sharedLocation('#sw-hedera-payments')).toEqual({
      view: 'requests',
      asset: 'hedera',
    });
    expect(sharedLocation('#sw-accounts')).toEqual({
      view: 'assets',
      asset: 'evm',
    });
  });
  it('keeps the selected asset when opening a task from the shared navigation', () => {
    const previous = { view: 'assets', asset: 'bitcoin' } as const;
    expect(sharedLocation('#sw-payments', previous)).toEqual({
      view: 'requests',
      asset: 'bitcoin',
    });
    expect(sharedLocation('#sw-wallet-history', previous)).toEqual({
      view: 'activity',
      asset: 'bitcoin',
    });
  });
  it('supports back/forward destinations without changing the asset', () => {
    const views: SharedView[] = ['home', 'assets', 'requests', 'activity', 'people', 'setup'];
    const assets: SharedAsset[] = ['evm', 'bitcoin', 'hedera'];
    for (const asset of assets)
      for (const view of views) {
        expect(sharedLocation(sharedAnchor(view, asset), { view: 'home', asset })).toEqual({ view, asset });
      }
  });
  it('returns unknown anchors to the overview instead of exposing a wrong task', () => {
    expect(
      sharedLocation('#untrusted-target', {
        view: 'requests',
        asset: 'hedera',
      }),
    ).toEqual({ view: 'home', asset: 'hedera' });
  });
});
