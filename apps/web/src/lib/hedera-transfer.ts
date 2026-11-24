'use client';
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PublicKey,
  Transaction,
  TransactionId,
  TransferTransaction,
} from '@hashgraph/sdk';
// PrivateKey is imported for the type only — actual signing happens in the KeyWorker.
import type { PrivateKey } from '@hashgraph/sdk';
import { HederaLinkError, hederaPublicKeysMatch } from './hedera-link';
import { vault } from './vault-client';

void (undefined as unknown as PrivateKey); // type-only import anchor

// ---------------------------------------------------------------------------
// Pure helpers — no SDK calls, safe to unit-test without a worker or network.
// ---------------------------------------------------------------------------

const TINYBARS_PER_HBAR = 100_000_000n;
const HBAR_DECIMALS = 8;

/** Formats a tinybar amount as a human-readable HBAR string (8 decimal places). */
export function tinybarsToHbarDisplay(tinybars: bigint): string {
  if (tinybars < 0n) {
    return '-' + tinybarsToHbarDisplay(-tinybars);
  }
  const whole = tinybars / TINYBARS_PER_HBAR;
  const frac = tinybars % TINYBARS_PER_HBAR;
  const fracStr = frac.toString().padStart(HBAR_DECIMALS, '0');
  return `${whole}.${fracStr}`;
}

/** Parses an HBAR display string (up to 8 decimals) into tinybars. Throws on invalid input. */
export function hbarDisplayToTinybars(hbar: string): bigint {
  const trimmed = hbar.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(trimmed)) {
    throw new Error(`Invalid HBAR amount: ${trimmed}`);
  }
  const [wholePart, fracPart = ''] = trimmed.split('.');
  const fracPadded = fracPart.padEnd(HBAR_DECIMALS, '0');
  return BigInt(wholePart!) * TINYBARS_PER_HBAR + BigInt(fracPadded);
}

const ACCOUNT_ID_RE = /^\d+\.\d+\.\d+$/;

