/**
 * Checks a shared-wallet execution against the chain, independently of the
 * API's status: the receipt must be successful, sent to the shared
 * QdAccount, and carry that account's Executed event for exactly the
 * approved call (nonce, recipient, value, proposal digest, signed message)
 * with success = true. Only then is a receipt shown or a PDF generated.
 */
import { decodeEventLog, type Hex } from 'viem';
import { QdAccount, type AccountCall } from '@qd/qd-account';

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  logIndex?: string;
}
export interface RawReceipt {
  status: string;
  blockNumber: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  to: string | null;
  from: string;
  transactionHash: string;
  logs: RawLog[];
}
export interface RawTx {
  hash: string;
  nonce: string;
  from?: string;
  to?: string | null;
  value?: string;
}
export interface RawBlock {
  number: string;
  timestamp: string;
}

export interface ReceiptFacts {
  txHash: string;
  blockNumber: number;
  blockTimestamp: string; // ISO, from the block
  txNonce: number;
  accountNonce: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  totalFeeWei: bigint;
  from: string; // shared account
  to: string; // recipient (from the event)
  valueWei: bigint;
  relayer: string; // transaction sender (gas payer)
}

export type ReceiptCheck = { ok: true; facts: ReceiptFacts } | { ok: false; reason: string };

const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function verifyExecutionReceipt(input: {
  receipt: RawReceipt | null;
  tx: RawTx | null;
  block: RawBlock | null;
  account: string;
  call: AccountCall;
  message: Hex;
}): ReceiptCheck {
  const { receipt, tx, block, account, call, message } = input;
  if (!receipt) return { ok: false, reason: 'no receipt yet (not mined)' };
  if (receipt.status !== '0x1') return { ok: false, reason: 'the transaction reverted' };
  if (!eq(receipt.to, account)) return { ok: false, reason: 'the transaction was not sent to the shared account' };
  if (!tx || !eq(tx.hash, receipt.transactionHash)) return { ok: false, reason: 'transaction not found' };
  if (!block || BigInt(block.number) !== BigInt(receipt.blockNumber)) return { ok: false, reason: 'block not found' };
  for (const log of receipt.logs) {
    if (!eq(log.address, account)) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: QdAccount.abi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
    } catch {
      continue;
    }
    if (ev.eventName !== 'Executed') continue;
    const a = ev.args as { nonce: bigint; message: Hex; proposalDigest: Hex; to: string; value: bigint; success: boolean };
    if (!eq(a.message, message)) continue;
    if (a.nonce !== call.nonce || !eq(a.to, call.to) || a.value !== call.value || !eq(a.proposalDigest, call.proposalDigest)) {
      return { ok: false, reason: 'the executed operation does not match the approved proposal' };
    }
    if (!a.success) return { ok: false, reason: 'the account consumed the nonce but the transfer itself reverted' };
    const gasUsed = BigInt(receipt.gasUsed);
    const price = BigInt(receipt.effectiveGasPrice ?? '0x0');
    return {
      ok: true,
      facts: {
        txHash: receipt.transactionHash.toLowerCase(),
        blockNumber: Number(BigInt(receipt.blockNumber)),
        blockTimestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
        txNonce: Number(BigInt(tx.nonce)),
        accountNonce: Number(a.nonce),
        gasUsed,
        effectiveGasPrice: price,
        totalFeeWei: gasUsed * price,
        from: account.toLowerCase(),
        to: a.to.toLowerCase(),
        valueWei: a.value,
        relayer: receipt.from.toLowerCase(),
      },
    };
  }
  return { ok: false, reason: 'no Executed event for the signed message from the shared account' };
}
