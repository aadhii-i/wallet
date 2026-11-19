import { ApiError } from '@qd/rpc';
import type { ApiAccount, ApiWallet } from '@qd/shared-types';

/**
 * Pure helpers for Hedera account linking and post-creation registration.
 *
 * Keeping the account resolution, index handling and error classification here
 * (instead of inline in the receive sheet) makes the correctness properties
 * testable without a browser worker or a live network.
 */

export type HederaErrorKind =
  | 'OWNERSHIP_MISMATCH'
  | 'ONCHAIN_ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_NOT_SYNCED'
  | 'WALLET_NOT_SELECTED'
  | 'WALLET_NOT_FOUND'
  | 'AMBIGUOUS_ACCOUNT'
  | 'BACKEND_UNAVAILABLE'
  | 'KEY_UNAVAILABLE'
  | 'TRANSACTION_FAILED'
  | 'INVALID_REQUEST'
  | 'UNKNOWN';

export interface HederaErrorInfo {
  kind: HederaErrorKind;
  title: string;
  description: string;
}

/** An error whose category is already known (not inferred from message text). */
export class HederaLinkError extends Error {
  constructor(
    readonly kind: HederaErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'HederaLinkError';
  }
}

const TITLES: Record<HederaErrorKind, string> = {
  OWNERSHIP_MISMATCH: 'Public key does not match this account',
  ONCHAIN_ACCOUNT_NOT_FOUND: 'Hedera account not found',
  ACCOUNT_NOT_FOUND: 'Wallet account not found',
  ACCOUNT_NOT_SYNCED: 'Account not synced with backend',
  WALLET_NOT_SELECTED: 'Wallet not selected',
  WALLET_NOT_FOUND: 'Wallet not synced with backend',
  AMBIGUOUS_ACCOUNT: 'Ambiguous backend account',
  BACKEND_UNAVAILABLE: 'Backend unavailable',
  KEY_UNAVAILABLE: 'Wallet key unavailable',
  TRANSACTION_FAILED: 'Hedera transaction failed',
  INVALID_REQUEST: 'Invalid request',
  UNKNOWN: 'Something went wrong',
};

const NETWORK_ERROR_RE =
  /failed to fetch|networkerror|network request failed|econnrefused|etimedout|load failed|fetch failed/i;

export type HederaOperationStage = 'link' | 'create' | 'register' | 'transfer';

/**
 * Maps an error to a user-facing category. The backend/API code is preserved
 * where it is meaningful; message text is never pattern-matched to decide
 * whether a key mismatch occurred.
 */
