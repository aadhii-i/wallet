import { describe, expect, it } from 'vitest';
import { ApiError, type WalletHistory } from '@qd/rpc';
import { historyProblem, indexWarning, normalizeWalletHistory } from './wallet-history';

describe('Wallet History response handling', () => {
  it('normalises missing lists to empty lists (the API once sent addresses: null and the page crashed)', () => {
    const h = normalizeWalletHistory({ chainId: 11155111, addresses: null as unknown as string[], items: undefined, coverage: undefined } as Partial<WalletHistory>, 11155111);
    expect(h.addresses).toEqual([]);
    expect(h.items).toEqual([]);
    expect(h.index.state).toBe('ok');
    expect(normalizeWalletHistory(null, 31337)).toMatchObject({ chainId: 31337, addresses: [], items: [] });
  });

  it('derives status from success for older responses', () => {
    const h = normalizeWalletHistory({ items: [{ success: false } as never, { success: true } as never] }, 1);
    expect(h.items.map((i) => i.status)).toEqual(['failed', 'confirmed']);
  });

  it('does not present a missing endpoint as an empty history', () => {
    // chi's plain-text "404 page not found": no problem body.
    const missing = historyProblem(new ApiError(404, 'HTTP_404'), 'Sepolia Testnet');
    expect(missing.kind).toBe('endpoint_missing');
    expect(missing.message).toMatch(/older build/);
    const notMember = historyProblem(new ApiError(404, 'NOT_FOUND', { title: 'Not Found', status: 404, code: 'NOT_FOUND' }), 'Sepolia Testnet');
    expect(notMember.kind).toBe('not_found');
    expect(historyProblem(new ApiError(400, 'UNSUPPORTED_NETWORK', { title: 'Bad Request', status: 400, code: 'UNSUPPORTED_NETWORK' }), 'Base').message).toMatch(/Base/);
    expect(historyProblem(new ApiError(503, 'HTTP_503'), 'Sepolia').kind).toBe('unavailable');
    expect(historyProblem(new TypeError('Failed to fetch'), 'Sepolia').message).toMatch(/Failed to fetch/);
  });

  it('warns when the chain could not be read', () => {
    const base = normalizeWalletHistory({ network: 'Ethereum Sepolia' }, 11155111);
    expect(indexWarning(base)).toBeNull();
    expect(indexWarning({ ...base, index: { state: 'rpc_error', error: 'eth_getLogs: timeout' } })).toMatch(/Couldn’t read Ethereum Sepolia.*timeout/);
    expect(indexWarning({ ...base, index: { state: 'rpc_unavailable' } })).toMatch(/no RPC/);
    const indexing = { ...base, index: { state: 'indexing' as const }, coverage: { a: { sinceBlock: 1, scannedThroughBlock: 12140299 }, b: { sinceBlock: 1, scannedThroughBlock: 12139000 } } };
    expect(indexWarning(indexing)).toBe('Still indexing Ethereum Sepolia (searched through block 12,139,000); newer transactions will appear shortly.');
  });
});
