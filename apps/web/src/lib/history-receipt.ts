/**
 * Verifies one Wallet History entry against the chain before a receipt is
 * shown or a PDF generated: the receipt is re-read on this device and must be
 * successful, in the recorded block, and contain exactly the recorded
 * transfer (the transaction's own value, the QdAccount Executed event or the
 * ERC-20 Transfer event at the recorded log index).
 */
import { decodeEventLog, type Hex } from 'viem';
import { QdAccount } from '@qd/qd-account';
import type { WalletHistoryItem } from '@qd/rpc';
import type { RawBlock, RawReceipt, RawTx } from './verified-receipt';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** EIP-7708: the system address that logs every native ETH transfer (Sepolia since Amsterdam). */
export const EIP7708_SYSTEM = '0xfffffffffffffffffffffffffffffffffffffffe';
const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const topicAddr = (t: string) => `0x${t.slice(-40)}`.toLowerCase();

export interface HistoryFacts {
  txHash: string;
  blockNumber: number;
  blockTimestamp: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  totalFeeWei: bigint;
  feePayer: string;
}

export type HistoryCheck = { ok: true; facts: HistoryFacts } | { ok: false; reason: string };

/** Entries that can have a receipt: a mined, successful transaction (not an inferred internal transfer). */
export function receiptEligible(e: Pick<WalletHistoryItem, 'kind' | 'success' | 'txHash'>): boolean {
  return e.success && e.kind !== 'internal' && /^0x[0-9a-f]{64}$/i.test(e.txHash);
}

export function verifyHistoryEntry(e: WalletHistoryItem, receipt: RawReceipt | null, tx: RawTx | null, block: RawBlock | null): HistoryCheck {
  if (!receiptEligible(e)) return { ok: false, reason: 'no receipt for this entry' };
  if (!receipt) return { ok: false, reason: 'not mined' };
  if (receipt.status !== '0x1') return { ok: false, reason: 'the transaction reverted' };
  if (BigInt(receipt.blockNumber) !== BigInt(e.blockNumber)) return { ok: false, reason: 'the transaction is in another block' };
  if (!tx || !eq(tx.hash, e.txHash) || !eq(receipt.transactionHash, e.txHash)) return { ok: false, reason: 'transaction not found' };
  if (!block || BigInt(block.number) !== BigInt(receipt.blockNumber)) return { ok: false, reason: 'block not found' };
  const amount = BigInt(e.amount);
  if (e.kind === 'native' && e.logIndex < 0) {
    if (!eq(tx.from, e.from) || !eq(tx.to ?? null, e.to) || BigInt(tx.value ?? '0x0') !== amount) return { ok: false, reason: 'the transaction does not match this entry' };
  } else {
    const log = receipt.logs.find((l) => l.logIndex !== undefined && BigInt(l.logIndex) === BigInt(e.logIndex));
    if (!log) return { ok: false, reason: 'the recorded event is not in the receipt' };
    if (e.kind === 'qd_execute') {
      if (!eq(log.address, e.from)) return { ok: false, reason: 'the event is not from the shared account' };
      let ev;
      try {
        ev = decodeEventLog({ abi: QdAccount.abi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      } catch {
        return { ok: false, reason: 'not an Executed event' };
      }
      const a = ev.args as { to: string; value: bigint; success: boolean };
      if (ev.eventName !== 'Executed' || !eq(a.to, e.to) || a.value !== amount || !a.success) return { ok: false, reason: 'the Executed event does not match this entry' };
    } else {
      // ERC-20 Transfer from the token, or (native) the EIP-7708 log of an internal ETH transfer.
      const emitter = e.kind === 'native' ? EIP7708_SYSTEM : e.token;
      if (!eq(log.address, emitter) || !eq(log.topics[0], TRANSFER_TOPIC) || log.topics.length !== 3) return { ok: false, reason: 'not a Transfer event of this asset' };
      if (topicAddr(log.topics[1]!) !== e.from.toLowerCase() || topicAddr(log.topics[2]!) !== e.to.toLowerCase() || BigInt(log.data) !== amount) {
        return { ok: false, reason: 'the Transfer event does not match this entry' };
      }
    }
  }
  const gasUsed = BigInt(receipt.gasUsed);
  const price = BigInt(receipt.effectiveGasPrice ?? '0x0');
  return {
    ok: true,
    facts: {
      txHash: receipt.transactionHash.toLowerCase(),
      blockNumber: Number(BigInt(receipt.blockNumber)),
      blockTimestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
      gasUsed,
      effectiveGasPrice: price,
      totalFeeWei: gasUsed * price,
      feePayer: receipt.from.toLowerCase(),
    },
  };
}
