'use client';
import { useQuery } from '@tanstack/react-query';
import type { RelayerChainStatus } from '@qd/rpc';
import { getApi } from '@/lib/api';

export const GAS_STATUS_KEY = ['qd-relayer-status'] as const;

/** Gas service accounts per chain (GET /v1/relayers). Public data, never key material. */
export function useGasServiceStatus(opts: { enabled?: boolean; refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: GAS_STATUS_KEY,
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval ?? 15_000,
    retry: 1,
    queryFn: async () => (await (await getApi()).relayerStatus()).chains,
  });
}

/** One chain's gas service account; null when the API does not know the chain. */
export function useGasServiceChain(chainId: number, enabled = true) {
  const q = useGasServiceStatus({ enabled });
  const chain: RelayerChainStatus | null | undefined = q.data ? (q.data.find((c) => c.chainId === chainId) ?? null) : undefined;
  return { ...q, chain };
}

export { preferredChain } from '@/lib/gas-service';
