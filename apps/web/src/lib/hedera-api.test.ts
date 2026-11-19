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
const mockHederaHistory = vi.fn();

vi.mock('./api', () => ({
  getApi: async () => ({
    hederaBalance: mockHederaBalance,
    hederaHistory: mockHederaHistory,
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

// ---------------------------------------------------------------------------
// getHistory
// ---------------------------------------------------------------------------

const sampleItem = {
  transactionId: '0.0.12345-1700000000-123456789',
  timestamp: '2023-11-14T22:13:20Z',
  type: 'CRYPTOTRANSFER',
  direction: 'in' as const,
  from: '0.0.98',
  to: '0.0.12345',
  amountTinybars: 50_000_000,
  hbar: '0.50000000 HBAR',
  feeTinybars: 1_000_000,
  status: 'confirmed' as const,
  networkId: 'hedera-testnet',
};

describe('getHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns items and nextCursor from the API (first page, no cursor)', async () => {
    mockHederaHistory.mockResolvedValue({ items: [sampleItem], nextCursor: 'page-2' });
    const ds = createHederaDataSource('0.0.12345');
    const page = await ds.getHistory();
    // First page passes no cursor through to the API client.
    expect(mockHederaHistory).toHaveBeenCalledWith('0.0.12345', undefined);
    expect(page.items).toEqual([sampleItem]);
    expect(page.nextCursor).toBe('page-2');
  });

  it('forwards the cursor to the API for pagination', async () => {
    mockHederaHistory.mockResolvedValue({ items: [], nextCursor: 'page-3' });
    const ds = createHederaDataSource('0.0.12345');
    const page = await ds.getHistory('page-2');
    expect(mockHederaHistory).toHaveBeenCalledWith('0.0.12345', 'page-2');
    expect(page.nextCursor).toBe('page-3');
  });

  it('returns an empty page with no nextCursor', async () => {
    mockHederaHistory.mockResolvedValue({ items: [] });
    const ds = createHederaDataSource('0.0.12345');
    const page = await ds.getHistory();
    expect(mockHederaHistory).toHaveBeenCalledWith('0.0.12345', undefined);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('propagates API errors', async () => {
    mockHederaHistory.mockRejectedValue(Object.assign(new Error('Server Error'), { status: 500 }));
    const ds = createHederaDataSource('0.0.12345');
    await expect(ds.getHistory()).rejects.toMatchObject({ status: 500 });
  });
});
