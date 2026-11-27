'use client';
import { Client, Transaction } from '@hashgraph/sdk';
import * as H from '@qd/hedera';
import { fromB64url } from '@qd/rpc';
import { getApi } from './api';

export type HederaRelayMessage = { id: string; from: string; kind: string; session: string; payload: string };
export function hederaContent<T>(message: HederaRelayMessage): T {
  return JSON.parse(new TextDecoder().decode(fromB64url(message.payload))) as T;
}
export async function readHederaMessages(wallet: string, account: string, session = 'enrollment') {
  const messages = (await (await getApi()).hederaSharedMessages(wallet, account, session)).messages;
  const shape: Record<string, string[]> = {
    enrollment: ['participantId', 'publicKey', 'proof', 'raccoonPublicKey'],
    policy: ['policyId'],
    link: ['accountId'],
    binding: ['policyId', 'accountId'],
    creation: ['id', 'transactionId'],
    proposal: ['id', 'policyId', 'from', 'to', 'amount', 'maxFee', 'transactionBytes'],
    approve: ['message', 'nonce'],
    r1: ['payload'],
    r2: ['payload'],
    r3: ['payload'],
    partial: ['signature', 'publicKey'],
    final: ['transactionId'],
  };
  for (const message of messages) {
    const value = hederaContent<Record<string, unknown>>(message),
      fields = shape[message.kind];
    if (
      !value ||
      typeof value !== 'object' ||
      !fields ||
      fields.some((f) => typeof value[f] !== 'string') ||
      (message.kind === 'proposal' &&
        (!/^[1-9][0-9]*$/.test(String(value.amount)) || !/^[1-9][0-9]*$/.test(String(value.maxFee))))
    )
      throw new Error('Invalid shared Hedera relay message');
  }
  return messages;
}
export function hederaBindingMessage(policy: H.HederaSharedPolicy, accountId: string) {
  return `bind:${H.hederaAccountId(accountId)}`;
}

/** Submit exactly the saved native bytes. Expiry or uncertain delivery must
 * never cause the SDK to silently create a new transaction ID/payment. */
export async function submitSharedHedera(signed: {
  raw: string;
  transactionId: string;
  expiresAt: number;
  intentMemo: string;
}) {
  if (Date.now() >= signed.expiresAt)
    throw new Error('This signed transaction expired. Check its saved result before preparing another.');
  const transaction = Transaction.fromBytes(H.hederaWireBytes(signed.raw));
  if (transaction.transactionId?.toString() !== signed.transactionId)
    throw new Error('Saved Hedera transaction ID mismatch');
  if (
    transaction.transactionMemo !== signed.intentMemo ||
    !/^QDWallet:[0-9a-f-]{36}:[A-Za-z0-9_-]{43}$/.test(signed.intentMemo)
  )
    throw new Error('Saved Hedera operation commitment mismatch');
  const client = Client.forTestnet();
  client.setDefaultRegenerateTransactionId(false);
  client.setRequestTimeout(15000);
  client.setMaxAttempts(2);
  try {
    const response = await transaction.execute(client);
    if (response.transactionId.toString() !== signed.transactionId)
      throw new Error('Submitted Hedera transaction ID mismatch');
    const receipt = await response.getReceipt(client),
      status = receipt.status.toString();
    if (status !== 'SUCCESS')
      throw new Error(`Hedera returned ${status}. Check the saved result; a network fee may have been charged.`);
    if (transaction.transactionMemo !== signed.intentMemo) throw new Error('Signed Hedera intent differs from review');
    const api = await getApi();
    let indexed = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = await api.hederaSharedReceipt(signed.transactionId);
      if (record.found) {
        if (record.result !== 'SUCCESS' || record.intentMemo !== signed.intentMemo)
          throw new Error('The indexed receipt belongs to another operation or is not successful');
        indexed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!indexed)
      throw new Error(
        'A SUCCESS receipt was received, but the exact operation is not indexed yet. Check the saved transaction before retrying.',
      );
    return {
      transactionId: signed.transactionId,
      status,
      ...(receipt.accountId ? { accountId: receipt.accountId.toString() } : {}),
    };
  } finally {
    client.close();
  }
}
