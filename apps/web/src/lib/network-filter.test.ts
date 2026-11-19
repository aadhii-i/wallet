import { describe, expect, it } from 'vitest';
import { createNetworkRegistry } from '@qd/blockchain';
import { filterEnabledNetworks, unmodelledNetworkIds } from './network-filter';

const all = createNetworkRegistry({ includeLocal: true }).all();
const evmIds = all.filter((n) => n.family === 'evm').map((n) => n.id);
const btcIds = all.filter((n) => n.family === 'bitcoin').map((n) => n.id);

describe('filterEnabledNetworks', () => {
  it('keeps the local registry while the server has not answered', () => {
    expect(filterEnabledNetworks(all, null).map((n) => n.id)).toEqual(all.map((n) => n.id));
  });

  it('keeps only the proxied EVM chains, in registry order', () => {
    const result = filterEnabledNetworks(all, ['sepolia', 'anvil']).map((n) => n.id);
    expect(result).toContain('sepolia');
    expect(result).toContain('anvil');
    // Non-proxied EVM chains should be absent.
    expect(result).not.toContain('base');
  });

  it('never offers an EVM chain the client registry does not model', () => {
    expect(filterEnabledNetworks(all, ['sepolia', 'evm-84532']).map((n) => n.id)).toContain('sepolia');
    expect(filterEnabledNetworks(all, ['sepolia', 'evm-84532']).map((n) => n.id)).not.toContain('evm-84532');
  });

  it('keeps a chain the user gave a custom RPC even when the backend does not proxy it', () => {
    const got = filterEnabledNetworks(all, ['sepolia'], ['base']);
    expect(got.map((n) => n.id)).toContain('base');
    expect(got.map((n) => n.id)).toContain('sepolia');
  });

  it('can return an empty EVM list (which the network sheet explains instead of crashing on)', () => {
    // Bitcoin networks should still appear even if no EVM chains are served.
    const result = filterEnabledNetworks(all, []);
    const resultIds = result.map((n) => n.id);
    for (const id of btcIds) {
      expect(resultIds).toContain(id);
    }
    for (const id of evmIds) {
      expect(resultIds).not.toContain(id);
    }
  });

  // ---- Bitcoin-specific: the regression that caused Bitcoin to disappear ----

  it('always keeps Bitcoin networks regardless of the EVM server response', () => {
    // This is the exact scenario that caused the regression: Docker starts,
    // the server responds with EVM-only networks, and Bitcoin should survive.
    const serverResponse = ['sepolia', 'base-sepolia', 'arbitrum-sepolia', 'amoy', 'anvil'];
    const result = filterEnabledNetworks(all, serverResponse);
    const resultIds = result.map((n) => n.id);

    // Bitcoin must always be present.
    expect(resultIds).toContain('btc-mainnet');
    expect(resultIds).toContain('btc-testnet4');

    // The EVM chains the server serves should be present.
    for (const id of serverResponse) {
      if (all.find((n) => n.id === id)) {
        expect(resultIds).toContain(id);
      }
    }

    // EVM chains the server does NOT serve should be absent.
    expect(resultIds).not.toContain('eth-mainnet');
    expect(resultIds).not.toContain('base');
  });

  it('keeps Bitcoin when the server response is an empty array', () => {
    const result = filterEnabledNetworks(all, []);
    const resultIds = result.map((n) => n.id);
    expect(resultIds).toContain('btc-mainnet');
    expect(resultIds).toContain('btc-testnet4');
  });

  it('Bitcoin network family is never evm so it is never filtered by the evm-only server response', () => {
    const btcNetworks = all.filter((n) => n.family === 'bitcoin');
    expect(btcNetworks.length).toBeGreaterThan(0);
    for (const n of btcNetworks) {
      expect(n.family).not.toBe('evm');
    }
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
