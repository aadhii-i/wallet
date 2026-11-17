'use client';
/**
 * Gas Service Account (Settings → Network & Gas): the application's per-chain
 * relayer address that pays blockchain gas for shared-wallet setup and
 * execution. Its private key stays in the API's secret configuration; this
 * page only shows public data (address, chain balance, gas prices, receipts)
 * and tells the user how to fund it with an ordinary external transfer.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { ExternalLink, Fuel, RefreshCw } from 'lucide-react';
import { EVM_NETWORKS } from '@qd/blockchain';
import type { GasHistory, RelayerChainStatus } from '@qd/rpc';
import { getApi } from '@/lib/api';
import {
  HEALTH_LABEL,
  HEALTH_TONE,
  TRANSFER_KIND_LABEL,
  balanceView,
  eth,
  gasHealth,
  gwei,
  rechargeCount,
  transferEffectWei,
} from '@/lib/gas-service';
import { formatWeiAsEth } from '@/lib/eth-amount';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/identity';
import { Sheet } from '@/components/ui/sheet';
import { networkLabel } from '../shared/transaction-receipt';
import { GAS_STATUS_KEY, preferredChain, useGasServiceStatus } from './hooks';

const network = (chainId: number) => EVM_NETWORKS.find((n) => n.chainId === chainId);
const symbolOf = (chainId: number) => network(chainId)?.nativeCurrency.symbol ?? 'ETH';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10.5rem_1fr] gap-2 py-1 text-sm">
      <dt className="text-subtle">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export function GasServiceSection() {
  const qc = useQueryClient();
  const status = useGasServiceStatus();
  const chains = (status.data ?? []).filter((c) => c.relayerConfigured);
  const [picked, setPicked] = useState<number | null>(null);
  const chainId = picked ?? (chains.length ? preferredChain(chains.map((c) => c.chainId), chains) : null);
  const cs = chains.find((c) => c.chainId === chainId) ?? null;
  const [refreshing, setRefreshing] = useState(false);
  const [fund, setFund] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  // Refresh when the section opens (mount) and on demand, bypassing the API's short cache.
  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await (await getApi()).relayerStatus({ refresh: true });
      qc.setQueryData(GAS_STATUS_KEY, fresh.chains);
      setRefreshedAt(Date.now());
      await qc.invalidateQueries({ queryKey: ['qd-gas-history'] });
    } finally {
      setRefreshing(false);
    }
  };
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (window.location.hash === '#gas-service') document.getElementById('gas-service')?.scrollIntoView({ block: 'start' });
    void refresh().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status.isPending && !status.data) {
    return <p className="px-4 py-3.5 text-sm text-subtle">{status.fetchStatus === 'paused' ? 'Waiting for this window to be active and online…' : 'Loading gas service accounts…'}</p>;
  }
  if (status.isError && !status.data) {
    return <p className="px-4 py-3.5 text-sm text-warning">Gas service status unavailable: {(status.error as Error)?.message}</p>;
  }
  if (!chains.length || !cs || chainId === null) {
    return (
      <p className="px-4 py-3.5 text-sm text-subtle">
        No gas service account is configured on this server. An operator sets one per network in the API’s secret configuration (RELAYER_PRIVATE_KEY_&lt;chainId&gt;).
      </p>
    );
  }
  const health = gasHealth(cs);
  const symbol = symbolOf(cs.chainId);
  const explorer = network(cs.chainId)?.explorer;
  const checked = refreshedAt ?? (status.dataUpdatedAt || null);
  return (
    <div className="px-4 py-3.5" aria-label="Gas Service Account">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Fuel size={18} className="text-muted" />
        <h3 className="font-semibold">Gas Service Account</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${HEALTH_TONE[health]}`} aria-label="Gas service status">
          {HEALTH_LABEL[health]}
        </span>
        {chains.length > 1 && (
          <select aria-label="Gas service network" value={cs.chainId} onChange={(e) => setPicked(Number(e.target.value))} className="ml-auto rounded-lg border border-line bg-surface px-2 py-1 text-sm">
            {chains.map((c) => (
              <option key={c.chainId} value={c.chainId}>
                {networkLabel(c.chainId)}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="mb-2 text-[13px] text-muted">
        QD Wallet’s gas-paying relayer for {networkLabel(cs.chainId)}. It is shared by every shared wallet on this network and pays blockchain execution fees;
        the shared smart account pays the transfer amounts. This is not your personal wallet.
      </p>
      <dl>
        <Field label="Network">
          {networkLabel(cs.chainId)} · chain ID {cs.chainId}
          {cs.rpcChainId !== undefined && cs.rpcChainId !== cs.chainId && <span className="block text-danger">RPC reports chain {cs.rpcChainId}</span>}
        </Field>
        <Field label="Address">
          <span className="flex items-center gap-1">
            <span className="break-all font-mono text-xs" aria-label="Gas service address">{cs.relayerAddress}</span>
            <CopyButton value={cs.relayerAddress!} label="Copy gas service address" />
          </span>
        </Field>
        <Field label="Balance">
          <span aria-label="Gas service balance" className="font-semibold">
            {cs.relayerBalanceWei !== undefined ? `${formatWeiAsEth(cs.relayerBalanceWei)} ${symbol}` : 'Balance unavailable'}
          </span>
          {cs.relayerBalanceWei !== undefined && <span className="block text-xs text-subtle">{cs.relayerBalanceWei} wei</span>}
        </Field>
        <Field label="Status">
          <span className={health === 'healthy' ? 'text-success' : health === 'unknown' ? 'text-subtle' : health === 'low' ? 'text-warning' : 'text-danger'}>
            {cs.healthMessage ?? HEALTH_LABEL[health]}
          </span>
          {health === 'insufficient' && cs.shortfallWei && cs.shortfallWei !== '0' && (
            <span className="block text-xs">Shortfall: {eth(cs.shortfallWei, symbol)}</span>
          )}
        </Field>
        <Field label="Current gas price">
          {cs.gasPriceWei ? (
            <>
              {gwei(cs.gasPriceWei)} <span className="text-xs text-subtle">({cs.gasPriceWei} wei/gas; base {cs.baseFeeWei} + tip {cs.tipWei}; relayer fee cap {cs.feeCapWei})</span>
            </>
          ) : (
            'unavailable'
          )}
        </Field>
        <Field label="Pending operations">
          {cs.pendingOperations ?? 0} — needs {eth(cs.pendingRequiredWei ?? '0', symbol)}
          <span className="block text-xs text-subtle">Upper bound at the fee cap, including remaining one-time setup.</span>
        </Field>
        <Field label="Estimated capacity">
          {cs.executionsCovered !== undefined ? `≈ ${cs.executionsCovered.toLocaleString()} more execution(s) of already set-up wallets` : 'unavailable'}
          <span className="block text-xs text-subtle">
            One execution: up to {eth(cs.executionCostWei, symbol)}. Setting up a new wallet key and executing once: up to {eth(cs.newWalletCostWei, symbol)}.
            Low-balance threshold: {eth(cs.lowBalanceWei, symbol)}
            {cs.lowBalanceConfigured ? ' (configured)' : ' (default: one new wallet set-up)'}.
          </span>
        </Field>
        <Field label="Last refreshed">
          {checked ? new Date(checked).toLocaleString() : '—'}
          {cs.blockNumber !== undefined && <span className="text-xs text-subtle"> · block {cs.blockNumber.toLocaleString()}</span>}
        </Field>
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setFund(true)}>Fund / Recharge account</Button>
        <Button size="sm" variant="secondary" loading={refreshing} onClick={() => void refresh()}>
          <RefreshCw size={14} className="mr-1" /> Refresh balance
        </Button>
        {explorer && (
          <a href={explorer.addressUrl(cs.relayerAddress!)} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1 rounded-lg border border-line px-3 text-xs font-medium">
            View on {explorer.name} <ExternalLink size={12} />
          </a>
        )}
      </div>
      <GasHistoryList cs={cs} onRecharge={() => void refresh()} />
      <FundSheet open={fund} onOpenChange={setFund} cs={cs} onRefresh={refresh} />
    </div>
  );
}

function GasHistoryList({ cs, onRecharge }: { cs: RelayerChainStatus; onRecharge: () => void }) {
  const q = useQuery({
    queryKey: ['qd-gas-history', cs.chainId],
    refetchInterval: 20_000,
    retry: 1,
    queryFn: async (): Promise<GasHistory> => (await getApi()).gasHistory(cs.chainId),
  });
  // A newly detected recharge refreshes the balance.
  const seen = useRef<number | null>(null);
  const recharges = rechargeCount(q.data?.transfers);
  useEffect(() => {
    if (!q.data) return;
    if (seen.current !== null && recharges > seen.current) onRecharge();
    seen.current = recharges;
  }, [recharges, q.data, onRecharge]);
  const view = balanceView(String(cs.chainId), q);
  const symbol = symbolOf(cs.chainId);
  const explorer = network(cs.chainId)?.explorer;
  return (
    <section aria-label="Gas service history" className="mt-4">
      <h4 className="mb-1 text-sm font-semibold">History</h4>
      {view.kind === 'loading' && <p className="text-xs text-subtle">Loading history…</p>}
      {view.kind === 'paused' && <p className="text-xs text-subtle">History not loaded yet — retrying when this window is active and online.</p>}
      {view.kind === 'error' && <p className="text-xs text-warning">History unavailable: {view.message}</p>}
      {view.kind === 'ready' && (
        <>
          <p className="mb-1 text-xs text-subtle">
            From chain receipts
            {view.data.historyAvailableSinceBlock ? `; blocks ${view.data.historyAvailableSinceBlock.toLocaleString()}–${view.data.scannedThroughBlock?.toLocaleString()} searched for recharges` : '; the first scan is still running'}.
          </p>
          {view.data.transfers.length === 0 ? (
            <p className="text-xs text-subtle">No recharges or gas payments recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-subtle">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Date</th>
                    <th className="py-1 pr-2 font-medium">Type</th>
                    <th className="py-1 pr-2 font-medium">Amount</th>
                    <th className="py-1 pr-2 font-medium">Gas used · price · fee</th>
                    <th className="py-1 pr-2 font-medium">Transaction</th>
                    <th className="py-1 pr-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {view.data.transfers.map((t) => {
                    const effect = transferEffectWei(t);
                    const internal = t.txHash.startsWith('internal:');
                    return (
                      <tr key={t.txHash}>
                        <td className="py-1 pr-2 whitespace-nowrap">{new Date(t.blockTime).toLocaleString()}</td>
                        <td className="py-1 pr-2">
                          {TRANSFER_KIND_LABEL[t.kind]}
                          {t.proposalId && <span className="block text-subtle">proposal {t.proposalId.slice(0, 8)}…</span>}
                        </td>
                        <td className={`py-1 pr-2 whitespace-nowrap ${effect > 0n ? 'text-success' : effect < 0n ? 'text-ink' : 'text-subtle'}`}>
                          {effect > 0n ? '+' : effect < 0n ? '−' : ''}
                          {formatWeiAsEth((effect < 0n ? -effect : effect).toString())} {symbol}
                        </td>
                        <td className="py-1 pr-2">{t.direction === 'out' ? `${t.gasUsed.toLocaleString()} · ${t.gasPriceWei} wei · ${eth(t.feeWei, symbol)}` : '—'}</td>
                        <td className="py-1 pr-2">
                          {internal ? (
                            <span className="text-subtle">internal transfer, block {t.blockNumber}</span>
                          ) : explorer ? (
                            <a href={explorer.txUrl(t.txHash)} target="_blank" rel="noopener noreferrer" className="font-mono text-primary underline">
                              {t.txHash.slice(0, 10)}…{t.txHash.slice(-6)}
                            </a>
                          ) : (
                            <span className="font-mono">{t.txHash.slice(0, 10)}…</span>
                          )}
                        </td>
                        <td className={`py-1 pr-2 ${t.success ? 'text-success' : 'text-danger'}`}>{t.success ? 'Success' : 'Reverted'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FundSheet({ open, onOpenChange, cs, onRefresh }: { open: boolean; onOpenChange: (o: boolean) => void; cs: RelayerChainStatus; onRefresh: () => Promise<void> }) {
  const [qr, setQr] = useState<string | null>(null);
  const address = cs.relayerAddress ?? '';
  const net = network(cs.chainId);
  const symbol = symbolOf(cs.chainId);
  // Instructions are shown only when the API's RPC is verified to serve this chain.
  const verified = cs.rpcOk && cs.rpcChainId === cs.chainId;
  useEffect(() => {
    if (!open || !address || !verified) return;
    setQr(null);
    QRCode.toDataURL(address, { margin: 1, width: 400, errorCorrectionLevel: 'M', color: { dark: '#070B14', light: '#FFFFFF' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [open, address, verified]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`Fund the Gas Service Account · ${networkLabel(cs.chainId)}`}>
      {!verified ? (
        <p role="alert" className="text-sm text-danger">
          The server could not confirm it is connected to {networkLabel(cs.chainId)} (chain {cs.chainId}). Funding instructions are hidden until the network is verified.
        </p>
      ) : (
        <div className="text-sm">
          <p className="mb-3">
            Send {symbol} to this address to fund QD Wallet’s gas service account. This account pays blockchain execution fees for shared-wallet transactions.
          </p>
          <div className="mx-auto mb-3 h-48 w-48 rounded-2xl bg-white p-2 ring-1 ring-line">
            {qr && <img src={qr} alt={`QR code for ${address}`} className="h-full w-full" />}
          </div>
          <div className="mb-3 flex items-center gap-1 rounded-xl bg-sunken px-3 py-2">
            <span className="min-w-0 flex-1 break-all font-mono text-xs" aria-label="Funding address">{address}</span>
            <CopyButton value={address} label="Copy funding address" />
          </div>
          <ul className="mb-3 list-disc space-y-1 pl-5 text-[13px]">
            <li>
              Network: <strong>{networkLabel(cs.chainId)}</strong> (chain ID {cs.chainId}). Send only {symbol} on this network; funds sent on another network will not arrive here.
            </li>
            <li>This is an ordinary blockchain transfer from any external wallet you control. It is not an internal top-up, and QD Wallet never moves funds from your personal wallet for it.</li>
            <li>Gas is paid by this account; the shared smart account still needs its own balance for the transfer amounts.</li>
            {cs.shortfallWei && cs.shortfallWei !== '0' && (
              <li>
                Currently short by at least <strong>{eth(cs.shortfallWei, symbol)}</strong> for pending work.
              </li>
            )}
            {cs.newWalletCostWei && <li>One new shared wallet’s one-time setup plus its first execution costs up to {eth(cs.newWalletCostWei, symbol)} at current gas prices.</li>}
            {net?.faucetUrl && (
              <li>
                Need test {symbol}? Use a faucet such as{' '}
                <a href={net.faucetUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                  {new URL(net.faucetUrl).host}
                </a>{' '}
                and paste the address above. Faucet ETH has no monetary value.
              </li>
            )}
          </ul>
          <div className="flex flex-wrap gap-2">
            {net?.explorer && (
              <a href={net.explorer.addressUrl(address)} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center gap-1 rounded-lg border border-line px-3 text-xs font-medium">
                View address on {net.explorer.name} <ExternalLink size={12} />
              </a>
            )}
            <Button size="sm" variant="secondary" onClick={() => void onRefresh()}>
              I’ve sent it — refresh balance
            </Button>
          </div>
          <p className="mt-2 text-xs text-subtle">Recharges appear in the history once mined (usually within a minute on {networkLabel(cs.chainId)}).</p>
        </div>
      )}
    </Sheet>
  );
}
