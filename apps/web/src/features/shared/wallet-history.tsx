'use client';
/**
 * Wallet History: every transfer of this shared wallet's smart accounts, read
 * by the API's chain index from receipts and logs (not from proposals or
 * frontend state). Separate from Proposals: a proposal is an intention; this
 * is what the chain recorded, including incoming transfers and failures.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { assetsForNetwork, EVM_NETWORKS } from '@qd/blockchain';
import { proxyRequest, type SharedWallet, type WalletHistoryItem } from '@qd/rpc';
import { getApi } from '@/lib/api';
import { formatWeiAsEth } from '@/lib/eth-amount';
import { balanceView, preferredChain } from '@/lib/gas-service';
import { useServerNetworks } from '@/lib/hooks';
import { historyProblem, indexWarning, normalizeWalletHistory } from '@/lib/wallet-history';
import { receiptEligible, verifyHistoryEntry } from '@/lib/history-receipt';
import { buildReceiptPdf, receiptFileName, type VerifiedReceipt } from '@/lib/receipt-pdf';
import type { RawBlock, RawReceipt, RawTx } from '@/lib/verified-receipt';
import { Button } from '@/components/ui/button';
import { CopyButton, shortAddress } from '@/components/ui/identity';
import { useGasServiceStatus } from '../gas-service/hooks';
import { networkLabel, txExplorerUrl } from './transaction-receipt';
import { PROPOSAL_NETWORKS } from './shared-wallets';

const net = (chainId: number) => EVM_NETWORKS.find((n) => n.chainId === chainId);

/** Symbol and decimals of an entry's asset; unknown tokens are shown in base units, never as ETH. */
export function assetFor(chainId: number, token: string): { symbol: string; decimals: number; known: boolean } {
  const n = net(chainId);
  if (!token) return { symbol: n?.nativeCurrency.symbol === 'SepoliaETH' ? 'ETH' : (n?.nativeCurrency.symbol ?? 'ETH'), decimals: 18, known: true };
  const a = n ? assetsForNetwork(n).find((x) => x.contract?.toLowerCase() === token.toLowerCase()) : undefined;
  return a ? { symbol: a.symbol, decimals: a.decimals, known: true } : { symbol: `units of token ${shortAddress(token)}`, decimals: 0, known: false };
}

function formatUnits(amount: string, decimals: number): string {
  if (decimals === 18) return formatWeiAsEth(amount);
  if (decimals === 0) return amount;
  const s = amount.padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
}

/** What an entry is, from the shared wallet's point of view. */
export function entryTitle(e: WalletHistoryItem, symbol: string): string {
  if (e.kind === 'internal') return `Received ${symbol} (internal transfer)`;
  if (!e.success) {
    if (e.kind === 'native' && e.direction === 'received' && e.proposalId) return 'Execution failed (reverted on chain)';
    if (e.kind === 'qd_execute') return 'Execution failed (call reverted)';
    return e.direction === 'sent' ? `Send failed` : 'Failed incoming transaction';
  }
  if (e.kind === 'qd_execute' && e.amount === '0') return 'Contract interaction';
  if (e.direction === 'self') return `Self transfer ${symbol}`;
  return e.direction === 'sent' ? `Sent ${symbol}` : `Received ${symbol}`;
}

async function rpc<T>(chainId: number, method: string, params: unknown[]): Promise<T> {
  return (await proxyRequest(await getApi(), chainId)({ method, params })) as T;
}

