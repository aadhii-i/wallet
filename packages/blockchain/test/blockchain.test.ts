import { describe, expect, it } from 'vitest';
import {
  AmountParseError,
  EVM_NETWORKS,
  assetsForNetwork,
  createNetworkRegistry,
  formatDisplay,
  formatUnits,
  formatUsdCents,
  isKnownTokenContract,
  parseUnits,
  toUsdCents,
} from '../src';

describe('amount', () => {
  it('parses decimals exactly', () => {
    expect(parseUnits('1.5', 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseUnits('0.000001', 6)).toBe(1n);
    expect(parseUnits('.5', 2)).toBe(50n);
    expect(parseUnits('1,000', 0)).toBe(1000n);
    expect(parseUnits('0', 18)).toBe(0n);
  });

  it('rejects invalid input', () => {
    for (const [s, code] of [
      ['', 'EMPTY'],
      ['-1', 'NEGATIVE'],
      ['1e5', 'FORMAT'],
      ['1.2.3', 'FORMAT'],
      ['0.0000001', 'PRECISION'],
    ] as const) {
      expect(() => parseUnits(s, 6)).toThrow(AmountParseError);
      try {
        parseUnits(s, 6);
      } catch (e) {
        expect((e as AmountParseError).code).toBe(code);
      }
    }
  });

  it('round-trips formatUnits/parseUnits', () => {
    for (const v of [0n, 1n, 10n ** 18n, 123456789012345678901234567890n]) {
      expect(parseUnits(formatUnits(v, 18), 18)).toBe(v);
    }
    expect(formatUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatUnits(-5n, 1)).toBe('-0.5');
  });

  it('formats for display', () => {
    expect(formatDisplay(0n, 18)).toBe('0');
    expect(formatDisplay(1n, 18)).toBe('<0.000001');
    expect(formatDisplay(parseUnits('1234.56789', 18), 18)).toBe('1,234.56');
    expect(formatDisplay(parseUnits('0.12345678', 18), 18)).toBe('0.123456');
  });

  it('converts to USD without floats', () => {
    expect(toUsdCents(parseUnits('1.5', 18), 18, '3120.45')).toBe(468067n);
    expect(toUsdCents(parseUnits('100', 6), 6, '1.0001')).toBe(10001n);
    expect(formatUsdCents(123456789n)).toBe('$1,234,567.89');
    expect(formatUsdCents(5n)).toBe('$0.05');
  });
});

describe('networks & assets', () => {
  it('has unique ids and chain ids', () => {
    expect(new Set(EVM_NETWORKS.map((n) => n.id)).size).toBe(EVM_NETWORKS.length);
    expect(new Set(EVM_NETWORKS.map((n) => n.chainId)).size).toBe(EVM_NETWORKS.length);
  });

  it('excludes local networks from production registries', () => {
    expect(createNetworkRegistry({ includeLocal: false }).byId('anvil')).toBeUndefined();
    expect(createNetworkRegistry({ includeLocal: true }).byChainId(31337)?.id).toBe('anvil');
    expect(() => createNetworkRegistry({ includeLocal: false }).require('anvil')).toThrow();
  });

  it('builds asset ids matching the API format', () => {
    const eth = createNetworkRegistry({ includeLocal: false }).require('eth-mainnet');
    const assets = assetsForNetwork(eth);
    expect(assets[0]!.id).toBe('eth-mainnet:native');
    const usdc = assets.find((a) => a.symbol === 'USDC')!;
    expect(usdc.id).toBe('eth-mainnet:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(isKnownTokenContract('eth-mainnet', '0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48')).toBe(true);
    expect(isKnownTokenContract('base', '0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48')).toBe(false);
  });
});
