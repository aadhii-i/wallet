import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { QdAccount, executionMessage, type AccountCall } from '@qd/qd-account';
import { RECEIPT_DISCLAIMER, RECEIPT_TITLE, buildReceiptPdf, type VerifiedReceipt } from './receipt-pdf';
import { verifyExecutionReceipt, type RawReceipt } from './verified-receipt';

const account = '0x7df63db612ebed02fbca79e663a90924431b5a70' as Address;
const recipient = '0x1111111111111111111111111111111111111111' as Address;
const relayer = '0x8c446ea9ce9280fd459ae7152faacd10f49ebdc4';
const call: AccountCall = {
  nonce: 0n, to: recipient, value: 20_000_000_000_000_000n, data: '0x', callGasLimit: 21000n, validUntil: 1_900_000_000n,
  proposalDigest: `0x${'ab'.repeat(32)}`,
};
const message = executionMessage(11155111n, account, call);
const hash = `0x${'cd'.repeat(32)}`;

function executedLog(over: Partial<{ to: Address; value: bigint; success: boolean; nonce: bigint; message: Hex; digest: Hex; address: string }> = {}) {
  const topics = encodeEventTopics({
    abi: QdAccount.abi, eventName: 'Executed',
    args: { nonce: over.nonce ?? call.nonce, message: over.message ?? message, proposalDigest: over.digest ?? call.proposalDigest },
  });
  const data = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [over.to ?? recipient, over.value ?? call.value, over.success ?? true]);
  return { address: over.address ?? account, topics: topics as string[], data };
}

function receipt(over: Partial<RawReceipt> = {}): RawReceipt {
  return {
    status: '0x1', blockNumber: '0x10', gasUsed: '0xa76a5d', effectiveGasPrice: '0x11', to: account, from: relayer, transactionHash: hash,
    logs: [executedLog()], ...over,
  };
}

const ok = (r: RawReceipt | null) =>
  verifyExecutionReceipt({ receipt: r, tx: { hash, nonce: '0x5' }, block: { number: '0x10', timestamp: '0x6a0f2a40' }, account, call, message });

describe('verifyExecutionReceipt (only chain-verified executions get a receipt)', () => {
  it('accepts the exact approved transfer and reports chain facts', () => {
    const r = ok(receipt());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts).toMatchObject({ txHash: hash, blockNumber: 16, txNonce: 5, accountNonce: 0, to: recipient, valueWei: call.value, relayer, from: account });
    expect(r.facts.totalFeeWei).toBe(0xa76a5dn * 17n);
    expect(r.facts.blockTimestamp).toBe(new Date(0x6a0f2a40 * 1000).toISOString());
  });
  it.each([
    ['not mined', null, /not mined/],
    ['reverted', receipt({ status: '0x0' }), /reverted/],
    ['sent elsewhere', receipt({ to: recipient }), /not sent to the shared account/],
    ['wrong destination', receipt({ logs: [executedLog({ to: '0x2222222222222222222222222222222222222222' })] }), /does not match/],
    ['wrong amount', receipt({ logs: [executedLog({ value: 1n })] }), /does not match/],
    ['wrong digest', receipt({ logs: [executedLog({ digest: `0x${'00'.repeat(32)}` })] }), /does not match/],
    ['inner call failed', receipt({ logs: [executedLog({ success: false })] }), /transfer itself reverted/],
    ['other message (replayed signature for another call)', receipt({ logs: [executedLog({ message: `0x${'ee'.repeat(32)}` })] }), /no Executed event/],
    ['event from another contract', receipt({ logs: [executedLog({ address: recipient })] }), /no Executed event/],
    ['no logs', receipt({ logs: [] }), /no Executed event/],
  ])('rejects: %s', (_name, r, why) => {
    const res = ok(r as RawReceipt | null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(why);
  });
});

describe('buildReceiptPdf', () => {
  const r: VerifiedReceipt = {
    status: 'Confirmed', txHash: hash, explorerUrl: `https://sepolia.etherscan.io/tx/${hash}`, networkName: 'Sepolia Testnet', chainId: 11155111,
    from: account, to: recipient, amountEth: '0.02', symbol: 'ETH', blockNumber: 9_876_543, blockTimestamp: '2026-11-15T06:00:00.000Z', txNonce: 5,
    accountNonce: 0, gasUsed: '10971781', effectiveGasPriceWei: '17', totalFeeEth: '0.000000000186520277', relayer, policy: '2-of-3',
    signers: ['ADHIL (party 1)', 'NENA (party 2)'], signatureVerification: 'Verified by the coordinator, on this device and on chain', proposalId: 'p-1',
    generatedAt: '2026-11-15T06:01:00.000Z',
  };
  const pdf = buildReceiptPdf(r);
  const text = Array.from(pdf, (b) => String.fromCharCode(b)).join('');

  it('is a well-formed single-page PDF with a valid cross-reference table', () => {
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Count 1');
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    entries.forEach((off, i) => expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    const len = Number(/\/Length (\d+) >>\nstream\n/.exec(text)![1]);
    const start = text.indexOf('stream\n') + 7;
    expect(text.slice(start + len, start + len + 10)).toBe('\nendstream');
  });

  it('contains the transaction hash, a working Etherscan link, the title and the disclaimer', () => {
    // Long values are wrapped across lines; the joined text must contain them.
    const shown = [...text.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1]).join('');
    expect(shown).toContain(hash);
    expect(shown).toContain(account);
    expect(shown).toContain('0.02 ETH');
    expect(shown).toContain('2-of-3');
    expect(text).toContain(`/URI (https://sepolia.etherscan.io/tx/${hash})`);
    expect(text).toContain('/Subtype /Link');
    expect(RECEIPT_TITLE).toBe('QD Wallet — Sepolia Transaction Receipt');
    expect(text).toContain('QD Wallet \\227 Sepolia Transaction Receipt'); // em dash in WinAnsi
    const disclaimerStart = RECEIPT_DISCLAIMER.slice(0, 40);
    expect(shown.replace(/\s+/g, ' ')).toContain(disclaimerStart);
    expect(shown).not.toMatch(/official Etherscan/i);
  });
});
