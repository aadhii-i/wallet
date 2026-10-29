import { describe, expect, it } from 'vitest';
import { createNetworkRegistry } from '@qd/blockchain';
import { filterEnabledNetworks, unmodelledNetworkIds } from './network-filter';

const all = createNetworkRegistry({ includeLocal: true }).all();

describe('filterEnabledNetworks', () => {
  it('keeps the local registry while the server has not answered', () => {
    expect(filterEnabledNetworks(all, null).map((n) => n.id)).toEqual(all.map((n) => n.id));
  });

  it('keeps only the proxied chains, in registry order', () => {
    expect(filterEnabledNetworks(all, ['sepolia', 'anvil']).map((n) => n.id)).toEqual(['sepolia', 'anvil']);
  });

  it('never offers a chain the client registry does not model', () => {
    expect(filterEnabledNetworks(all, ['sepolia', 'evm-84532']).map((n) => n.id)).toEqual(['sepolia']);
  });

  it('keeps a chain the user gave a custom RPC even when the backend does not proxy it', () => {
    const got = filterEnabledNetworks(all, ['sepolia'], ['base']);
    expect(got.map((n) => n.id)).toEqual(['base', 'sepolia']);
  });

  it('can return an empty list, which the network sheet explains instead of crashing on', () => {
    expect(filterEnabledNetworks(all, [])).toEqual([]);
  });
});

describe('unmodelledNetworkIds', () => {
  it('is empty while the server has not answered', () => {
    expect(unmodelledNetworkIds(null, all.map((n) => n.id))).toEqual([]);
  });

  it('reports chains the backend proxies that this build cannot display', () => {
    expect(unmodelledNetworkIds(['sepolia', 'evm-84532', 'evm-80002'], all.map((n) => n.id))).toEqual([
      'evm-84532',
      'evm-80002',
    ]);
  });
});
