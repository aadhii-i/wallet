/**
 * Exact decimal ETH <-> wei conversion on strings. No floating point anywhere:
 * the user's digits are moved, never computed, so "0.1" is exactly 10^17 wei.
 */

const ETH_DECIMALS = 18;
const AMOUNT_RE = /^(\d*)(?:\.(\d*))?$/;

export type ParseEthResult = { ok: true; wei: string } | { ok: false; error: string };

/** Parses a user-typed ETH amount into a canonical decimal wei string. */
export function parseEthToWei(input: string): ParseEthResult {
  const s = input.trim();
  const m = AMOUNT_RE.exec(s);
  if (!s || !m || (m[1] === '' && (m[2] ?? '') === '')) return { ok: false, error: 'Enter an amount like 1 or 0.25' };
  const whole = m[1] ?? '';
  const frac = m[2] ?? '';
  if (frac.length > ETH_DECIMALS) return { ok: false, error: `At most ${ETH_DECIMALS} decimal places` };
  const digits = (whole + frac.padEnd(ETH_DECIMALS, '0')).replace(/^0+/, '');
  const wei = digits === '' ? '0' : digits;
  // uint256 max has 78 digits; anything that long is not a sensible ETH amount anyway.
  if (wei.length > 77) return { ok: false, error: 'Amount is too large' };
  return { ok: true, wei };
}

/** Formats a canonical decimal wei string as ETH with no trailing zeros. */
export function formatWeiAsEth(wei: string): string {
  if (!/^\d+$/.test(wei)) return wei;
  const padded = wei.replace(/^0+/, '').padStart(ETH_DECIMALS + 1, '0');
  const whole = padded.slice(0, -ETH_DECIMALS);
  const frac = padded.slice(-ETH_DECIMALS).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
