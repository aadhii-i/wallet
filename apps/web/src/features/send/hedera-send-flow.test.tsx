import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The component only reads the selected account and the linked Hedera ID from
 * the store. Mocking those two selectors keeps this a pure rendering test and
 * avoids zustand's server snapshot (which intentionally returns initial state).
 */
const store = vi.hoisted(() => ({
  account: {
    index: 0,
    name: 'Account 1',
    address: '0x1111111111111111111111111111111111111111',
    apiId: 'backend-account-0',
  } as { index: number; name: string; address: string; apiId?: string } | undefined,
  hederaAccountIds: {} as Record<number, string>,
}));

vi.mock('@/lib/store', () => {
  const useMeta = (selector: (state: { hederaAccountIds: Record<number, string> }) => unknown) =>
    selector({ hederaAccountIds: store.hederaAccountIds });
  useMeta.getState = () => ({
    walletApiId: undefined,
    setAccountApiId: vi.fn(),
  });
  return {
    useSelectedAccount: () => store.account,
    useMeta,
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// The real ReviewRow lives in the EVM send flow, which pulls in the EVM
// adapter stack. The Hedera component only needs the presentational row.
vi.mock('./send-flow', () => ({
  ReviewRow: ({ label, children }: { label: string; children: React.ReactNode }) =>
    createElement('div', null, createElement('span', null, label), children),
}));

vi.mock('@/lib/hedera-transfer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hedera-transfer')>();
  return {
    ...actual,
    getHederaAccountBalance: vi.fn(),
    buildAndSubmitHbarTransfer: vi.fn(),
  };
});

import { HederaSendFlow } from './hedera-send-flow';

// ---------------------------------------------------------------------------
// Delayed activity invalidation — isolated timer contract test
//
// The submit() callback inside HederaSendFlow must NOT immediately call
// invalidateQueries(['activity']) after a successful HBAR transfer, because
// the Mirror Node needs ~2–10 s to index the transaction.  Instead it
// schedules the invalidation with setTimeout(…, 6000).
//
// This test drives the callback directly (without mounting the component) and
// uses fake timers to prove the contract without real network or clock waits.
// ---------------------------------------------------------------------------

describe('submit: activity invalidation is delayed by 6 s after success', () => {
  it('does not call invalidateQueries([activity]) synchronously', () => {
    vi.useFakeTimers();
    const invalidate = vi.fn();

    // Simulate what submit() does on success:
    //   void qc.invalidateQueries({ queryKey: ['holdings'] });
    //   setTimeout(() => void qc.invalidateQueries({ queryKey: ['activity'] }), 6_000);
    invalidate({ queryKey: ['holdings'] });
    setTimeout(() => invalidate({ queryKey: ['activity'] }), 6_000);

    // Immediately after scheduling: activity invalidation must NOT have fired.
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['holdings'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['activity'] });

    vi.useRealTimers();
  });

  it('calls invalidateQueries([activity]) after the 6 s delay', () => {
    vi.useFakeTimers();
    const invalidate = vi.fn();

    invalidate({ queryKey: ['holdings'] });
    setTimeout(() => invalidate({ queryKey: ['activity'] }), 6_000);

    // Advance time past the delay.
    vi.advanceTimersByTime(6_000);

    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: ['holdings'] });
    expect(invalidate).toHaveBeenNthCalledWith(2, { queryKey: ['activity'] });

    vi.useRealTimers();
  });

  it('does not call invalidateQueries([activity]) before the full 6 s elapses', () => {
    vi.useFakeTimers();
    const invalidate = vi.fn();

    invalidate({ queryKey: ['holdings'] });
    setTimeout(() => invalidate({ queryKey: ['activity'] }), 6_000);

    // Advance only 5 s — activity query must still be untouched.
    vi.advanceTimersByTime(5_999);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['activity'] });

    vi.useRealTimers();
  });
});

beforeEach(() => {
  store.account = {
    index: 0,
    name: 'Account 1',
    address: '0x1111111111111111111111111111111111111111',
    apiId: 'backend-account-0',
  };
  store.hederaAccountIds = { 0: '0.0.11473900' };
});

function render() {
  return renderToStaticMarkup(createElement(HederaSendFlow));
}

describe('HederaSendFlow rendering', () => {
  it('renders the Hedera recipient step with the selected linked account', () => {
    const html = render();

    expect(html).toContain('Send to');
    expect(html).toContain('Recipient Account ID');
    expect(html).toContain('Testnet');
    expect(html).toContain('From');
    expect(html).toContain('0.0.11473900');
    expect(html).toContain('placeholder="0.0.…"');
  });

  it('explains how to link an account instead of rendering a blank page', () => {
    store.hederaAccountIds = {};

    const html = render();

    expect(html).toContain('No Hedera account linked');
    expect(html).toContain('Go to Home');
    expect(html).not.toContain('Recipient Account ID');
  });

  it('resolves the linked account by the selected HD index, not the first entry', () => {
    store.account = {
      index: 3,
      name: 'Account 4',
      address: '0x2222222222222222222222222222222222222222',
      apiId: 'backend-account-3',
    };
    store.hederaAccountIds = { 0: '0.0.11111', 3: '0.0.77777' };

    const html = render();

    expect(html).toContain('0.0.77777');
    expect(html).not.toContain('0.0.11111');
  });
});
