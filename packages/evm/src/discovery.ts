import type { EvmAdapter } from './adapter';

export const DISCOVERY_GAP_LIMIT = 5;

/** Waits before retrying a failed lookup: rate-limited RPCs (HTTP 429) usually recover within a second. */
export const DISCOVERY_RETRY_DELAYS_MS: readonly number[] = [400, 1_200];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Account discovery on import (spec §14): scans indexes until `gap` consecutive
 * unused accounts. Returns used indexes (always includes 0).
 *
 * A lookup that fails is retried (`retryDelaysMs`) before the index is counted as
 * unused, so a briefly rate-limited RPC does not silently drop a used account.
 */
export async function discoverAccounts(
  adapters: readonly EvmAdapter[],
  addressAt: (index: number) => string,
  opts: { gap?: number; max?: number; retryDelaysMs?: readonly number[] } = {},
): Promise<number[]> {
  const gap = opts.gap ?? DISCOVERY_GAP_LIMIT;
  const max = opts.max ?? 50;
  const delays = opts.retryDelaysMs ?? DISCOVERY_RETRY_DELAYS_MS;
  const used: number[] = [];
  let emptyRun = 0;
  for (let i = 0; i < max && emptyRun < gap; i++) {
    const address = addressAt(i) as `0x${string}`;
    const results = await Promise.all(
      adapters.map(async (a) => {
        for (let attempt = 0; ; attempt++) {
          try {
            const [nonce, bal] = await Promise.all([
              a.client.getTransactionCount({ address }),
              a.client.getBalance({ address }),
            ]);
            return nonce > 0 || bal > 0n;
          } catch {
            if (attempt >= delays.length) return false;
            await sleep(delays[attempt]!);
          }
        }
      }),
    );
    if (results.some(Boolean)) {
      used.push(i);
      emptyRun = 0;
    } else {
      emptyRun++;
    }
  }
  return used.includes(0) ? used : [0, ...used];
}
