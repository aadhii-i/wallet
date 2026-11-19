import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@qd/rpc';
import type { ApiAccount, ApiWallet } from '@qd/shared-types';
import {
  createAndRegisterHederaAccount,
  createStaleGuard,
  describeHederaError,
  findRemoteAccount,
  HederaLinkError,
  hederaPublicKeysMatch,
  readLinkedHederaAccount,
  registerExistingHederaAccount,
  withLinkedHederaAccount,
  type HederaCreateDeps,
  type HederaRegistrationDeps,
} from './hedera-link';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function account(walletId: string, hdIndex: number, id: string): ApiAccount {
  return {
    id,
    walletId,
    hdIndex,
    name: `Account ${hdIndex}`,
    signingMode: 'hd',
    hidden: false,
    addresses: [],
  };
}

function wallet(id: string, accounts: ApiAccount[]): ApiWallet {
  return {
    id,
    label: id,
    defaultSigningMode: 'hd',
    accounts,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function apiError(status: number, code: string, detail: string): ApiError {
  return new ApiError(status, code, { title: code, status, code, detail });
}

function expectKind(fn: () => unknown, kind: string) {
  try {
    fn();
    throw new Error('expected a HederaLinkError');
  } catch (e) {
    expect(e).toBeInstanceOf(HederaLinkError);
    expect((e as HederaLinkError).kind).toBe(kind);
  }
}

const KEY_INDEX_0 = '02' + '11'.repeat(32);
const KEY_INDEX_1 = '03' + '22'.repeat(32);

function registrationDeps(overrides: Partial<HederaRegistrationDeps> = {}): HederaRegistrationDeps {
  return {
    getRemoteAccount: vi.fn().mockResolvedValue(account('w1', 1, 'remote-1')),
    derivePublicKey: vi.fn().mockResolvedValue(KEY_INDEX_1),
    verifyOwnership: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Account switching while the public key is fetched
// ---------------------------------------------------------------------------

describe('public-key request guard', () => {
  it('ignores a late response for the previously selected account', () => {
    const guard = createStaleGuard();
    const applied: string[] = [];
    const apply = (token: number, key: string) => {
      if (guard.isCurrent(token)) applied.push(key);
    };

    // Account 0 request starts, then the user switches to account 1 before it
    // resolves. Both responses arrive, newest first.
    const oldToken = guard.begin();
    const newToken = guard.begin();
    apply(newToken, KEY_INDEX_1);
    apply(oldToken, KEY_INDEX_0);

    expect(applied).toEqual([KEY_INDEX_1]);
  });

  it('ignores responses after the sheet closes or the component unmounts', () => {
    const guard = createStaleGuard();
    const token = guard.begin();
    guard.invalidate();
    expect(guard.isCurrent(token)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The creation key belongs to the resolved HD index
// ---------------------------------------------------------------------------

describe('createAndRegisterHederaAccount', () => {
  it('derives a fresh key for the resolved index immediately before creation', async () => {
    const derivePublicKey = vi.fn().mockResolvedValue(KEY_INDEX_1);
    const createOnChain = vi.fn().mockResolvedValue({
      newAccountId: '0.0.5005',
      transactionId: 'tx-1',
    });
    const deps: HederaCreateDeps = {
      ...registrationDeps({ derivePublicKey }),
      createOnChain,
    };

    const outcome = await createAndRegisterHederaAccount(
      { hdIndex: 1, payerAccountId: '0.0.2', payerPrivateKeyHex: 'test-payer-key' },
      deps,
    );

    expect(derivePublicKey).toHaveBeenCalledWith(1);
    expect(createOnChain).toHaveBeenCalledWith({
      walletPublicKeyHex: KEY_INDEX_1,
      payerAccountId: '0.0.2',
      payerPrivateKeyHex: 'test-payer-key',
      hdIndex: 1,
      accountApiId: 'remote-1',
    });
    expect(outcome.hdIndex).toBe(1);
    expect(outcome.publicKeyHex).toBe(KEY_INDEX_1);
    expect(outcome.linked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Local mappings use the resolved HD index
// ---------------------------------------------------------------------------

describe('local Hedera account mappings', () => {
  it('writes and reads under the resolved index', () => {
    const next = withLinkedHederaAccount({ 0: '0.0.10' }, 1, '0.0.20');
    expect(next).toEqual({ 0: '0.0.10', 1: '0.0.20' });
    expect(readLinkedHederaAccount(next, 1)).toBe('0.0.20');
    expect(readLinkedHederaAccount(next, 0)).toBe('0.0.10');
  });

  it('does not return an account for an unlinked or undefined index', () => {
    expect(readLinkedHederaAccount({ 0: '0.0.10' }, 2)).toBeUndefined();
    expect(readLinkedHederaAccount({ 0: '0.0.10' }, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Remote lookup is scoped to the selected wallet
// ---------------------------------------------------------------------------

describe('findRemoteAccount', () => {
  const w1 = wallet('w1', [account('w1', 0, 'w1-a0')]);
  const w2 = wallet('w2', [account('w2', 0, 'w2-a0'), account('w2', 1, 'w2-a1')]);
  const wallets = [w1, w2];

  it('uses the selected wallet, even when another wallet has the same hdIndex', () => {
    expect(findRemoteAccount(wallets, 'w2', 0).id).toBe('w2-a0');
    expect(findRemoteAccount(wallets, 'w1', 0).id).toBe('w1-a0');
  });

  it('rejects a wallet id that is not on the backend', () => {
    expectKind(() => findRemoteAccount(wallets, 'missing', 0), 'WALLET_NOT_FOUND');
  });

  it('refuses to choose a wallet when none is selected', () => {
    expectKind(() => findRemoteAccount(wallets, undefined, 0), 'WALLET_NOT_SELECTED');
  });

  it('rejects a missing hdIndex instead of falling back', () => {
    expectKind(() => findRemoteAccount(wallets, 'w1', 3), 'ACCOUNT_NOT_SYNCED');
  });

  it('rejects ambiguous duplicate hdIndex rows instead of taking the first', () => {
    const duplicate = wallet('w3', [account('w3', 0, 'first'), account('w3', 0, 'second')]);
    expectKind(() => findRemoteAccount([duplicate], 'w3', 0), 'AMBIGUOUS_ACCOUNT');
  });
});

// ---------------------------------------------------------------------------
// 5. Registration failure after a successful creation is recoverable
// ---------------------------------------------------------------------------

describe('post-creation registration failure', () => {
  it('keeps the created account and transaction IDs and does not throw', async () => {
    const createOnChain = vi.fn().mockResolvedValue({
      newAccountId: '0.0.777',
      transactionId: 'tx-777',
    });
    const register = vi
      .fn()
      .mockRejectedValue(
        apiError(400, 'INVALID_OWNERSHIP', 'hedera: public key does not match account'),
      );
    const deps: HederaCreateDeps = { ...registrationDeps({ register }), createOnChain };

    const outcome = await createAndRegisterHederaAccount(
      { hdIndex: 1, payerAccountId: '0.0.2', payerPrivateKeyHex: 'test-payer-key' },
      deps,
    );

    expect(outcome.linked).toBe(false);
    expect(outcome.newAccountId).toBe('0.0.777');
    expect(outcome.transactionId).toBe('tx-777');
    expect(outcome.registrationError?.kind).toBe('OWNERSHIP_MISMATCH');
    expect(createOnChain).toHaveBeenCalledTimes(1);
  });

  it('treats a transient not-indexed 404 as retryable and preserves the IDs', async () => {
    const createOnChain = vi.fn().mockResolvedValue({
      newAccountId: '0.0.778',
      transactionId: 'tx-778',
    });
    const register = vi
      .fn()
      .mockRejectedValueOnce(
        apiError(404, 'HEDERA_ACCOUNT_NOT_FOUND', 'not visible on the Mirror Node yet'),
      )
      .mockResolvedValueOnce(undefined);
    const deps: HederaCreateDeps = { ...registrationDeps({ register }), createOnChain };

    const first = await createAndRegisterHederaAccount(
      { hdIndex: 1, payerAccountId: '0.0.2', payerPrivateKeyHex: 'test-payer-key' },
      deps,
    );

    expect(first.linked).toBe(false);
    expect(first.registrationError?.kind).toBe('ONCHAIN_ACCOUNT_NOT_FOUND');
    expect(first.newAccountId).toBe('0.0.778');
    expect(createOnChain).toHaveBeenCalledTimes(1);

    // Recovery reuses the same account and must not create another one.
    await registerExistingHederaAccount(
      { hdIndex: first.hdIndex, accountId: first.newAccountId },
      deps,
    );
    expect(createOnChain).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Retry uses the existing account and never creates another one
// ---------------------------------------------------------------------------

describe('registerExistingHederaAccount', () => {
  it('retries with the preserved account ID and a fresh key, without creating', async () => {
    const createOnChain = vi.fn().mockResolvedValue({
      newAccountId: '0.0.777',
      transactionId: 'tx-777',
    });
    const register = vi
      .fn()
      .mockRejectedValueOnce(apiError(503, 'HEDERA_NOT_CONFIGURED', 'verification unavailable'))
      .mockResolvedValueOnce(undefined);
    const derivePublicKey = vi.fn().mockResolvedValue(KEY_INDEX_1);
    const deps: HederaCreateDeps = {
      ...registrationDeps({ register, derivePublicKey }),
      createOnChain,
    };

    const first = await createAndRegisterHederaAccount(
      { hdIndex: 1, payerAccountId: '0.0.2', payerPrivateKeyHex: 'test-payer-key' },
      deps,
    );
    expect(first.linked).toBe(false);
    expect(first.registrationError?.kind).toBe('BACKEND_UNAVAILABLE');

    await registerExistingHederaAccount(
      { hdIndex: first.hdIndex, accountId: first.newAccountId },
      deps,
    );

    expect(createOnChain).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenLastCalledWith('remote-1', '0.0.777', KEY_INDEX_1);
  });

  it('re-derives the key for the stored index (not the currently visible one)', async () => {
    const derivePublicKey = vi.fn().mockResolvedValue(KEY_INDEX_0);
    const register = vi.fn().mockResolvedValue(undefined);
    const deps = registrationDeps({ derivePublicKey, register });

    await registerExistingHederaAccount({ hdIndex: 0, accountId: '0.0.10' }, deps);

    expect(derivePublicKey).toHaveBeenCalledWith(0);
    expect(register).toHaveBeenCalledWith('remote-1', '0.0.10', KEY_INDEX_0);
  });
});

// ---------------------------------------------------------------------------
// 7. Error categories
// ---------------------------------------------------------------------------

describe('describeHederaError', () => {
  it('maps the backend ownership code to an ownership mismatch', () => {
    const info = describeHederaError(
      apiError(400, 'INVALID_OWNERSHIP', 'hedera: public key does not match account'),
      'register',
    );
    expect(info.kind).toBe('OWNERSHIP_MISMATCH');
    expect(info.title).toBe('Ownership check failed');
  });

  it('maps a missing backend account to ACCOUNT_NOT_FOUND', () => {
    const info = describeHederaError(apiError(404, 'NOT_FOUND', ''), 'link');
    expect(info.kind).toBe('ACCOUNT_NOT_FOUND');
  });

  it('maps a not-yet-indexed Mirror Node account to a retryable category', () => {
    const info = describeHederaError(
      apiError(404, 'HEDERA_ACCOUNT_NOT_FOUND', 'retry registration'),
      'register',
    );
    expect(info.kind).toBe('ONCHAIN_ACCOUNT_NOT_FOUND');
    expect(info.description).toMatch(/wait a few seconds and retry/i);
    expect(info.description).toMatch(/does not require creating a new account/i);
  });

  it('maps an unreachable Mirror Node to BACKEND_UNAVAILABLE, not ownership', () => {
    const info = describeHederaError(
      apiError(503, 'HEDERA_VERIFICATION_FAILED', 'temporarily unavailable'),
      'register',
    );
    expect(info.kind).toBe('BACKEND_UNAVAILABLE');
  });

  it('maps an unavailable verifier to BACKEND_UNAVAILABLE', () => {
    const info = describeHederaError(
      apiError(503, 'HEDERA_NOT_CONFIGURED', 'hedera verification is not configured'),
      'register',
    );
    expect(info.kind).toBe('BACKEND_UNAVAILABLE');
  });

  it('does not treat every error mentioning "key" as an ownership mismatch', () => {
    const info = describeHederaError(new Error('private key unavailable'), 'link');
    expect(info.kind).not.toBe('OWNERSHIP_MISMATCH');
    expect(info.title).toBe('Could not link account');
    expect(info.description).toBe('private key unavailable');
  });

  it('classifies KeyWorker/vault errors separately', () => {
    const error = new Error('Vault is locked');
    error.name = 'VaultClientError';
    expect(describeHederaError(error, 'create').kind).toBe('KEY_UNAVAILABLE');
  });

  it('classifies transaction failures at the creation stage', () => {
    const info = describeHederaError(
      new Error('receipt contained error status INSUFFICIENT_PAYER_BALANCE'),
      'create',
    );
    expect(info.kind).toBe('TRANSACTION_FAILED');
    expect(info.title).toBe('Hedera account creation failed');
  });

  it('keeps unknown backend codes in the description', () => {
    const info = describeHederaError(apiError(422, 'SOMETHING_ELSE', 'detail'), 'register');
    expect(info.kind).toBe('UNKNOWN');
    expect(info.description).toContain('SOMETHING_ELSE');
  });
});

// ---------------------------------------------------------------------------
// On-chain key comparison (reference: 0.0.11474012's Admin Key)
// ---------------------------------------------------------------------------

describe('hederaPublicKeysMatch', () => {
  const reference = '0355a6d01130e6c87c65ac2e31245c20a0dc0411d30b2c7697ef73d7dbe17024c8';

  it('matches the same key regardless of case or a 0x prefix', () => {
    expect(hederaPublicKeysMatch(reference, reference.toUpperCase())).toBe(true);
    expect(hederaPublicKeysMatch(`0x${reference}`, reference)).toBe(true);
  });

  it('rejects a different key or an empty key', () => {
    expect(hederaPublicKeysMatch(reference, KEY_INDEX_0)).toBe(false);
    expect(hederaPublicKeysMatch('', '')).toBe(false);
  });
});
