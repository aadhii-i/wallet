import { describe, expect, it } from 'vitest';
import { btcAddressProofMessage } from './sync';

/**
 * Tests for the pure helpers exported from sync.ts.
 *
 * The full syncWithBackend / syncBitcoinAddresses flow depends on browser
 * globals (vault worker, IndexedDB, fetch) and cannot run in vitest.  The
 * critical correctness property is that the message format produced here
 * exactly matches:
 *   - BTC_PROOF_RE in key-worker.ts (enforced by the KeyWorker before signing)
 *   - BtcAddressRegistrationMessage in the Go backend (enforced before persisting)
 *
 * Both validate the same six-field pipe-separated format.
 */

describe('btcAddressProofMessage', () => {
  it('produces the expected pipe-separated format', () => {
    const msg = btcAddressProofMessage(
      'acc-id-1',
      'mainnet',
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      'user-id-1',
    );
    expect(msg).toBe(
      'QDWallet-BTC|v1|acc-id-1|mainnet|bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu|user-id-1',
    );
  });

  it('works for testnet4', () => {
    const msg = btcAddressProofMessage('acc-id-2', 'testnet4', 'tb1qaddr', 'user-id-2');
    expect(msg).toBe('QDWallet-BTC|v1|acc-id-2|testnet4|tb1qaddr|user-id-2');
  });

  it('has exactly six fields', () => {
    const msg = btcAddressProofMessage('a', 'mainnet', 'b', 'c');
    expect(msg.split('|')).toHaveLength(6);
  });

  it('starts with the fixed prefix', () => {
    const msg = btcAddressProofMessage('a', 'mainnet', 'b', 'c');
    expect(msg.startsWith('QDWallet-BTC|v1|')).toBe(true);
  });

  it('matches the BTC_PROOF_RE pattern used by the KeyWorker', () => {
    // This is the exact regex from key-worker.ts.  The test confirms that a
    // message produced by this helper would pass the worker's format check.
    const BTC_PROOF_RE =
      /^QDWallet-BTC\|v1\|[0-9a-f-]{36}\|(mainnet|testnet4)\|([a-z0-9]+)\|[0-9a-f-]{36}$/;
    const accountId = '12345678-1234-4000-8000-123456789abc';
    const userId = 'abcdef12-abcd-4000-8000-abcdef123456';
    const address = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
    const msg = btcAddressProofMessage(accountId, 'mainnet', address, userId);
    expect(BTC_PROOF_RE.test(msg)).toBe(true);
  });

  it('does not match the regex when network is invalid', () => {
    const BTC_PROOF_RE =
      /^QDWallet-BTC\|v1\|[0-9a-f-]{36}\|(mainnet|testnet4)\|([a-z0-9]+)\|[0-9a-f-]{36}$/;
    const accountId = '12345678-1234-4000-8000-123456789abc';
    const userId = 'abcdef12-abcd-4000-8000-abcdef123456';
    // 'regtest' is not an accepted network in the regex.
    const msg = btcAddressProofMessage(accountId, 'regtest' as never, 'bc1qaddr', userId);
    expect(BTC_PROOF_RE.test(msg)).toBe(false);
  });
});