export function describeHederaError(
  error: unknown,
  stage: HederaOperationStage = 'link',
): HederaErrorInfo {
  if (error instanceof HederaLinkError) {
    return { kind: error.kind, title: TITLES[error.kind], description: error.message };
  }

  if (error instanceof ApiError) {
    switch (error.code) {
      case 'INVALID_OWNERSHIP':
        return {
          kind: 'OWNERSHIP_MISMATCH',
          title: 'Ownership check failed',
          description:
            'The backend could not verify that this wallet account controls the Hedera account. Select the account whose public key matches the account’s Admin Key and try again.',
        };
      case 'NOT_FOUND':
        return {
          kind: 'ACCOUNT_NOT_FOUND',
          title: TITLES.ACCOUNT_NOT_FOUND,
          description:
            'The selected wallet account is not registered with the backend. Reopen the wallet to sync, then try again.',
        };
      case 'HEDERA_ACCOUNT_NOT_FOUND':
        return {
          kind: 'ONCHAIN_ACCOUNT_NOT_FOUND',
          title: 'Hedera account not indexed yet',
          description:
            'The account exists on Hedera but the Mirror Node has not indexed it yet. Wait a few seconds and retry — this does not require creating a new account.',
        };
      case 'HEDERA_VERIFICATION_FAILED':
        return {
          kind: 'BACKEND_UNAVAILABLE',
          title: 'Hedera verification unavailable',
          description: 'The backend could not reach the Mirror Node. Try again shortly.',
        };
      case 'HEDERA_NOT_CONFIGURED':
        return {
          kind: 'BACKEND_UNAVAILABLE',
          title: 'Hedera verification unavailable',
          description: 'The backend cannot verify Hedera accounts right now. Try again later.',
        };
      case 'INVALID_BODY':
        return {
          kind: 'INVALID_REQUEST',
          title: TITLES.INVALID_REQUEST,
          description: error.message,
        };
      default:
        if (error.status === 401) {
          return {
            kind: 'KEY_UNAVAILABLE',
            title: 'Session expired',
            description: 'Unlock the wallet and try again.',
          };
        }
        if (error.status >= 500) {
          return {
            kind: 'BACKEND_UNAVAILABLE',
            title: TITLES.BACKEND_UNAVAILABLE,
            description: `The backend returned ${error.status}. Try again shortly.`,
          };
        }
        return {
          kind: 'UNKNOWN',
          title: 'Backend registration failed',
          description: `${error.code}: ${error.message}`,
        };
    }
  }

  if (error instanceof Error) {
    if (error.name === 'VaultClientError') {
      return {
        kind: 'KEY_UNAVAILABLE',
        title: TITLES.KEY_UNAVAILABLE,
        description: error.message,
      };
    }
    if (NETWORK_ERROR_RE.test(error.message)) {
      return {
        kind: 'BACKEND_UNAVAILABLE',
        title: TITLES.BACKEND_UNAVAILABLE,
        description: 'Could not reach the network. Check your connection and try again.',
      };
    }
    if (stage === 'create') {
      return {
        kind: 'TRANSACTION_FAILED',
        title: 'Hedera account creation failed',
        description: error.message,
      };
    }
    if (stage === 'transfer') {
      return {
        kind: 'TRANSACTION_FAILED',
        title: 'HBAR transfer failed',
        description: error.message,
      };
    }
    if (stage === 'register') {
      return {
        kind: 'UNKNOWN',
        title: 'Account created, registration failed',
        description: error.message,
      };
    }
    return {
      kind: 'UNKNOWN',
      title: 'Could not link account',
      description: error.message,
    };
  }

  return {
    kind: 'UNKNOWN',
    title: TITLES.UNKNOWN,
    description: 'An unexpected error occurred.',
  };
}

/**
 * Resolves the backend wallet that owns the selected local account. If no
 * wallet id is known, only a single backend wallet is accepted — never an
 * arbitrary first match.
 */
export function selectWallet(wallets: readonly ApiWallet[], walletApiId?: string): ApiWallet {
  if (walletApiId) {
    const wallet = wallets.find((w) => w.id === walletApiId);
    if (!wallet) {
      throw new HederaLinkError(
        'WALLET_NOT_FOUND',
        'The selected wallet is not synced with the backend yet.',
      );
    }
    return wallet;
  }
  if (wallets.length === 1) return wallets[0]!;
  if (wallets.length === 0) {
    throw new HederaLinkError('WALLET_NOT_FOUND', 'No wallet is synced with the backend yet.');
  }
  throw new HederaLinkError(
    'WALLET_NOT_SELECTED',
    'Select a wallet before linking a Hedera account.',
  );
}

/**
 * Finds the backend account for `hdIndex`, scoped to the selected wallet.
 * Refuses to guess when the match is missing or ambiguous.
 */
export function findRemoteAccount(
  wallets: readonly ApiWallet[],
  walletApiId: string | undefined,
  hdIndex: number,
): ApiAccount {
  const wallet = selectWallet(wallets, walletApiId);
  const matches = wallet.accounts.filter((a) => a.hdIndex === hdIndex);
  if (matches.some((a) => a.walletId !== wallet.id)) {
    throw new HederaLinkError(
      'AMBIGUOUS_ACCOUNT',
      'The backend returned an account that does not belong to the selected wallet.',
    );
  }
  if (matches.length === 0) {
    throw new HederaLinkError(
      'ACCOUNT_NOT_SYNCED',
      `HD account ${hdIndex} is not synced with the selected wallet on the backend.`,
    );
  }
  if (matches.length > 1) {
    throw new HederaLinkError(
      'AMBIGUOUS_ACCOUNT',
      `The selected wallet has ${matches.length} backend accounts with HD index ${hdIndex}. Refusing to guess which one to use.`,
    );
  }
  return matches[0]!;
}

/** Reads the linked Hedera Account ID for a resolved HD index. */
export function readLinkedHederaAccount(
  ids: Record<number, string> | undefined,
  hdIndex: number | undefined,
): string | undefined {
  if (hdIndex === undefined) return undefined;
  return ids?.[hdIndex];
}

