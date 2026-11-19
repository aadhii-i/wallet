import type { BitcoinAddressType } from '@qd/blockchain';
import { WalletError } from '@qd/blockchain';
import { DUST_LIMIT_SATS, clampFeeRate, estimateVsize } from './fees';
import type { BtcUtxo } from './types';

export interface CoinSelection {
  inputs: BtcUtxo[];
  total: bigint;
  change: bigint;
  fee: bigint;
  vsize: number;
}

/**
 * Largest-first selection. Deterministic and easy to review on the confirmation
 * screen; branch-and-bound would save fees but adds a lot of surface for V1.
 *
 * Change below the dust threshold is dropped into the fee rather than creating
 * an unspendable output.
 */
export function selectCoins(
  utxos: readonly BtcUtxo[],
  target: bigint,
  feeRate: number,
  addressType: BitcoinAddressType,
): CoinSelection {
  if (target <= 0n) throw new RangeError('target must be positive');
  const rate = clampFeeRate(feeRate);
  const sorted = [...utxos]
    .filter((u) => u.value >= DUST_LIMIT_SATS)
    .sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1));

  const selected: BtcUtxo[] = [];
  let total = 0n;
  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;
    const vsizeNoChange = estimateVsize(selected.length, addressType, 1);
    const feeNoChange = BigInt(Math.ceil(vsizeNoChange * rate));
    if (total < target + feeNoChange) continue;

    const vsizeWithChange = estimateVsize(selected.length, addressType, 2);
    const feeWithChange = BigInt(Math.ceil(vsizeWithChange * rate));
    const change = total - target - feeWithChange;
    if (change >= DUST_LIMIT_SATS) {
      return { inputs: selected, total, change, fee: feeWithChange, vsize: vsizeWithChange };
    }
    // Change would be dust: everything left over becomes fee.
    return { inputs: selected, total, change: 0n, fee: total - target, vsize: vsizeNoChange };
  }

  throw new WalletError({
    code: 'INSUFFICIENT_FUNDS',
    userTitle: 'Not enough Bitcoin',
    userMessage: 'The available balance does not cover this amount plus the network fee.',
    fundsMoved: 'no',
    retryable: false,
  });
}

/** Sum of spendable outputs. */
export function totalSats(utxos: readonly BtcUtxo[]): bigint {
  return utxos.reduce((acc, u) => acc + u.value, 0n);
}
