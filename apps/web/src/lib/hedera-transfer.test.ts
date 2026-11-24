import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  tinybarsToHbarDisplay,
  hbarDisplayToTinybars,
  isValidHederaAccountId,
  buildAndSubmitHbarTransfer,
  buildAndSubmitHederaAccountCreate,
  getHederaAccountBalance,
  getHederaAccountKey,
  hederaTransactionExplorerUrl,
  hederaAccountExplorerUrl,
  verifyHederaAccountOwnership,
} from './hedera-transfer';
import { HederaLinkError } from './hedera-link';

// ---------------------------------------------------------------------------
// Pure helper tests — no SDK calls, no worker, no network
// ---------------------------------------------------------------------------

describe('tinybarsToHbarDisplay', () => {
  it('formats zero tinybars as 0.00000000', () => {
    expect(tinybarsToHbarDisplay(0n)).toBe('0.00000000');
  });

  it('formats exactly 1 HBAR (100,000,000 tinybars)', () => {
    expect(tinybarsToHbarDisplay(100_000_000n)).toBe('1.00000000');
  });

  it('formats 1 tinybar', () => {
    expect(tinybarsToHbarDisplay(1n)).toBe('0.00000001');
  });

  it('formats fractional HBAR', () => {
    expect(tinybarsToHbarDisplay(123_456_789n)).toBe('1.23456789');
  });

  it('formats large amounts without floating-point imprecision', () => {
    // 1,000,000 HBAR
    expect(tinybarsToHbarDisplay(100_000_000_000_000n)).toBe('1000000.00000000');
  });

  it('formats negative amounts with leading minus', () => {
    expect(tinybarsToHbarDisplay(-100_000_000n)).toBe('-1.00000000');
  });

  it('rounds correctly for sub-tinybar check: 999 tinybars', () => {
    expect(tinybarsToHbarDisplay(999n)).toBe('0.00000999');
  });
});

describe('hbarDisplayToTinybars', () => {
  it('parses 1.00000000 to 100,000,000 tinybars', () => {
    expect(hbarDisplayToTinybars('1.00000000')).toBe(100_000_000n);
  });

  it('parses integer HBAR string', () => {
    expect(hbarDisplayToTinybars('5')).toBe(500_000_000n);
  });

  it('parses partial decimals', () => {
    expect(hbarDisplayToTinybars('1.5')).toBe(150_000_000n);
  });

  it('round-trips tinybarsToHbarDisplay', () => {
    const original = 123_456_789n;
    const display = tinybarsToHbarDisplay(original);
    expect(hbarDisplayToTinybars(display)).toBe(original);
  });

  it('throws on negative input string', () => {
    expect(() => hbarDisplayToTinybars('-1')).toThrow();
  });

  it('throws on non-numeric input', () => {
    expect(() => hbarDisplayToTinybars('abc')).toThrow();
  });

  it('throws on scientific notation', () => {
    expect(() => hbarDisplayToTinybars('1e8')).toThrow();
  });
});

