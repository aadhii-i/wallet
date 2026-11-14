import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateHederaAccountId, createHederaDataSource } from './hedera-api';

// ---------------------------------------------------------------------------
// validateHederaAccountId
// ---------------------------------------------------------------------------

describe('validateHederaAccountId', () => {
  it.each(['0.0.1', '0.0.12345', '1.2.3'])('accepts valid id %s', (id) => {
    expect(validateHederaAccountId(id)).toBe(true);
  });

  it.each(['', 'abc', '0.0', '0.0.', '0.0.1.2'])('rejects invalid id %s', (id) => {
    expect(validateHederaAccountId(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createHederaDataSource
// ---------------------------------------------------------------------------

// Mock the api module so we never make real HTTP requests.
const mockHederaBalance = vi.fn();

vi.mock('./api', () => ({
  getApi: async () => ({
    hederaBalance: mockHederaBalance,
  }),
}));

describe('createHederaDataSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has chain literal "testnet"', () => {
    const ds = createHederaDataSource('0.0.12345');
    expect(ds.chain).toBe('testnet');
  });

  it('getBalance returns tinybars as bigint', async () => {
    mockHederaBalance.mockResolvedValue({ accountId: '0.0.12345', tinybars: 100_000_000, hbar: '1.00000000 HBAR' });
    const ds = createHederaDataSource('0.0.12345');
    const bal = await ds.getBalance();
    expect(bal).toBe(BigInt(100_000_000));
  });

  it('getBalance: 1 tinybar → BigInt(1)', async () => {
    mockHederaBalance.mockResolvedValue({ accountId: '0.0.1', tinybars: 1, hbar: '0.00000001 HBAR' });
    const ds = createHederaDataSource('0.0.1');
    expect(await ds.getBalance()).toBe(BigInt(1));
  });

  it('getBalance: 0 tinybars → BigInt(0)', async () => {
    mockHederaBalance.mockResolvedValue({ accountId: '0.0.1', tinybars: 0, hbar: '0.00000000 HBAR' });
    const ds = createHederaDataSource('0.0.1');
    expect(await ds.getBalance()).toBe(BigInt(0));
  });

  it('getBalance: 100_000_000 tinybars converts to BigInt matching 1 HBAR display', async () => {
    // The backend would return "1.00000000 HBAR" for 100_000_000 tinybars.
    mockHederaBalance.mockResolvedValue({ accountId: '0.0.1', tinybars: 100_000_000, hbar: '1.00000000 HBAR' });
    const ds = createHederaDataSource('0.0.1');
    const bal = await ds.getBalance();
    // bigint(tinybars) / 100_000_000n === 1n
    expect(bal / BigInt(100_000_000)).toBe(BigInt(1));
  });

  it('propagates API errors', async () => {
    mockHederaBalance.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    const ds = createHederaDataSource('0.0.99999');
    await expect(ds.getBalance()).rejects.toMatchObject({ status: 404 });
  });
});
