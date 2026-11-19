import type { FeeTier } from '@qd/blockchain';
import type { BitcoinAddressType } from '@qd/blockchain';

/** Standard dust threshold for a P2WPKH output, in sats. */
export const DUST_LIMIT_SATS = 546n;

/** Anything above this is almost certainly a misconfigured node or a scam. */
export const MAX_FEE_RATE_SAT_VB = 5_000;

/** Core can return no estimate on an empty mempool; use this instead of 0. */
export const FLOOR_FEE_RATE_SAT_VB = 1;

/** Default confirmation targets per UI tier. */
export const FEE_TARGETS: Record<FeeTier, number> = { low: 6, market: 3, aggressive: 1 };

export function clampFeeRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return FLOOR_FEE_RATE_SAT_VB;
  return Math.min(Math.max(rate, FLOOR_FEE_RATE_SAT_VB), MAX_FEE_RATE_SAT_VB);
}

/**
 * Approximate virtual size in vB. Conservative (ceil) so the quoted fee is not
 * lower than the transaction the user actually signs.
 */
export function estimateVsize(
  inputCount: number,
  addressType: BitcoinAddressType,
  outputCount: number,
): number {
  if (inputCount <= 0) throw new RangeError('inputCount must be positive');
  if (outputCount <= 0) throw new RangeError('outputCount must be positive');
  // P2WPKH input ≈ 68 vB, P2TR key-path input ≈ 58 vB.
  const inputVb = addressType === 'p2tr' ? 58 : 68;
  // P2WPKH output ≈ 31 vB, P2TR output ≈ 43 vB.
  const outputVb = addressType === 'p2tr' ? 43 : 31;
  // Version + locktime + varints ≈ 11 vB.
  return Math.ceil(11 + inputCount * inputVb + outputCount * outputVb);
}

export function feeForVsize(vsize: number, feeRate: number): bigint {
  return BigInt(Math.ceil(vsize * clampFeeRate(feeRate)));
}

export function etaSeconds(targetBlocks: number): number {
  return targetBlocks * 600;
}