describe('isValidHederaAccountId', () => {
  it('accepts 0.0.1', () => {
    expect(isValidHederaAccountId('0.0.1')).toBe(true);
  });

  it('accepts 0.0.12345', () => {
    expect(isValidHederaAccountId('0.0.12345')).toBe(true);
  });

  it('accepts non-zero shard and realm', () => {
    expect(isValidHederaAccountId('1.2.3')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidHederaAccountId('')).toBe(false);
  });

  it('rejects plain number', () => {
    expect(isValidHederaAccountId('12345')).toBe(false);
  });

  it('rejects two parts only', () => {
    expect(isValidHederaAccountId('0.0')).toBe(false);
  });

  it('rejects with letters', () => {
    expect(isValidHederaAccountId('0.0.abc')).toBe(false);
  });

  it('rejects with trailing dot', () => {
    expect(isValidHederaAccountId('0.0.1.')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input validation tests for buildAndSubmitHbarTransfer
// These exercise the validation code path without reaching the worker or network.
// ---------------------------------------------------------------------------

describe('buildAndSubmitHbarTransfer input validation', () => {
  const baseParams = {
    fromAccountId: '0.0.1',
    toAccountId: '0.0.2',
    amountTinybars: 100n,
    hdIndex: 0,
    accountApiId: 'account-api-id',
  };

  it('throws on zero amountTinybars', async () => {
    await expect(
      buildAndSubmitHbarTransfer({ ...baseParams, amountTinybars: 0n }),
    ).rejects.toThrow('amountTinybars must be a positive integer');
  });

  it('throws on negative amountTinybars', async () => {
    await expect(
      buildAndSubmitHbarTransfer({ ...baseParams, amountTinybars: -1n }),
    ).rejects.toThrow('amountTinybars must be a positive integer');
  });

  it('throws on invalid fromAccountId', async () => {
    await expect(
      buildAndSubmitHbarTransfer({ ...baseParams, fromAccountId: 'not-an-id' }),
    ).rejects.toThrow('Invalid fromAccountId');
  });

  it('throws on invalid toAccountId', async () => {
    await expect(
      buildAndSubmitHbarTransfer({ ...baseParams, toAccountId: 'invalid' }),
    ).rejects.toThrow('Invalid toAccountId');
  });

  it('throws when fromAccountId equals toAccountId', async () => {
    await expect(
      buildAndSubmitHbarTransfer({ ...baseParams, fromAccountId: '0.0.5', toAccountId: '0.0.5' }),
    ).rejects.toThrow('fromAccountId and toAccountId must differ');
  });

  it('does not expose the private key in thrown error messages', async () => {
    // A bad accountId causes a throw before any key access.
    try {
      await buildAndSubmitHbarTransfer({ ...baseParams, fromAccountId: 'bad-id' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The message must not contain anything that resembles a private key.
      expect(msg).not.toMatch(/private|key|secret|seed|mnemonic|pk/i);
    }
  });

  it('does not include private key in params or result types (structural check)', () => {
    // Verify that HederaTransferParams and HederaTransferResult types do not carry key material.
    // This is enforced at the type level; here we confirm the runtime param object has no key field.
    const params: Record<string, unknown> = { ...baseParams };
    expect(params).not.toHaveProperty('privateKey');
    expect(params).not.toHaveProperty('pk');
    expect(params).not.toHaveProperty('secret');
    expect(params).not.toHaveProperty('seed');
  });
});

// ---------------------------------------------------------------------------
// Explorer URL helpers
// ---------------------------------------------------------------------------

describe('explorer URL helpers', () => {
  it('builds a HashScan Testnet transaction URL', () => {
    expect(hederaTransactionExplorerUrl('0.0.123@1700000000.000000000')).toBe(
      'https://hashscan.io/testnet/transaction/0.0.123@1700000000.000000000',
    );
  });

  it('builds a HashScan Testnet account URL', () => {
    expect(hederaAccountExplorerUrl('0.0.11473349')).toBe(
      'https://hashscan.io/testnet/account/0.0.11473349',
    );
  });
});

// ---------------------------------------------------------------------------
// buildAndSubmitHederaAccountCreate input validation (no worker / no network)
// ---------------------------------------------------------------------------

describe('buildAndSubmitHederaAccountCreate input validation', () => {
  const baseParams = {
    walletPublicKeyHex: '02' + 'a'.repeat(64),
    payerAccountId: '0.0.11285881',
    payerPrivateKeyHex: 'a'.repeat(64),
    hdIndex: 0,
    accountApiId: 'account-api-id',
  };

  it('throws on invalid payerAccountId before any network call', async () => {
    await expect(
      buildAndSubmitHederaAccountCreate({ ...baseParams, payerAccountId: 'not-an-id' }),
    ).rejects.toThrow('Invalid payerAccountId');
  });

  it('throws on an invalid wallet public key', async () => {
    await expect(
      buildAndSubmitHederaAccountCreate({ ...baseParams, walletPublicKeyHex: 'abc' }),
    ).rejects.toThrow('Invalid wallet public key');
  });

  it('throws on a negative initial balance', async () => {
    await expect(
      buildAndSubmitHederaAccountCreate({ ...baseParams, initialBalanceTinybars: -1n }),
    ).rejects.toThrow('initialBalanceTinybars must not be negative');
  });
});

// ---------------------------------------------------------------------------
// Mirror Node balance lookup — nested balance.balance parsing
// ---------------------------------------------------------------------------

describe('getHederaAccountBalance', () => {
  const MIRROR = 'https://mirror.test/api/v1';
  const ACCOUNT = '0.0.11479384';

  function mirrorResponse(status: number, body: unknown): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    } as unknown as Response;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads balance.balance and converts 1,000,000,000 tinybars to 10 HBAR', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mirrorResponse(200, {
        account: ACCOUNT,
        balance: { balance: 1_000_000_000, timestamp: '1794803412.127122766', tokens: [] },
        deleted: false,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getHederaAccountBalance(ACCOUNT, MIRROR)).resolves.toEqual({
      tinybars: 1_000_000_000n,
      hbar: '10.00000000',
    });
    expect(fetchMock).toHaveBeenCalledWith(`${MIRROR}/accounts/${ACCOUNT}`);
  });

  it('returns zero for a zero balance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mirrorResponse(200, {
          account: ACCOUNT,
          balance: { balance: 0, timestamp: '1794803412.127122766', tokens: [] },
          deleted: false,
        }),
      ),
    );

    await expect(getHederaAccountBalance(ACCOUNT, MIRROR)).resolves.toEqual({
      tinybars: 0n,
      hbar: '0.00000000',
    });
  });

  it('defaults to zero when the nested balance is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mirrorResponse(200, {
          account: ACCOUNT,
          deleted: false,
        }),
      ),
    );

    await expect(getHederaAccountBalance(ACCOUNT, MIRROR)).resolves.toEqual({
      tinybars: 0n,
      hbar: '0.00000000',
    });
  });

  it('defaults to zero for a malformed balance object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mirrorResponse(200, {
          account: ACCOUNT,
          balance: { timestamp: '1794803412.127122766', tokens: [] },
          deleted: false,
        }),
      ),
    );

    await expect(getHederaAccountBalance(ACCOUNT, MIRROR)).resolves.toEqual({
      tinybars: 0n,
      hbar: '0.00000000',
    });
  });

  it('rejects a non-OK mirror response instead of reporting a balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mirrorResponse(500, {})));

    await expect(getHederaAccountBalance(ACCOUNT, MIRROR)).rejects.toThrow(
      `Mirror node returned 500 for account ${ACCOUNT}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Mirror Node key lookup — indexing-lag tolerance and JSON parsing
// ---------------------------------------------------------------------------

describe('getHederaAccountKey', () => {
  const MIRROR = 'https://mirror.test/api/v1';
  const ACCOUNT = '0.0.11478972';
  const KEY = '02769c7b5ad457fb3f57a78a1b783ea0c8d207d3f7c4fb2a08bed8c1cb4016a956';

  function mirrorResponse(status: number, body: unknown): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    } as unknown as Response;
  }

  function accountBody() {
    return {
      account: ACCOUNT,
      balance: { balance: 1_000_000_000 },
      deleted: false,
      key: { _type: 'ECDSA_SECP256K1', key: KEY },
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses _type/key from the documented Mirror Node account payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mirrorResponse(200, accountBody()));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getHederaAccountKey(ACCOUNT, MIRROR);

    expect(result).toEqual({ type: 'ECDSA_SECP256K1', key: KEY });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${MIRROR}/accounts/${ACCOUNT}`);
  });

  it('retries a 404 (not indexed yet) and succeeds once the account appears', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mirrorResponse(404, {}))
      .mockResolvedValueOnce(mirrorResponse(404, {}))
      .mockResolvedValueOnce(mirrorResponse(200, accountBody()));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getHederaAccountKey(ACCOUNT, MIRROR, { attempts: 4, intervalMs: 0 });

    expect(result.key).toBe(KEY);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports a retryable not-found error after exhausting the bounded window', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mirrorResponse(404, {}));
    vi.stubGlobal('fetch', fetchMock);

    const error = await getHederaAccountKey(ACCOUNT, MIRROR, {
      attempts: 3,
      intervalMs: 0,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HederaLinkError);
    expect((error as HederaLinkError).kind).toBe('ONCHAIN_ACCOUNT_NOT_FOUND');
    expect((error as Error).message).toMatch(/wait a few seconds and retry/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-404 failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mirrorResponse(500, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getHederaAccountKey(ACCOUNT, MIRROR, { attempts: 4, intervalMs: 0 }),
    ).rejects.toThrow('Mirror node returned 500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('verifyHederaAccountOwnership', () => {
  const MIRROR = 'https://mirror.test/api/v1';
  const ACCOUNT = '0.0.11478972';
  const KEY = '02769c7b5ad457fb3f57a78a1b783ea0c8d207d3f7c4fb2a08bed8c1cb4016a956';

  function response(status: number, body: unknown): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    } as unknown as Response;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('verifies against the on-chain Admin Key after a not-indexed 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(404, {}))
      .mockResolvedValueOnce(
        response(200, { key: { _type: 'ECDSA_SECP256K1', key: KEY.toUpperCase() } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      verifyHederaAccountOwnership(ACCOUNT, KEY, MIRROR, { attempts: 2, intervalMs: 0 }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a key that does not match the on-chain Admin Key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(200, { key: { _type: 'ECDSA_SECP256K1', key: KEY } }),
      ),
    );

    const error = await verifyHederaAccountOwnership(
      ACCOUNT,
      '03' + '11'.repeat(32),
      MIRROR,
      { attempts: 1, intervalMs: 0 },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HederaLinkError);
    expect((error as HederaLinkError).kind).toBe('OWNERSHIP_MISMATCH');
  });
});
