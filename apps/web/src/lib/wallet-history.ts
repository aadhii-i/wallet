/**
 * Wallet History response handling: normalisation (a missing list is an
 * empty list, never a crash) and errors that say what actually went wrong —
 * an API build without the endpoint is not "no history".
 */
import { ApiError, type WalletHistory, type WalletHistoryItem } from '@qd/rpc';

/** Accepts the API response and guarantees arrays/objects where the contract promises them. */
export function normalizeWalletHistory(raw: Partial<WalletHistory> | null | undefined, chainId: number): WalletHistory {
  const items = Array.isArray(raw?.items) ? (raw!.items as WalletHistoryItem[]) : [];
  return {
    chainId: raw?.chainId ?? chainId,
    network: raw?.network ?? `chain ${chainId}`,
    addresses: Array.isArray(raw?.addresses) ? raw!.addresses : [],
    items: items.map((i) => ({ ...i, status: i.status ?? (i.success ? 'confirmed' : 'failed') })),
    coverage: raw?.coverage ?? {},
    index: raw?.index ?? { state: 'ok' },
  };
}

export type HistoryProblem = { kind: 'endpoint_missing' | 'not_found' | 'unsupported_network' | 'invalid' | 'unavailable'; message: string };

/** Explains a failed Wallet History request. */
export function historyProblem(err: unknown, networkName: string): HistoryProblem {
  if (err instanceof ApiError) {
    // chi's plain-text 404 for an unregistered route has no problem body: the API predates Wallet History.
    if (err.status === 404 && !err.problem) {
      return {
        kind: 'endpoint_missing',
        message: 'The API server does not provide Wallet History (HTTP 404: route not found). It is running an older build — restart it (make api) and reload.',
      };
    }
    if (err.status === 404) return { kind: 'not_found', message: 'This shared wallet doesn’t exist or you are not a participant (HTTP 404).' };
    if (err.code === 'UNSUPPORTED_NETWORK') return { kind: 'unsupported_network', message: `Wallet History isn’t available for ${networkName}: the server has no RPC for this network.` };
    if (err.status === 400) return { kind: 'invalid', message: `Invalid request: ${err.message}` };
    return { kind: 'unavailable', message: `Wallet History unavailable (HTTP ${err.status}): ${err.message}` };
  }
  return { kind: 'unavailable', message: `Wallet History unavailable: ${err instanceof Error ? err.message : String(err)}` };
}

/** Warning when the chain could not be read for this request (stored history is still shown). */
export function indexWarning(h: WalletHistory): string | null {
  switch (h.index.state) {
    case 'rpc_error':
      return `Couldn’t read ${h.network} just now${h.index.error ? ` (${h.index.error})` : ''}. Showing stored history; the newest transactions may be missing.`;
    case 'indexing': {
      const through = Math.min(...Object.values(h.coverage).map((c) => c.scannedThroughBlock));
      return `Still indexing ${h.network}${Number.isFinite(through) ? ` (searched through block ${through.toLocaleString('en-US')})` : ''}; newer transactions will appear shortly.`;
    }
    case 'rpc_unavailable':
      return `The server has no RPC for ${h.network}; showing stored history only.`;
    case 'disabled':
      return 'The server’s chain index is disabled; showing stored history only.';
    default:
      return null;
  }
}
