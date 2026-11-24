import type { ActivityItem, ApiBtcTransaction } from '@qd/shared-types';
import type { Page } from '@qd/blockchain';

/** Account-level classification excludes internal change from the sent amount. */
export function classifyBitcoinTransaction(
  tx: ApiBtcTransaction,
  addresses: ReadonlySet<string>,
  template: ActivityItem,
): ActivityItem {
  const spends = tx.inputs.some((i) => i.address && addresses.has(i.address));
  const received = tx.outputs.filter((o) => o.address && addresses.has(o.address));
  const external = tx.outputs.filter((o) => !o.address || !addresses.has(o.address));
  const amount = (spends ? external : received).reduce((n, o) => n + BigInt(o.value), 0n);
  return {
    ...template,
    direction: spends ? (external.length ? 'out' : 'self') : 'in',
    amount: amount.toString(),
    status: tx.status,
    ...(tx.fee !== undefined ? { fee: tx.fee } : {}),
    from:
      tx.inputs.find((i) => i.address && (spends ? addresses.has(i.address) : !addresses.has(i.address)))?.address ??
      '',
    to: (spends ? external : received).find((o) => o.address)?.address ?? template.to,
  };
}

/** Bounded full discovery, then deterministic pagination. Failure is never an empty history. */
export async function bitcoinWalletHistory(
  addresses: readonly string[],
  cursor: string | undefined,
  history: (address: string, cursor?: string) => Promise<Page<ActivityItem>>,
  detail: (txid: string) => Promise<ApiBtcTransaction>,
): Promise<Page<ActivityItem>> {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000) throw new Error('Invalid Bitcoin history cursor');
  const items = new Map<string, ActivityItem>();
  for (const address of addresses) {
    let next: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; ; page++) {
      if (page >= 200 || items.size > 5000) throw new Error('Bitcoin history scan limit reached');
      const result = await history(address, next);
      for (const item of result.items) items.set(item.hash, item);
      next = result.nextCursor;
      if (!next) break;
      if (seen.has(next)) throw new Error('Bitcoin history cursor did not advance');
      seen.add(next);
    }
  }
  const ordered = [...items.values()].sort(
    (a, b) => b.timestamp.localeCompare(a.timestamp) || a.hash.localeCompare(b.hash),
  );
  const selected: ActivityItem[] = [];
  const owned = new Set(addresses);
  for (const item of ordered.slice(offset, offset + 25)) {
    selected.push(classifyBitcoinTransaction(await detail(item.hash), owned, item));
  }
  return { items: selected, ...(offset + 25 < ordered.length ? { nextCursor: String(offset + 25) } : {}) };
}
