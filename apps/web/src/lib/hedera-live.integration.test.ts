/**
 * LIVE Hedera Testnet end-to-end integration.
 *
 * This test is skipped unless `HEDERA_LIVE=1` is set, so normal `vitest run`
 * never touches the network. It exercises the exact cryptography the KeyWorker
 * performs (HDKeyring.withHederaPrivateKey + @hashgraph/sdk) against the real
 * Testnet:
 *
 *   1. Derive the wallet's Hedera key at m/44'/3030'/0'/0/0.
 *   2. Fund a new account with that key from a payer account.
 *   3. Read the new Account ID from the transaction receipt.
 *   4. Verify the account exists on the Mirror Node and that its key matches.
 *   5. Read the new account's HBAR balance from the Mirror Node.
 *   6. Send HBAR from the new account back to the payer, signed by the
 *      wallet-derived key.
 *   7. Read the transfer receipt status.
 *
 * Required environment (never hardcode secrets):
 *   HEDERA_LIVE=1
 *   HEDERA_PAYER_ID=0.0.x
 *   HEDERA_PAYER_KEY=<32-byte hex private key>
 */
import { describe, it, expect } from 'vitest';
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  PublicKey,
  TransactionId,
  TransferTransaction,
} from '@hashgraph/sdk';
import { HDKeyring } from '@qd/wallet-core';

const RUN = process.env.HEDERA_LIVE === '1';
const PAYER_ID = process.env.HEDERA_PAYER_ID ?? '';
const PAYER_KEY = (process.env.HEDERA_PAYER_KEY ?? '').replace(/^0x/i, '');
const MNEMONIC = 'test test test test test test test test test test test junk';
const MIRROR = 'https://testnet.mirrornode.hedera.com/api/v1';
const TINYBARS_PER_HBAR = 100_000_000n;
const INITIAL_BALANCE = 10n * TINYBARS_PER_HBAR; // 10 HBAR
const TRANSFER_AMOUNT = 1_000_000n; // 0.01 HBAR

async function mirrorGet(path: string): Promise<any> {
  const res = await fetch(`${MIRROR}${path}`);
  if (!res.ok) throw new Error(`Mirror node ${path} -> ${res.status}`);
  return res.json();
}

/** The Mirror Node indexes a few seconds after consensus; poll until it appears. */
async function mirrorGetWithRetry(path: string, attempts = 20, intervalMs = 1500): Promise<any> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await mirrorGet(path);
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastError;
}

