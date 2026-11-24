import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, pad, type Hex } from 'viem';
import { QdAccount } from '@qd/qd-account';
import type { WalletHistoryItem } from '@qd/rpc';
import { receiptEligible, verifyHistoryEntry } from './history-receipt';
import type { RawReceipt } from './verified-receipt';

const account = '0x420f1c166536b54715f70f733354ab8aab0052d9';
const recipient = '0x8e4ee0859fd55299e63eacf1f234ac1be7eb6cbe';
const relayer = '0x8c446ea9ce9280fd459ae7152faacd10f49ebdc4';
const hash = '0x6f25f9b440304e99ba7fc2cea03ae16e3b29f321fb83b3f97b8b1bbaf6bf3faa';
const value = 20_000_000_000_000_000n;

function executedLog(to = recipient, v = value, success = true, address = account) {
  const topics = encodeEventTopics({ abi: QdAccount.abi, eventName: 'Executed', args: { nonce: 0n, message: `0x${'aa'.repeat(32)}`, proposalDigest: `0x${'bb'.repeat(32)}` } });
  return { address, topics: topics as string[], data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [to as Hex, v, success]), logIndex: '0x1' };
}

const entry: WalletHistoryItem = {
  txHash: hash, logIndex: 1, kind: 'qd_execute', direction: 'sent', from: account, to: recipient, token: '', amount: value.toString(), success: true,
  txFrom: relayer, txTo: account, blockNumber: 12138441, blockTime: '2026-11-15T06:00:00Z', gasUsed: 10787755, gasPriceWei: '17', feeWei: '183391835', status: 'confirmed',
};
const receipt = (over: Partial<RawReceipt> = {}): RawReceipt => ({
  status: '0x1', blockNumber: `0x${(12138441).toString(16)}`, gasUsed: `0x${(10787755).toString(16)}`, effectiveGasPrice: '0x11', to: account, from: relayer, transactionHash: hash,
  logs: [{ address: '0xfffffffffffffffffffffffffffffffffffffffe', topics: [], data: '0x', logIndex: '0x0' }, executedLog()], ...over,
});
const tx = { hash, nonce: '0x10', from: relayer, to: account, value: '0x0' };
const block = { number: `0x${(12138441).toString(16)}`, timestamp: '0x6a0f2a40' };

describe('verifyHistoryEntry (receipts only for chain-confirmed entries)', () => {
  it('accepts the recorded Executed transfer and reports the gas actually paid', () => {
    const r = verifyHistoryEntry(entry, receipt(), tx, block);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.blockNumber).toBe(12138441);
    expect(r.facts.totalFeeWei).toBe(10787755n * 17n);
    expect(r.facts.feePayer).toBe(relayer);
  });
  it.each([
    ['reverted', receipt({ status: '0x0' }), /reverted/],
    ['other block', receipt({ blockNumber: '0x1' }), /another block/],
    ['other recipient', receipt({ logs: [executedLog('0x1111111111111111111111111111111111111111')] }), /does not match/],
    ['other amount', receipt({ logs: [executedLog(recipient, 1n)] }), /does not match/],
    ['inner call failed', receipt({ logs: [executedLog(recipient, value, false)] }), /does not match/],
    ['event from another contract', receipt({ logs: [executedLog(recipient, value, true, recipient)] }), /not from the shared account/],
    ['event missing', receipt({ logs: [] }), /not in the receipt/],
  ])('rejects: %s', (_n, r, why) => {
    const res = verifyHistoryEntry(entry, r as RawReceipt, tx, block);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(why);
  });
  it('checks native transfers against the transaction itself', () => {
    const e: WalletHistoryItem = { ...entry, kind: 'native', logIndex: -1, direction: 'received', from: relayer, to: account, amount: '5', txFrom: relayer };
    const t = { ...tx, value: '0x5' };
    expect(verifyHistoryEntry(e, receipt({ logs: [] }), t, block).ok).toBe(true);
    expect(verifyHistoryEntry(e, receipt({ logs: [] }), { ...t, value: '0x6' }, block).ok).toBe(false);
  });
  it('checks ERC-20 transfers against the Transfer log at the recorded index', () => {
    const token = '0x00000000000000000000000000000000000070c0';
    const log = { address: token, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(relayer as Hex), pad(account as Hex)], data: pad('0x4d2'), logIndex: '0x3' };
    const e: WalletHistoryItem = { ...entry, kind: 'erc20', logIndex: 3, direction: 'received', from: relayer, to: account, token, amount: '1234' };
    expect(verifyHistoryEntry(e, receipt({ logs: [log] }), tx, block).ok).toBe(true);
    expect(verifyHistoryEntry({ ...e, amount: '1235' }, receipt({ logs: [log] }), tx, block).ok).toBe(false);
  });
  it('offers receipts only for successful mined transactions', () => {
    expect(receiptEligible(entry)).toBe(true);
    expect(receiptEligible({ ...entry, success: false })).toBe(false);
    expect(receiptEligible({ ...entry, kind: 'internal', txHash: `internal:5:${account}` })).toBe(false);
  });
  it('checks an internal ETH transfer against its EIP-7708 log', () => {
    const log = { address: '0xfffffffffffffffffffffffffffffffffffffffe', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(account as Hex), pad(recipient as Hex)], data: pad('0x47'), logIndex: '0x2' };
    const e: WalletHistoryItem = { ...entry, kind: 'native', logIndex: 2, from: account, to: recipient, amount: '71' };
    expect(verifyHistoryEntry(e, receipt({ logs: [log] }), tx, block).ok).toBe(true);
    // The same log from a token contract is not native ETH.
    expect(verifyHistoryEntry(e, receipt({ logs: [{ ...log, address: recipient }] }), tx, block).ok).toBe(false);
  });
});
