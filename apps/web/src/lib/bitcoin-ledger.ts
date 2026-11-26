/** Public transaction metadata only. Private keys never enter this ledger. */
export interface BitcoinLedger {
  version: 1;
  next: number;
  highestUsed: number;
  reservations: Record<string, string>;
  signed: Record<string, { txid: string; raw: string; createdAt: number }>;
}

export const BITCOIN_GAP = 20;
export const BITCOIN_SCAN_LIMIT = 10000;
export function ledgerState(value?: BitcoinLedger): BitcoinLedger {
  const state = value ?? { version: 1, next: 0, highestUsed: -1, reservations: {}, signed: {} };
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.next) ||
    state.next < 0 ||
    state.next > BITCOIN_SCAN_LIMIT ||
    !Number.isSafeInteger(state.highestUsed) ||
    state.highestUsed < -1 ||
    state.highestUsed >= BITCOIN_SCAN_LIMIT ||
    !state.reservations ||
    !state.signed
  )
    throw new Error('Invalid Bitcoin metadata; rescan is required');
  return state;
}

export function recordDiscovery(value: BitcoinLedger | undefined, highestUsed: number): BitcoinLedger {
  const state = ledgerState(value);
  if (!Number.isSafeInteger(highestUsed) || highestUsed < -1 || highestUsed >= BITCOIN_SCAN_LIMIT)
    throw new Error('Bitcoin discovery limit reached');
  return {
    ...state,
    highestUsed: Math.max(state.highestUsed, highestUsed),
    next: Math.max(state.next, highestUsed + 1),
  };
}

/** Burn change before signing. A reviewed migration may conflict with an old
 * signed payment; retain its original reservation and evidence permanently. */
export function reserveBitcoin(
  value: BitcoinLedger | undefined,
  id: string,
  points: string[],
  changeIndex?: number,
  migration = false,
): BitcoinLedger {
  const state = ledgerState(value);
  if (!id || points.length === 0 || new Set(points).size !== points.length)
    throw new Error('Invalid input reservation');
  for (const point of points)
    if (state.reservations[point] && !migration) throw new Error('A selected coin is reserved by another transaction');
  if (changeIndex !== undefined && (!Number.isSafeInteger(changeIndex) || changeIndex < 0 || changeIndex >= BITCOIN_SCAN_LIMIT || changeIndex !== state.next || changeIndex > state.highestUsed + BITCOIN_GAP)) {
    throw new Error('Change address is stale or the recovery gap is full; refresh or reconcile pending transactions');
  }
  return {
    ...state,
    next: state.next + (changeIndex === undefined ? 0 : 1),
    reservations: { ...state.reservations, ...Object.fromEntries(points.map((point) => [point, state.reservations[point] ?? id])) },
  };
}