describe.skipIf(!RUN)('Hedera Testnet live end-to-end', () => {
  it('creates an account and sends HBAR, confirmed by Testnet', async () => {
    expect(PAYER_ID, 'HEDERA_PAYER_ID is required').toMatch(/^\d+\.\d+\.\d+$/);
    expect(PAYER_KEY, 'HEDERA_PAYER_KEY is required').toMatch(/^[0-9a-fA-F]{64}$/);

    // 1. Derive the wallet's Hedera key at m/44'/3030'/0'/0/0.
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const walletPubKey = keyring.hederaPublicKey(0);
    console.log('\n[1] Wallet Hedera public key (index 0):', walletPubKey);

    // Payer sanity check: confirm the key controls the account.
    const payerAcct = await mirrorGet(`/accounts/${PAYER_ID}`);
    expect(payerAcct.key.key).toBe(PrivateKey.fromStringECDSA(PAYER_KEY).publicKey.toStringRaw());
    const payerBalance = BigInt(payerAcct.balance.balance);
    console.log('[2] Payer', PAYER_ID, 'balance:', payerBalance.toString(), 'tinybars (~' + payerBalance / TINYBARS_PER_HBAR + ' HBAR)');

    const client = Client.forTestnet();
    client.setDefaultMaxTransactionFee(new Hbar(20));
    try {
      // 3. Build the AccountCreateTransaction keyed to the wallet's derived key.
      const createTx = new AccountCreateTransaction()
        .setKey(PublicKey.fromString(walletPubKey))
        .setInitialBalance(Hbar.fromTinybars(String(INITIAL_BALANCE)))
        .setTransactionId(TransactionId.generate(AccountId.fromString(PAYER_ID)))
        .setNodeAccountIds([new AccountId(3)])
        .freeze();

      // 4. Sign with the payer key (required) and the new account's key (proof of intent).
      PrivateKey.fromStringECDSA(PAYER_KEY).signTransaction(createTx);
      keyring.withHederaPrivateKey(0, (pk) => {
        PrivateKey.fromBytesECDSA(pk).signTransaction(createTx);
      });

      // 5. Submit and read the receipt.
      const createResponse = await createTx.execute(client);
      const createTxId = createResponse.transactionId.toString();
      const createReceipt = await createResponse.getReceipt(client);
      const newAccountId = createReceipt.accountId?.toString();
      console.log('[3] Account-create tx:', createTxId);
      console.log('[3] Account-create receipt status:', createReceipt.status.toString());
      console.log('[3] New Account ID:', newAccountId);
      console.log('[3] HashScan:', `https://hashscan.io/testnet/transaction/${createTxId}`);
      expect(newAccountId).toBeTruthy();
      expect(createReceipt.status.toString()).toBe('SUCCESS');

      // 6. Verify on the Mirror Node: account exists and its key matches.
      const newAcct = await mirrorGetWithRetry(`/accounts/${newAccountId}`);
      console.log('[4] Mirror account exists:', newAcct.account);
      console.log('[4] Mirror account key:', newAcct.key.key);
      expect(newAcct.account).toBe(newAccountId);
      expect(newAcct.key.key).toBe(walletPubKey);

      // 7. Read the new account's HBAR balance from the Mirror Node.
      const newBalance = BigInt(newAcct.balance.balance);
      console.log('[5] New account balance:', newBalance.toString(), 'tinybars (~' + newBalance / TINYBARS_PER_HBAR + ' HBAR)');
      expect(newBalance).toBeGreaterThanOrEqual(INITIAL_BALANCE - 1_000_000n);

      // 8. Send HBAR FROM the new account back to the payer, signed by the wallet key.
      const transferTx = new TransferTransaction()
        .addHbarTransfer(AccountId.fromString(newAccountId!), Hbar.fromTinybars(String(-TRANSFER_AMOUNT)))
        .addHbarTransfer(AccountId.fromString(PAYER_ID), Hbar.fromTinybars(String(TRANSFER_AMOUNT)))
        .setTransactionId(TransactionId.generate(AccountId.fromString(newAccountId!)))
        .setNodeAccountIds([new AccountId(3)])
        .freeze();

      keyring.withHederaPrivateKey(0, (pk) => {
        PrivateKey.fromBytesECDSA(pk).signTransaction(transferTx);
      });

      const transferResponse = await transferTx.execute(client);
      const transferTxId = transferResponse.transactionId.toString();
      const transferReceipt = await transferResponse.getReceipt(client);
      console.log('[6] HBAR transfer tx:', transferTxId);
      console.log('[6] HBAR transfer receipt status:', transferReceipt.status.toString());
      console.log('[6] HashScan:', `https://hashscan.io/testnet/transaction/${transferTxId}`);
      expect(transferReceipt.status.toString()).toBe('SUCCESS');

      // 9. Confirm the transfer landed by re-reading the payer balance.
      const payerAfter = await mirrorGet(`/accounts/${PAYER_ID}`);
      console.log('[7] Payer balance after transfer:', BigInt(payerAfter.balance.balance).toString(), 'tinybars');

      console.log('\n=== END-TO-END SUCCESS (confirmed by Hedera Testnet) ===');
      console.log('New Account ID :', newAccountId);
      console.log('Create tx      :', createTxId);
      console.log('Transfer tx    :', transferTxId);
    } finally {
      client.close();
    }
  }, 300_000);
});
