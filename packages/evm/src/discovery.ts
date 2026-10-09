import type { EvmAdapter } from './adapter';

export const DISCOVERY_GAP_LIMIT = 5;

/**
 * Account discovery on import (spec §14): scans indexes until `gap` consecutive
 * unused accounts. Returns used indexes (always includes 0).
 */
export async function discoverAccounts(
  adapters: readonly EvmAdapter[],
  addressAt: (index: number) => string,
  opts: { gap?: number; max?: number } = {},
): Promise<number[]> {
  const gap = opts.gap ?? DISCOVERY_GAP_LIMIT;
  const max = opts.max ?? 50;
  const used: number[] = [];
  let emptyRun = 0;
  for (let i = 0; i < max && emptyRun < gap; i++) {
    const address = addressAt(i) as `0x${string}`;
    const results = await Promise.all(
      adapters.map(async (a) => {
        try {
          const [nonce, bal] = await Promise.all([
            a.client.getTransactionCount({ address }),
            a.client.getBalance({ address }),
          ]);
          return nonce > 0 || bal > 0n;
        } catch {
          return false;
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
