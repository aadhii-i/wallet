import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const net = vi.hoisted(() => ({
  current: { family: 'hedera', id: 'hedera-testnet', name: 'Hedera Testnet' } as {
    family: string;
    id: string;
    name: string;
  },
}));

vi.mock('@/lib/hooks', () => ({
  useNetwork: () => net.current,
  useAdapter: vi.fn(),
  useEvmAdapter: vi.fn(),
  usePrices: vi.fn(),
  useValuedHoldings: vi.fn(),
}));

vi.mock('@/lib/store', () => ({
  useMeta: vi.fn(),
  useSelectedAccount: vi.fn(),
  useSession: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('./hedera-send-flow', () => ({
  HederaSendFlow: () =>
    createElement('div', { 'data-testid': 'hedera-send-flow' }, 'Hedera send'),
}));

vi.mock('./bitcoin-send-flow', () => ({
  BitcoinSendFlow: () => createElement('div', { 'data-testid': 'bitcoin-send-flow' }, 'Bitcoin send'),
}));

import { SendFlow } from './send-flow';

beforeEach(() => {
  net.current = { family: 'hedera', id: 'hedera-testnet', name: 'Hedera Testnet' };
});

describe('SendFlow network dispatch', () => {
  it('renders the Hedera flow for Hedera networks instead of returning null', () => {
    const html = renderToStaticMarkup(createElement(SendFlow));

    expect(html).toContain('data-testid="hedera-send-flow"');
    expect(html).toContain('Hedera send');
  });

  it('still dispatches Bitcoin networks to the Bitcoin flow', () => {
    net.current = { family: 'bitcoin', id: 'bitcoin-testnet4', name: 'Bitcoin Testnet4' };

    const html = renderToStaticMarkup(createElement(SendFlow));

    expect(html).toContain('data-testid="bitcoin-send-flow"');
    expect(html).toContain('Bitcoin send');
  });
});