export function WalletHistory({ wallet }: { wallet: SharedWallet }) {
  const gas = useGasServiceStatus({ refetchInterval: false });
  const server = useServerNetworks();
  // Only networks this API serves (it indexes through its own RPC); all of them until it answers.
  const served = new Set(server.data?.networks.map((n) => n.chainId));
  const networks = server.data ? PROPOSAL_NETWORKS.filter((n) => served.has(n.chainId)) : PROPOSAL_NETWORKS;
  const [picked, setPicked] = useState<number | null>(null);
  const chainId = picked ?? preferredChain(networks.map((n) => n.chainId), gas.data);
  const q = useQuery({
    queryKey: ['qd-wallet-history', wallet.id, chainId],
    refetchInterval: 15_000,
    // A missing route or an unknown wallet will not fix itself by retrying.
    retry: (n, err) => n < 1 && !['endpoint_missing', 'not_found', 'unsupported_network', 'invalid'].includes(historyProblem(err, '').kind),
    queryFn: async () => normalizeWalletHistory(await (await getApi()).sharedWalletHistory(wallet.id, chainId), chainId),
  });
  const view = balanceView(wallet.id, q);
  const [open, setOpen] = useState<string | null>(null);
  const networkName = networkLabel(chainId);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="flex-1 text-[13px] text-muted">Transactions of this wallet’s smart accounts, read from the blockchain. Proposals are listed separately.</p>
        <select aria-label="History network" value={chainId} onChange={(e) => setPicked(Number(e.target.value))} className="rounded-lg border border-line bg-surface px-2 py-1 text-sm">
          {networks.map((n) => (
            <option key={n.chainId} value={n.chainId}>
              {n.name}
            </option>
          ))}
        </select>
      </div>
      {view.kind === 'loading' && <p className="text-sm text-subtle">Loading history from the chain index…</p>}
      {view.kind === 'paused' && <p className="text-sm text-subtle">History not loaded yet — retrying when this window is active and online.</p>}
      {view.kind === 'error' && (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {historyProblem(q.error, networkName).message}
          <button type="button" onClick={() => void q.refetch()} className="ml-2 text-xs underline">Retry</button>
        </div>
      )}
      {view.kind === 'ready' && indexWarning(view.data) && (
        <p role="status" className="mb-2 rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">{indexWarning(view.data)}</p>
      )}
      {view.kind === 'ready' &&
        (view.data.addresses.length === 0 ? (
          <p className="text-sm text-subtle">No smart-account address yet: history starts once an account address is derived.</p>
        ) : view.data.items.length === 0 ? (
          <p className="text-sm text-subtle">No transactions on {networkLabel(chainId)} yet.</p>
        ) : (
          <ul aria-label="Wallet history entries" className="divide-y divide-line">
            {view.data.items.map((e) => {
              const key = `${e.txHash}:${e.logIndex}`;
              const a = assetFor(chainId, e.token);
              const title = entryTitle(e, a.symbol);
              const sign = e.direction === 'sent' ? '−' : e.direction === 'received' ? '+' : '';
              return (
                <li key={key} className="py-2" aria-label={`${title} ${e.txHash}`}>
                  <button type="button" onClick={() => setOpen(open === key ? null : key)} className="flex w-full items-start gap-2 text-left">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                        {title}
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${e.success ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`} aria-label="Transaction status">
                          {e.success ? 'Confirmed' : 'Failed'}
                        </span>
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {e.direction === 'sent' ? 'To' : 'From'} <span className="font-mono">{shortAddress(e.direction === 'sent' ? e.to : e.from || '—')}</span> ·{' '}
                        {new Date(e.blockTime).toLocaleString()}
                      </span>
                    </span>
                    <span className={`shrink-0 text-right text-sm font-semibold tabular-nums ${e.direction === 'received' && e.success ? 'text-success' : ''}`} aria-label="Amount">
                      {e.success || e.amount !== '0' ? `${sign}${formatUnits(e.amount, a.decimals)} ${a.symbol}` : '—'}
                    </span>
                  </button>
                  {e.explorerUrl && (
                    <a href={e.explorerUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline">
                      {e.explorerUrl.includes('etherscan.io') ? 'View on Etherscan' : 'View on block explorer'}
                    </a>
                  )}
                  {open === key && <EntryDetails wallet={wallet} chainId={chainId} e={e} title={title} />}
                </li>
              );
            })}
          </ul>
        ))}
    </div>
  );
}

function D({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 py-0.5">
      <dt className="text-subtle">{label}</dt>
      <dd className={mono ? 'break-all font-mono text-xs' : ''}>{children}</dd>
    </div>
  );
}

function EntryDetails({ wallet, chainId, e, title }: { wallet: SharedWallet; chainId: number; e: WalletHistoryItem; title: string }) {
  const a = assetFor(chainId, e.token);
  const url = e.explorerUrl ?? (/^0x[0-9a-f]{64}$/i.test(e.txHash) ? txExplorerUrl(chainId, e.txHash) : null);
  const native = assetFor(chainId, '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const [receipt, tx] = await Promise.all([
        rpc<RawReceipt | null>(chainId, 'eth_getTransactionReceipt', [e.txHash]),
        rpc<RawTx | null>(chainId, 'eth_getTransactionByHash', [e.txHash]),
      ]);
      const block = receipt ? await rpc<RawBlock | null>(chainId, 'eth_getBlockByNumber', [receipt.blockNumber, false]) : null;
      const check = verifyHistoryEntry(e, receipt, tx, block);
      if (!check.ok) {
        setProblem(`The chain does not confirm this entry: ${check.reason}. No receipt was generated.`);
        return;
      }
      const f = check.facts;
      const r: VerifiedReceipt = {
        status: 'Confirmed', txHash: f.txHash, explorerUrl: url ?? `chain ${chainId} has no public explorer`, networkName: networkLabel(chainId), chainId,
        from: e.from, to: e.to, fromLabel: e.direction === 'sent' ? 'From (shared smart account)' : 'From', toLabel: e.direction === 'received' ? 'To (shared smart account)' : 'To (recipient)',
        amountEth: formatUnits(e.amount, a.decimals), symbol: a.symbol, blockNumber: f.blockNumber, blockTimestamp: f.blockTimestamp,
        gasUsed: f.gasUsed.toString(), effectiveGasPriceWei: f.effectiveGasPrice.toString(), totalFeeEth: formatWeiAsEth(f.totalFeeWei.toString()),
        ...(e.kind === 'qd_execute' ? { relayer: f.feePayer } : { feePayer: f.feePayer }),
        ...(e.proposalId ? { proposalId: e.proposalId } : {}),
        generatedAt: new Date().toISOString(),
      };
      const blob = new Blob([buildReceiptPdf(r) as BlobPart], { type: 'application/pdf' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = receiptFileName(r);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (err) {
      setProblem(`Could not read the receipt from the chain: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Transaction details" className="mt-2 rounded-xl bg-sunken/50 p-2.5 text-[13px]">
      <dl>
        <D label="Type">{title}</D>
        <D label="Amount">
          {formatUnits(e.amount, a.decimals)} {a.symbol}
          {!a.known && <span className="block text-xs text-warning">Unknown token: amount shown in base units.</span>}
        </D>
        <D label="From" mono>{e.from || '—'}</D>
        <D label="To" mono>{e.to}</D>
        <D label="Network">{networkLabel(chainId)} (chain ID {chainId})</D>
        <D label="Date and time">{new Date(e.blockTime).toLocaleString()} · block {e.blockNumber}</D>
        <D label="Transaction hash">
          {e.kind === 'internal' ? (
            <span className="text-subtle">No direct transaction: the balance increased in block {e.blockNumber} through a contract the index cannot decode.</span>
          ) : (
            <span className="flex items-center gap-1">
              <span className="break-all font-mono text-xs" aria-label="Transaction hash">{e.txHash}</span>
              <CopyButton value={e.txHash} label="Copy transaction hash" toastText="Transaction hash copied" />
            </span>
          )}
        </D>
        {e.kind !== 'internal' && (
          <D label="Gas">
            {e.gasUsed.toLocaleString()} gas · {e.gasPriceWei} wei/gas · fee {formatWeiAsEth(e.feeWei || '0')} {native.symbol}
            <span className="block text-xs text-subtle">Paid by {e.kind === 'qd_execute' || (e.proposalId && e.direction === 'received') ? 'the gas service account' : 'the sender'} {shortAddress(e.txFrom)}</span>
          </D>
        )}
        <D label="Status">{e.success ? 'Confirmed (receipt status 1)' : 'Failed — no value moved'}</D>
        {e.proposalId && <D label="Proposal" mono>{e.proposalId}</D>}
      </dl>
      <div className="mt-2 flex flex-wrap gap-2">
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-white">
            View on Etherscan
          </a>
        )}
        {receiptEligible(e) && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void download()}>
            Download PDF receipt
          </Button>
        )}
      </div>
      {problem && <p role="alert" className="mt-1 text-danger">{problem}</p>}
      <p className="mt-1 text-xs text-subtle">Wallet: {wallet.name}. Amounts and status come from the transaction receipt.</p>
    </section>
  );
}
