import { describe, expect, it } from 'vitest';
import { BITCOIN_GAP, ledgerState, recordDiscovery, reserveBitcoin } from './bitcoin-ledger';

describe('persistent Bitcoin reservations', () => {
  it('allocates only at signing and rejects racing or duplicate input reservations', () => {
    const initial = ledgerState();
    expect(initial.next).toBe(0);
    const first = reserveBitcoin(initial, 'first', ['a:0'], 0);
    expect(first.next).toBe(1);
    expect(() => reserveBitcoin(first, 'second', ['a:0'], 1)).toThrow(/reserved/);
    expect(() => reserveBitcoin(first, 'second', ['b:0'], 0)).toThrow(/stale/);
    expect(() => reserveBitcoin(initial, 'first', ['a:0', 'a:0'], 0)).toThrow();
  });
  it('persists reservations across reload and bounds unrecoverable gaps', () => {
    let state = ledgerState();
    for (let i = 0; i < BITCOIN_GAP; i++) state = reserveBitcoin(state, `t${i}`, [`${i}:0`], i);
    const restored = ledgerState(JSON.parse(JSON.stringify(state)));
    expect(restored.reservations['0:0']).toBe('t0');
    expect(() => reserveBitcoin(restored, 'overflow', ['extra:0'], 20)).toThrow(/gap/);
    const discovered = recordDiscovery(restored, 19);
    expect(reserveBitcoin(discovered, 'next', ['extra:0'], 20).next).toBe(21);
  });
  it('does not advance change for a transaction without change', () => {
    expect(reserveBitcoin(undefined, 'send-max', ['a:0']).next).toBe(0);
  });
  it('fails closed on corrupted metadata', () => {
    expect(() => ledgerState({ ...ledgerState(), next: -1 })).toThrow();
    expect(() => recordDiscovery(undefined, NaN)).toThrow();
  });
});
