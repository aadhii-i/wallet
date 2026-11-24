// Pinned values shared with services/wallet-api/internal/qdaccount (Go): the
// relayer and the browser must agree on addresses and on the signed message.
// They change whenever the contract bytecode changes (regenerate both sides).
import { describe, expect, it } from 'vitest';
import { accountAddress, executionMessage, factoryAddress, verifierAddress } from '../src';

const call = {
  nonce: 3n, to: `0x${'22'.repeat(20)}`, value: 10_000_000_000_000_000n, data: '0xdeadbeef',
  callGasLimit: 50_000n, validUntil: 1_800_000_000n, proposalDigest: `0x${'33'.repeat(32)}`,
} as const;

describe('cross-language vectors', () => {
  it('addresses and execution message', () => {
    expect(verifierAddress()).toBe('0xD2f338D9aa4F28fD669e76515FC91F8b872830cE');
    expect(factoryAddress()).toBe('0xCC9B4F663F3656e974ac38065933e6752AFDB1Df');
    const account = accountAddress(`0x${'11'.repeat(32)}`);
    expect(account).toBe('0xEf2d12c08016FE0E3aF45d10DE2f1C88b61e2aa4');
    expect(executionMessage(31337n, account, call)).toBe('0x23efda831e901b586d38c2cf9318928fe87e878b723eaddf51f21808d3821c68');
  });
});