/** Returns true if the string is a valid Hedera Account ID (shard.realm.num). */
export function isValidHederaAccountId(id: string): boolean {
  return ACCOUNT_ID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Transfer params / result
// ---------------------------------------------------------------------------

export interface HederaTransferParams {
  fromAccountId: string;
  toAccountId: string;
  amountTinybars: bigint;
  hdIndex: number;
  accountApiId: string;
}

export interface HederaTransferResult {
  transactionId: string;
  /** Receipt status returned by the network. Only "SUCCESS" is a confirmed send. */
  status: string;
}

/**
 * Thrown when a transfer was submitted but its receipt did not report SUCCESS.
 * Carries the transaction ID so the UI can still link to HashScan.
 */
export class HederaTransferError extends Error {
  constructor(
    readonly transactionId: string,
    readonly status: string,
    message: string,
  ) {
    super(message);
    this.name = 'HederaTransferError';
  }
}

/** True only for the one receipt status that means the transfer succeeded. */
export function isSuccessfulHederaReceipt(status: string): boolean {
  return status === 'SUCCESS';
}

/** Extracts a receipt status from an SDK ReceiptStatusError-like object. */
function receiptStatusOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (status !== undefined && status !== null) {
      return String(status);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Builds, signs (via KeyWorker), and submits a native HBAR transfer on Hedera Testnet.
 *
 * The private key never leaves the KeyWorker. This function:
 *   1. Validates inputs.
 *   2. Builds an operator-less TransferTransaction and serialises it.
 *   3. Issues a confirmation token binding the payload to what was reviewed.
 *   4. Sends the payload to the KeyWorker for signing.
 *   5. Reconstructs the signed transaction and submits via the SDK client.
 *   6. Waits for the receipt and returns its status; anything other than
 *      SUCCESS is reported as a failure (with the transaction ID preserved).
 */
export async function buildAndSubmitHbarTransfer(
  params: HederaTransferParams,
): Promise<HederaTransferResult> {
  const { fromAccountId, toAccountId, amountTinybars, hdIndex, accountApiId } = params;

  // Input validation — these also run in the worker, but front-loading them
  // gives a fast error before any worker or network call.
  if (amountTinybars <= 0n) {
    throw new Error('amountTinybars must be a positive integer');
  }
  if (!isValidHederaAccountId(fromAccountId)) {
    throw new Error(`Invalid fromAccountId: ${fromAccountId}`);
  }
  if (!isValidHederaAccountId(toAccountId)) {
    throw new Error(`Invalid toAccountId: ${toAccountId}`);
  }
  if (fromAccountId === toAccountId) {
    throw new Error('fromAccountId and toAccountId must differ');
  }

  // Build an operator-less TransferTransaction and freeze it.
  // Use String(bigint) for Hbar.fromTinybars to avoid Number(bigint) precision loss above 2^53-1.
  const tx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(fromAccountId), Hbar.fromTinybars(String(-amountTinybars)))
    .addHbarTransfer(AccountId.fromString(toAccountId), Hbar.fromTinybars(String(amountTinybars)))
    .setNodeAccountIds([new AccountId(3)])
    .setTransactionId(TransactionId.generate(AccountId.fromString(fromAccountId)))
    .freeze();

  const transactionBytes = bytesToBase64(tx.toBytes());

  // Build the signing payload.
  const signingPayload = {
    kind: 'hedera-transfer' as const,
    fromAccountId,
    toAccountId,
    amountTinybars: String(amountTinybars),
    transactionBytes,
  };

  // Issue a confirmation token that binds the payload to what the user reviewed.
  const confirmation = await vault.call('issueConfirmation', { payload: signingPayload });

  // Send to KeyWorker for signing.
  const result = await vault.call('sign', {
    account: { id: accountApiId, hdIndex },
    payload: signingPayload,
    confirmation,
  });

  if (result.kind !== 'hedera-transfer') {
    throw new Error(`Unexpected signature kind: ${result.kind}`);
  }

  // Reconstruct the signed transaction from base64 bytes.
  const signedTx = Transaction.fromBytes(base64ToBytes(result.signedBytes));

  // Execute on Testnet (submission only — no operator needed for a pre-signed tx).
  const client = Client.forTestnet();
  try {
    const response = await signedTx.execute(client);
    const transactionId = response.transactionId.toString();

    // A submitted transaction is not a successful one: wait for the network
    // receipt and require SUCCESS before reporting the send as confirmed.
    try {
      const receipt = await response.getReceipt(client);
      const status = receipt.status.toString();
      if (!isSuccessfulHederaReceipt(status)) {
        throw new HederaTransferError(
          transactionId,
          status,
          `Hedera transaction ${transactionId} failed with status ${status}`,
        );
      }
      return { transactionId, status };
    } catch (error) {
      if (error instanceof HederaTransferError) throw error;
      const status = receiptStatusOf(error) ?? 'UNKNOWN';
      const detail = error instanceof Error ? error.message : String(error);
      throw new HederaTransferError(
        transactionId,
        status,
        status === 'UNKNOWN'
          ? `Hedera transaction ${transactionId} was submitted but its receipt could not be confirmed: ${detail}`
          : `Hedera transaction ${transactionId} failed with status ${status}`,
      );
    }
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// Hedera account creation
// ---------------------------------------------------------------------------

export interface HederaAccountCreateParams {
  /** Wallet's Hedera public key (66-char hex) from vault.call('hederaPublicKey'). */
  walletPublicKeyHex: string;
  /** Hedera Testnet Account ID of the fee payer (user input, never stored). */
  payerAccountId: string;
  /** Payer's raw private-key hex (portal key, UI input, cleared immediately). */
  payerPrivateKeyHex: string;
  /** HD index of the wallet account whose derived key may also sign. */
  hdIndex: number;
  /** Backend account API id. */
  accountApiId: string;
  /**
   * Initial HBAR balance for the new account, in tinybars. Defaults to 10 HBAR
   * so the new account can pay its own transaction fees immediately.
   */
  initialBalanceTinybars?: bigint;
}

export interface HederaAccountCreateResult {
  newAccountId: string;
  transactionId: string;
}

/**
 * Builds, signs (via KeyWorker), and submits a Hedera AccountCreateTransaction
 * on Testnet. The payer key and wallet derived key never leave the KeyWorker.
 *
 *   1. Builds an operator-less AccountCreateTransaction keyed to the wallet's
 *      public key and serialises it.
 *   2. Issues a confirmation token binding the payload to what was reviewed.
 *   3. Sends the payload (with the raw payer key hex) to the KeyWorker for
 *      signing; the worker wipes the key after use.
 *   4. Reconstructs the signed transaction and submits via the SDK client.
 *   5. Reads the new Account ID from the transaction receipt (mirror-node poll
 *      as a fallback).
 *
 * Returns the new Account ID and the transaction ID.
 */
export async function buildAndSubmitHederaAccountCreate(
  params: HederaAccountCreateParams,
): Promise<HederaAccountCreateResult> {
  const { walletPublicKeyHex, payerAccountId, payerPrivateKeyHex, hdIndex, accountApiId } = params;
  const initialBalanceTinybars = params.initialBalanceTinybars ?? 10n * TINYBARS_PER_HBAR;

  // Input validation — mirrored in the worker, but front-loaded for fast errors.
  if (!isValidHederaAccountId(payerAccountId)) {
    throw new Error(`Invalid payerAccountId: ${payerAccountId}`);
  }
  if (!/^[0-9a-fA-F]{66}$/.test(walletPublicKeyHex)) {
    throw new Error('Invalid wallet public key: expected 66-char hex');
  }
  if (initialBalanceTinybars < 0n) {
    throw new Error('initialBalanceTinybars must not be negative');
  }

  // Build the unsigned AccountCreateTransaction and freeze it.
  // The new account is controlled by the wallet's derived Hedera public key
  // and is funded from the payer so it can pay its own fees.
  const tx = new AccountCreateTransaction()
    .setKey(PublicKey.fromString(walletPublicKeyHex))
    .setInitialBalance(Hbar.fromTinybars(String(initialBalanceTinybars)))
    .setTransactionId(TransactionId.generate(AccountId.fromString(payerAccountId)))
    .setNodeAccountIds([new AccountId(3)])
    .freeze();

  const transactionBytes = bytesToBase64(tx.toBytes());

  // Build the signing payload (payerPrivateKeyHex is raw hex, only in this call).
  const signingPayload = {
    kind: 'hedera-account-create' as const,
    transactionBytes,
    payerAccountId,
    payerPrivateKeyHex,
    walletHdIndex: hdIndex,
  };

  // Issue a confirmation token that binds the payload to what the user reviewed.
  const confirmation = await vault.call('issueConfirmation', { payload: signingPayload });

  // Send to KeyWorker for signing.
  const result = await vault.call('sign', {
    account: { id: accountApiId, hdIndex },
    payload: signingPayload,
    confirmation,
  });

  if (result.kind !== 'hedera-account-create') {
    throw new Error(`Unexpected signature kind: ${result.kind}`);
  }

  // Reconstruct the signed transaction from base64 bytes.
  const signedTx = Transaction.fromBytes(base64ToBytes(result.signedBytes));

  // Execute on Testnet (submission only — no operator needed for a pre-signed tx).
  const client = Client.forTestnet();
  try {
    const response = await signedTx.execute(client);
    // The receipt's accountId is the new Account ID — the most reliable method.
    const receipt = await response.getReceipt(client);
    const newAccountId = receipt.accountId?.toString();
    if (newAccountId) {
      return { newAccountId, transactionId: response.transactionId.toString() };
    }
    // Fallback: poll the mirror node for the receipt's new account ID.
    const polled = await pollForNewAccount(response.transactionId.toString());
    return { newAccountId: polled, transactionId: response.transactionId.toString() };
  } finally {
    client.close();
  }
}

/**
 * Fallback: polls the Hedera mirror node until the transaction receipt reveals
 * the newly created account ID.
 */
export async function pollForNewAccount(
  transactionId: string,
  mirrorNodeUrl = 'https://testnet.mirrornode.hedera.com/api/v1',
): Promise<string> {
  const maxAttempts = 20;
  const intervalMs = 3000;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${mirrorNodeUrl}/transactions/${encodeURIComponent(transactionId)}`);
      if (!res.ok) throw new Error(`Mirror node returned ${res.status}`);
      const json = await res.json();
      const accountId =
        json?.receipt?.account_id ??
        json?.transactions?.[0]?.receipt?.account_id ??
        json?.transactions?.[0]?.receipt?.accountId;
      if (accountId) return String(accountId);
    } catch {
      // Retry on transient network errors.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Could not determine new account ID from receipt or mirror node');
}

// ---------------------------------------------------------------------------
// Read-only helpers (no signing, no keys)
// ---------------------------------------------------------------------------

/** Fetches the HBAR balance of a Hedera Testnet account from the mirror node. */
export async function getHederaAccountBalance(
  accountId: string,
  mirrorNodeUrl = 'https://testnet.mirrornode.hedera.com/api/v1',
): Promise<{ tinybars: bigint; hbar: string }> {
  const res = await fetch(`${mirrorNodeUrl}/accounts/${encodeURIComponent(accountId)}`);
  if (!res.ok) throw new Error(`Mirror node returned ${res.status} for account ${accountId}`);
  const json = await res.json();
  const balance = json?.balance?.balance ?? 0;
  const tinybars = BigInt(balance);
  return {
    tinybars,
    hbar: tinybarsToHbarDisplay(tinybars),
  };
}

/** Fetches the transaction receipt from the Hedera mirror node to confirm
 * status and (for account creation) the new Account ID.
 */
export async function getTransactionReceipt(
  transactionId: string,
  mirrorNodeUrl = 'https://testnet.mirrornode.hedera.com/api/v1',
): Promise<{ status: string; accountId?: string }> {
  const res = await fetch(`${mirrorNodeUrl}/transactions/${encodeURIComponent(transactionId)}`);
  if (!res.ok) throw new Error(`Mirror node returned ${res.status} for transaction ${transactionId}`);
  const json = await res.json();
  const tx = json?.transactions?.[0];
  const receipt = tx?.receipt ?? json?.receipt;
  return {
    status: receipt?.status ?? tx?.status ?? 'UNKNOWN',
    accountId: receipt?.account_id ?? receipt?.accountId ?? undefined,
  };
}

export interface HederaAccountKey {
  type: string;
  key: string;
}

export interface MirrorKeyLookupOptions {
  /** Total attempts while the Mirror Node reports 404. Defaults to 6. */
  attempts?: number;
  /** Delay between attempts in milliseconds. Defaults to 1000. */
  intervalMs?: number;
}

const DEFAULT_KEY_LOOKUP_ATTEMPTS = 6;
const DEFAULT_KEY_LOOKUP_INTERVAL_MS = 1000;

/**
 * Reads the on-chain key of a Hedera Testnet account from the mirror node.
 * Read-only — no signing, no transaction.
 *
 * A 404 is retried for a short, bounded window: accounts created moments ago
 * are routinely accepted by the network before the Mirror Node indexes them,
 * so a single immediate 404 does not prove the account is absent.
 */
export async function getHederaAccountKey(
  accountId: string,
  mirrorNodeUrl = 'https://testnet.mirrornode.hedera.com/api/v1',
  options: MirrorKeyLookupOptions = {},
): Promise<HederaAccountKey> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? DEFAULT_KEY_LOOKUP_ATTEMPTS));
  const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_KEY_LOOKUP_INTERVAL_MS);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const res = await fetch(`${mirrorNodeUrl}/accounts/${encodeURIComponent(accountId)}`);
    if (res.status === 404) {
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      break;
    }
    if (!res.ok) throw new Error(`Mirror node returned ${res.status} for account ${accountId}`);
    const json = await res.json();
    const key = json?.key?.key;
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`Mirror node returned no key for Hedera account ${accountId}`);
    }
    return {
      type: typeof json?.key?._type === 'string' ? json.key._type : '',
      key,
    };
  }

  throw new HederaLinkError(
    'ONCHAIN_ACCOUNT_NOT_FOUND',
    `Hedera account ${accountId} is not visible on Testnet yet. It may still be indexing — wait a few seconds and retry.`,
  );
}

/**
 * Verifies that `publicKeyHex` is the Admin Key of `accountId` before asking
 * the backend to register it. This is the same on-chain comparison the backend
 * performs, surfaced early with a precise error category.
 */
export async function verifyHederaAccountOwnership(
  accountId: string,
  publicKeyHex: string,
  mirrorNodeUrl = 'https://testnet.mirrornode.hedera.com/api/v1',
  options: MirrorKeyLookupOptions = {},
): Promise<void> {
  const onChain = await getHederaAccountKey(accountId, mirrorNodeUrl, options);
  if (onChain.type && onChain.type !== 'ECDSA_SECP256K1') {
    throw new HederaLinkError(
      'OWNERSHIP_MISMATCH',
      `Hedera account ${accountId} is not controlled by an ECDSA_SECP256K1 key.`,
    );
  }
  if (!hederaPublicKeysMatch(onChain.key, publicKeyHex)) {
    throw new HederaLinkError(
      'OWNERSHIP_MISMATCH',
      `The on-chain Admin Key for ${accountId} does not match the selected wallet account.`,
    );
  }
}

/** HashScan Testnet explorer URL for a transaction. */
export function hederaTransactionExplorerUrl(transactionId: string): string {
  return `https://hashscan.io/testnet/transaction/${transactionId}`;
}

/** HashScan Testnet explorer URL for an account. */
export function hederaAccountExplorerUrl(accountId: string): string {
  return `https://hashscan.io/testnet/account/${accountId}`;
}