/** Writes a linked Hedera Account ID under the resolved HD index. */
export function withLinkedHederaAccount(
  ids: Record<number, string>,
  hdIndex: number,
  accountId: string,
): Record<number, string> {
  return { ...ids, [hdIndex]: accountId };
}

/** Normalizes a compressed public key for comparison (lowercase, no 0x). */
export function normalizeHederaPublicKey(key: string): string {
  return key.trim().toLowerCase().replace(/^0x/, '');
}

/** Compares the on-chain Admin Key with the wallet's derived public key. */
export function hederaPublicKeysMatch(onChainKey: string, walletPublicKeyHex: string): boolean {
  const a = normalizeHederaPublicKey(onChainKey);
  const b = normalizeHederaPublicKey(walletPublicKeyHex);
  return a.length > 0 && a === b;
}

/**
 * Guards async state updates against an account switch or unmount. Only the
 * token from the most recent `begin()` (and not invalidated) may be applied.
 */
export interface StaleGuard {
  begin(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
}

export function createStaleGuard(): StaleGuard {
  let epoch = 0;
  return {
    begin() {
      epoch += 1;
      return epoch;
    },
    isCurrent(token) {
      return token === epoch;
    },
    invalidate() {
      epoch += 1;
    },
  };
}

export interface HederaRegistrationDeps {
  getRemoteAccount(hdIndex: number): Promise<ApiAccount>;
  derivePublicKey(hdIndex: number): Promise<string>;
  verifyOwnership(accountId: string, publicKeyHex: string): Promise<void>;
  register(accountApiId: string, accountId: string, publicKeyHex: string): Promise<void>;
}

export interface HederaCreateDeps extends HederaRegistrationDeps {
  createOnChain(input: {
    walletPublicKeyHex: string;
    payerAccountId: string;
    payerPrivateKeyHex: string;
    hdIndex: number;
    accountApiId: string;
  }): Promise<{ newAccountId: string; transactionId: string }>;
}

export interface HederaCreatedAccount {
  hdIndex: number;
  newAccountId: string;
  transactionId: string;
  publicKeyHex: string;
  linked: boolean;
  registrationError?: HederaErrorInfo;
}

/**
 * Links an already-created Hedera account to a backend account:
 * derive the key at the resolved index, verify the on-chain Admin Key, then
 * register. Never creates an account.
 */
export async function registerExistingHederaAccount(
  input: { hdIndex: number; accountId: string },
  deps: HederaRegistrationDeps,
): Promise<{ publicKeyHex: string }> {
  const { hdIndex, accountId } = input;
  const remote = await deps.getRemoteAccount(hdIndex);
  const publicKeyHex = await deps.derivePublicKey(hdIndex);
  await deps.verifyOwnership(accountId, publicKeyHex);
  await deps.register(remote.id, accountId, publicKeyHex);
  return { publicKeyHex };
}

/**
 * Creates an account on-chain with a freshly derived key for the resolved HD
 * index, then attempts ownership verification and backend registration.
 *
 * A post-creation registration failure is returned (not thrown) so the caller
 * can keep the created account ID / transaction ID and offer a retry without
 * submitting another CREATE ACCOUNT transaction.
 */
export async function createAndRegisterHederaAccount(
  input: { hdIndex: number; payerAccountId: string; payerPrivateKeyHex: string },
  deps: HederaCreateDeps,
): Promise<HederaCreatedAccount> {
  const { hdIndex, payerAccountId, payerPrivateKeyHex } = input;

  // Resolve the backend account before spending anything on-chain.
  const remote = await deps.getRemoteAccount(hdIndex);

  // Derive immediately before creation. The key and the index come from the
  // same resolved account, never from cached UI state.
  const publicKeyHex = await deps.derivePublicKey(hdIndex);

  const { newAccountId, transactionId } = await deps.createOnChain({
    walletPublicKeyHex: publicKeyHex,
    payerAccountId,
    payerPrivateKeyHex,
    hdIndex,
    accountApiId: remote.id,
  });

  let registrationError: HederaErrorInfo | undefined;
  try {
    await deps.verifyOwnership(newAccountId, publicKeyHex);
    await deps.register(remote.id, newAccountId, publicKeyHex);
  } catch (error) {
    registrationError = describeHederaError(error, 'register');
  }

  return {
    hdIndex,
    newAccountId,
    transactionId,
    publicKeyHex,
    linked: registrationError === undefined,
    ...(registrationError ? { registrationError } : {}),
  };
}
