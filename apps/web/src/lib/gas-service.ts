/**
 * Pure helpers for chain-balance display and the Gas Service Account.
 *
 * Balance queries have more states than "loading / error / data": react-query
 * keeps a query `pending` with no data while a retry is *paused* (the window
 * is in the background or the browser is offline). `isLoading` is false and
 * `isError` is false in that state, so code that assumed "not loading and not
 * an error ⇒ data" crashed on background participant windows. Everything that
 * shows a balance goes through `balanceView`, which only exposes data in the
 * `ready` state.
 */
import type { GasHealth, GasTransfer, RelayerChainStatus } from '@qd/rpc';
import { formatWeiAsEth } from './eth-amount';

export interface QueryLike<T> {
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  data: T | undefined;
  error: unknown;
}

export type BalanceView<T> =
  | { kind: 'no-address' }
  | { kind: 'loading' }
  | { kind: 'paused' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: T };

export function balanceView<T>(address: string | null | undefined, q: QueryLike<T>): BalanceView<T> {
  if (!address) return { kind: 'no-address' };
  if (q.status === 'success' && q.data !== undefined) return { kind: 'ready', data: q.data };
  if (q.status === 'error') return { kind: 'error', message: q.error instanceof Error && q.error.message ? q.error.message : 'balance unavailable' };
  if (q.fetchStatus === 'paused') return { kind: 'paused' };
  return { kind: 'loading' };
}

export const HEALTH_LABEL: Record<GasHealth, string> = {
  healthy: 'Healthy',
  low: 'Low balance',
  insufficient: 'Insufficient funds',
  unknown: 'Balance unavailable',
};

export const HEALTH_TONE: Record<GasHealth, string> = {
  healthy: 'bg-success-soft text-success',
  low: 'bg-warning-soft text-warning',
  insufficient: 'bg-danger-soft text-danger',
  unknown: 'bg-sunken text-subtle',
};

/** The account's health as reported by the API; never guessed from a missing balance. */
export function gasHealth(s: RelayerChainStatus | null | undefined): GasHealth {
  if (!s || !s.relayerConfigured || s.relayerBalanceWei === undefined || !s.health) return 'unknown';
  return s.health;
}

/** Exact ETH amount (never rounds a tiny requirement to 0). */
export function eth(wei: string | null | undefined, symbol = 'ETH'): string {
  if (wei === null || wei === undefined || !/^\d+$/.test(wei)) return 'unavailable';
  return `${formatWeiAsEth(wei)} ${symbol}`;
}

/** gwei with up to 9 decimals, for gas prices (Sepolia's are a few wei). */
export function gwei(wei: string | undefined): string {
  if (!wei || !/^\d+$/.test(wei)) return 'unavailable';
  const n = BigInt(wei);
  const whole = n / 1_000_000_000n;
  const frac = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} gwei`;
}

export const TRANSFER_KIND_LABEL: Record<GasTransfer['kind'], string> = {
  recharge: 'Recharge (incoming)',
  recharge_internal: 'Recharge via contract (incoming)',
  setup: 'Gas: one-time setup',
  execute: 'Gas: shared-wallet execution',
  other: 'Outgoing transaction',
};

/** Net effect of a history entry on the gas service balance, in wei (negative: spent). */
export function transferEffectWei(t: GasTransfer): bigint {
  const value = BigInt(/^\d+$/.test(t.valueWei) ? t.valueWei : '0');
  const fee = BigInt(/^\d+$/.test(t.feeWei) ? t.feeWei : '0');
  if (t.direction === 'in') return t.success ? value : 0n;
  return -(fee + (t.success ? value : 0n));
}

/** Number of incoming recharges, to notice a newly detected funding transaction. */
export function rechargeCount(ts: GasTransfer[] | undefined): number {
  return (ts ?? []).filter((t) => t.direction === 'in' && t.success).length;
}

/**
 * Network a balance widget starts on: the first of `chainIds` whose RPC and
 * gas service account work, else Sepolia (falling back to the first entry).
 */
export function preferredChain(chainIds: number[], status: RelayerChainStatus[] | undefined): number {
  const ready = status?.find((c) => chainIds.includes(c.chainId) && c.rpcOk && c.relayerConfigured);
  if (ready) return ready.chainId;
  return chainIds.includes(11155111) ? 11155111 : chainIds[0]!;
}
