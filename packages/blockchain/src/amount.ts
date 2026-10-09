/**
 * Integer-only amount maths. Floating point never touches balances (spec §5).
 */

const DECIMAL_RE = /^(\d*)(?:\.(\d*))?$/;

export class AmountParseError extends Error {
  constructor(readonly code: 'FORMAT' | 'PRECISION' | 'NEGATIVE' | 'EMPTY') {
    super(`Invalid amount (${code})`);
    this.name = 'AmountParseError';
  }
}

/** "1.5" with 18 decimals → 1500000000000000000n. Rejects excess precision. */
export function parseUnits(input: string, decimals: number): bigint {
  const s = input.trim().replace(/,/g, '');
  if (s === '' || s === '.') throw new AmountParseError('EMPTY');
  if (s.startsWith('-')) throw new AmountParseError('NEGATIVE');
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new AmountParseError('FORMAT');
  const whole = m[1] || '0';
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new AmountParseError('PRECISION');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Exact decimal string, trailing zeros trimmed. */
export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Display formatting: up to `maxFraction` significant fraction digits, grouping,
 * and a "<0.0001" floor for dust so tiny balances never look like zero.
 */
export function formatDisplay(value: bigint, decimals: number, maxFraction = 6): string {
  if (value === 0n) return '0';
  const exact = formatUnits(value, decimals);
  const [whole, frac = ''] = exact.replace('-', '').split('.');
  const neg = value < 0n ? '-' : '';
  const digits = BigInt(whole!) >= 1000n ? 2 : maxFraction;
  const truncated = frac.slice(0, digits).replace(/0+$/, '');
  if (whole === '0' && truncated === '') {
    return `${neg}<0.${'0'.repeat(digits - 1)}1`;
  }
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg}${grouped}${truncated ? `.${truncated}` : ''}`;
}

/**
 * Converts base units to USD cents using a decimal-string price, in integers.
 * Returns cents as bigint (rounded down).
 */
export function toUsdCents(value: bigint, decimals: number, usdPrice: string): bigint {
  const PRICE_DECIMALS = 8;
  const price = parseUnits(truncateDecimals(usdPrice, PRICE_DECIMALS), PRICE_DECIMALS);
  // value/10^decimals * price/10^8 * 100
  return (value * price * 100n) / (10n ** BigInt(decimals) * 10n ** BigInt(PRICE_DECIMALS));
}

export function formatUsdCents(cents: bigint): string {
  const neg = cents < 0n;
  const c = neg ? -cents : cents;
  const dollars = (c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rem = (c % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}$${dollars}.${rem}`;
}

function truncateDecimals(s: string, d: number): string {
  const [w, f = ''] = s.split('.');
  return f ? `${w}.${f.slice(0, d)}` : w!;
}
