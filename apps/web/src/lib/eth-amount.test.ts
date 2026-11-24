import { describe, expect, it } from 'vitest';
import { formatWeiAsEth, parseEthToWei } from './eth-amount';

const wei = (s: string) => {
  const r = parseEthToWei(s);
  if (!r.ok) throw new Error(r.error);
  return r.wei;
};

describe('parseEthToWei', () => {
  it('converts exactly, without floating point', () => {
    expect(wei('1')).toBe('1000000000000000000');
    expect(wei('0.1')).toBe('100000000000000000');
    expect(wei('.5')).toBe('500000000000000000');
    expect(wei('1.')).toBe('1000000000000000000');
    expect(wei('0.000000000000000001')).toBe('1');
    expect(wei('123456789.123456789123456789')).toBe('123456789123456789123456789');
    expect(wei('0')).toBe('0');
    expect(wei('000.000')).toBe('0');
    expect(wei(' 2 ')).toBe('2000000000000000000');
  });

  it('rejects malformed input and excess precision', () => {
    for (const bad of ['', '.', 'abc', '1e18', '-1', '1,5', '1.2.3', '0x10', '1 000']) {
      expect(parseEthToWei(bad).ok, bad).toBe(false);
    }
    expect(parseEthToWei('0.0000000000000000001').ok).toBe(false);
    expect(parseEthToWei('9'.repeat(70)).ok).toBe(false);
  });
});

describe('formatWeiAsEth', () => {
  it('round-trips', () => {
    for (const s of ['1', '0.1', '0.000000000000000001', '123456789.123456789123456789', '0', '42.5']) {
      expect(formatWeiAsEth(wei(s))).toBe(s);
    }
  });
});
