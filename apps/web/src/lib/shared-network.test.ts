import { describe, expect, it } from 'vitest';
import { nativeSymbol } from './shared-network';

describe('shared-wallet native amounts', () => {
  it('uses POL for Polygon Amoy', () => {
    expect(nativeSymbol(80002)).toBe('POL');
  });

  it('keeps ETH for Sepolia, Base, Arbitrum and local test chains', () => {
    for (const chainId of [11155111, 84532, 421614, 31337]) {
      expect(nativeSymbol(chainId)).toBe('ETH');
    }
  });
});
