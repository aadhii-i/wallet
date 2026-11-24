'use client';
/**
 * Execution summary for a proposal that reached its threshold: what the
 * shared account pays (the transfer value) and what the Gas Service Account
 * pays (gas), from the relayer's own preflight on the chain. Read-only: it
 * never sends anything and never changes the approved transaction.
 */
import { useQuery } from '@tanstack/react-query';
import type { Proposal } from '@qd/rpc';
import { getApi } from '@/lib/api';
import { balanceView, eth } from '@/lib/gas-service';
import { nativeSymbol } from '@/lib/shared-network';
import { networkLabel } from '../shared/transaction-receipt';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[11rem_1fr] gap-2 py-0.5">
      <dt className="text-subtle">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ExecutionSummary({ proposal: p }: { proposal: Proposal }) {
  const q = useQuery({
    queryKey: ['qd-gas-estimate', p.id],
    refetchInterval: 15_000,
    retry: 1,
    queryFn: async () => (await getApi()).gasEstimate(p.id),
  });
  const view = balanceView(p.id, q);
  const symbol = nativeSymbol(p.chainId);
  return (
    <section aria-label="Execution summary" className="mt-2 rounded-lg border border-line bg-surface p-2.5 text-[13px]">
      <h4 className="mb-1 font-semibold">Execution summary · {networkLabel(p.chainId)}</h4>
      {view.kind === 'loading' && <p className="text-subtle">Estimating gas and reading balances from the chain…</p>}
      {view.kind === 'paused' && <p className="text-subtle">Estimate not loaded yet — retrying when this window is active and online.</p>}
      {view.kind === 'error' && <p className="text-warning">Estimate unavailable: {view.message}</p>}
      {view.kind === 'ready' && (() => {
        const e = view.data;
        return (
          <>
            <dl>
              <Row label="Transfer amount">{eth(e.transferWei, symbol)}</Row>
              <Row label="Shared account balance">
                <span aria-label="Shared account balance">{eth(e.accountBalanceWei, symbol)}</span>
                <span className="block text-xs text-subtle">The shared smart account pays the transfer amount.</span>
              </Row>
              <Row label="Gas Service Account balance">
                <span aria-label="Gas Service Account balance">{e.relayerConfigured ? eth(e.relayerBalanceWei, symbol) : 'not configured for this network'}</span>
                <span className="block text-xs text-subtle">
                  The gas service account pays gas.{' '}
                  <a href="/settings#gas-service" className="text-primary underline">Open Gas Service Account</a>
                </span>
              </Row>
              <Row label="Estimated gas requirement">
                {e.requiredRelayerWei ? (
                  <>
                    <span aria-label="Estimated gas requirement">{eth(e.requiredRelayerWei, symbol)}</span>
                    <span className="block text-xs text-subtle">
                      Up to {e.gasUnits.toLocaleString()} gas at the fee cap of {e.feeCapWei} wei/gas
                      {e.setupSteps.length > 0 ? `, including ${e.setupSteps.length} one-time setup transaction(s)` : ''}. At today’s gas price of {e.gasPriceWei} wei/gas
                      this is about {eth(e.estimatedFeeWei, symbol)}; the actual fee appears on the receipt.
                    </span>
                  </>
                ) : (
                  'unavailable'
                )}
              </Row>
              {e.additionalFeeReserveWei && BigInt(e.additionalFeeReserveWei) > 0n && (
                <Row label="Additional network fee reserve">
                  {eth(e.additionalFeeReserveWei, symbol)} for L1 data and operator fees, included above.
                </Row>
              )}
            </dl>
            {e.accountShortfallWei && (
              <p role="alert" className="mt-1 text-warning">
                The shared account is short by {eth(e.accountShortfallWei, symbol)}. Fund the shared account (not the gas service account).
              </p>
            )}
            {e.relayerShortfallWei && (
              <p role="alert" className="mt-1 text-warning">
                Gas Service Account cannot cover the estimated execution cost: short by {eth(e.relayerShortfallWei, symbol)}. Fund the account before retrying.
              </p>
            )}
            <p className={`mt-1 font-medium ${e.canProceed ? 'text-success' : 'text-warning'}`} aria-label="Execution readiness">
              Status: {e.canProceed ? 'Ready to execute.' : `Blocked — ${e.blocker}`}
            </p>
            {!e.canProceed && <p className="text-xs text-subtle">Nothing is sent while blocked; the relayer re-checks on its own and continues once this is resolved.</p>}
          </>
        );
      })()}
    </section>
  );
}
