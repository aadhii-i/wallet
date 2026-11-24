'use client';
/**
 * Confirmed shared-wallet transaction receipt: rendered (and exported as a
 * PDF) only from data read back from the chain and verified against the
 * approved proposal (lib/verified-receipt.ts), never from the API's status.
 */
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { EVM_NETWORKS } from '@qd/blockchain';
import { nativeSymbol } from '@/lib/shared-network';
import { proxyRequest, type Proposal, type SharedWallet } from '@qd/rpc';
import { executionMessage, proposalCall } from '@qd/qd-account';
import { getApi } from '@/lib/api';
import { formatWeiAsEth } from '@/lib/eth-amount';
import { buildReceiptPdf, receiptDisclaimer, receiptFileName, receiptTitle, type VerifiedReceipt } from '@/lib/receipt-pdf';
import { verifyExecutionReceipt, type RawBlock, type RawReceipt, type RawTx } from '@/lib/verified-receipt';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/identity';

async function rpc<T>(chainId: number, method: string, params: unknown[]): Promise<T> {
  return (await proxyRequest(await getApi(), chainId)({ method, params })) as T;
}

export function explorerFor(chainId: number) {
  return EVM_NETWORKS.find((n) => n.chainId === chainId)?.explorer;
}

export function networkLabel(chainId: number): string {
  if (chainId === 11155111) return 'Sepolia Testnet';
  return EVM_NETWORKS.find((n) => n.chainId === chainId)?.name ?? (chainId === 31337 ? 'Localhost (Anvil)' : `Chain ${chainId}`);
}

/** Etherscan (or the chain's explorer) link for a transaction, if the chain has a public explorer. */
export function txExplorerUrl(chainId: number, hash: string): string | null {
  const ex = explorerFor(chainId);
  return ex ? ex.txUrl(hash) : null;
}

/** Reads the execute transaction's receipt, transaction and block from the chain and verifies them. */
export function useVerifiedReceipt(p: Proposal) {
  const ex = p.execution.status !== 'not_started' ? p.execution : null;
  return useQuery({
    queryKey: ['qd-verified-receipt', p.chainId, ex?.txHash],
    enabled: !!ex && ex.status === 'confirmed' && !!ex.txHash,
    staleTime: Infinity,
    retry: 3,
    queryFn: async () => {
      const hash = ex!.txHash;
      const account = ex!.accountAddress as Address;
      const [receipt, tx] = await Promise.all([
        rpc<RawReceipt | null>(p.chainId, 'eth_getTransactionReceipt', [hash]),
        rpc<RawTx | null>(p.chainId, 'eth_getTransactionByHash', [hash]),
      ]);
      const block = receipt ? await rpc<RawBlock | null>(p.chainId, 'eth_getBlockByNumber', [receipt.blockNumber, false]) : null;
      const call = proposalCall(p);
      return verifyExecutionReceipt({ receipt, tx, block, account, call, message: executionMessage(BigInt(p.chainId), account, call) });
    },
  });
}

function useBalance(chainId: number, address: string | undefined) {
  return useQuery({
    queryKey: ['qd-balance', chainId, address],
    enabled: !!address,
    refetchInterval: 15_000,
    queryFn: async () => BigInt(await rpc<string>(chainId, 'eth_getBalance', [address, 'latest'])),
  });
}

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[9.5rem_1fr] gap-2 py-0.5">
      <dt className="text-subtle">{label}</dt>
      <dd className={mono ? 'break-all font-mono text-xs' : ''}>{children}</dd>
    </div>
  );
}

export function TransactionReceiptCard({ wallet, proposal: p, verifiedOnDevice }: { wallet: SharedWallet; proposal: Proposal; verifiedOnDevice: boolean | null }) {
  const check = useVerifiedReceipt(p);
  const facts = check.data?.ok ? check.data.facts : null;
  const recipientBalance = useBalance(p.chainId, facts?.to);
  const accountBalance = useBalance(p.chainId, facts?.from);
  if (p.execution.status !== 'confirmed') return null;
  if (check.isLoading) return <p className="mt-2 text-subtle">Reading the transaction receipt from the chain…</p>;
  if (check.isError) return <p className="mt-2 text-danger">Could not read the receipt from the chain: {String((check.error as Error)?.message ?? check.error)}</p>;
  if (!check.data?.ok) {
    return <p role="alert" className="mt-2 text-danger">The chain does not confirm this execution: {check.data?.reason}. No receipt is shown.</p>;
  }
  const f = facts!;
  const nameOf = (id: string) => wallet.participants.find((x) => x.id === id)?.displayName || 'Participant';
  const signers = (p.signing?.signers ?? []).map((id, i) => `${nameOf(id)} (party ${p.signing?.signerPartyIndexes?.[i] ?? '?'})`);
  const explorer = explorerFor(p.chainId);
  const url = txExplorerUrl(p.chainId, f.txHash);
  const network = networkLabel(p.chainId);
  const verification = [
    'Verified by the coordinator',
    verifiedOnDevice === true ? 'on this device' : null,
    'and accepted on chain by QdRaccoonVerifier (QdAccount executed the call)',
  ].filter(Boolean).join(', ');
  const receipt: VerifiedReceipt = {
    status: 'Confirmed',
    txHash: f.txHash,
    explorerUrl: url ?? `chain ${p.chainId} has no public explorer`,
    networkName: network,
    chainId: p.chainId,
    from: f.from,
    to: f.to,
    amountEth: formatWeiAsEth(f.valueWei.toString()),
    symbol: nativeSymbol(p.chainId),
    blockNumber: f.blockNumber,
    blockTimestamp: f.blockTimestamp,
    txNonce: f.txNonce,
    accountNonce: f.accountNonce,
    gasUsed: f.gasUsed.toString(),
    effectiveGasPriceWei: f.effectiveGasPrice.toString(),
    totalFeeEth: formatWeiAsEth(f.totalFeeWei.toString()),
    relayer: f.relayer,
    policy: `${p.requiredApprovals}-of-${p.participantCount}`,
    signers,
    signatureVerification: verification,
    proposalId: p.id,
    generatedAt: new Date().toISOString(),
  };
  const download = () => {
    const bytes = buildReceiptPdf(receipt);
    const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = receiptFileName(receipt);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const print = () => {
    document.body.classList.add('printing-receipt');
    const done = () => {
      document.body.classList.remove('printing-receipt');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  };

  return (
    <section aria-label="Transaction receipt" data-receipt-print className="mt-3 rounded-xl border border-line bg-surface p-3 text-[13px]">
      <header className="mb-2 flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-xs font-bold text-white">QD</span>
        <div>
          <p className="text-xs text-primary">QD Wallet</p>
          <h4 className="font-semibold">{receiptTitle(network)}</h4>
        </div>
        <span className="ml-auto rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">Status: Confirmed</span>
      </header>
      <dl>
        <Row label="Transaction hash" mono>{f.txHash}</Row>
        {url && (
          <Row label={explorer?.name.includes('etherscan') ? 'Etherscan' : 'Explorer'} mono>
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">{url}</a>
          </Row>
        )}
        <Row label="Network">{network} (chain ID {p.chainId})</Row>
        <Row label="From (shared account)" mono>{f.from}</Row>
        <Row label="To (recipient)" mono>{f.to}</Row>
        <Row label="Amount">{receipt.amountEth} {receipt.symbol}</Row>
        <Row label="Block">{f.blockNumber} · {new Date(f.blockTimestamp).toLocaleString()}</Row>
        <Row label="Transaction nonce">{f.txNonce} (relayer) · account nonce {f.accountNonce}</Row>
        <Row label="Gas used">{receipt.gasUsed}</Row>
        <Row label="Effective gas price">{receipt.effectiveGasPriceWei} wei</Row>
        <Row label="Total gas fee">{receipt.totalFeeEth} {receipt.symbol} (paid by the relayer {f.relayer.slice(0, 10)}…)</Row>
        <Row label="Threshold policy">{receipt.policy}</Row>
        <Row label="Signing participants">{signers.join(', ')}</Row>
        <Row label="Raccoon signature">{verification}</Row>
        <Row label="Balances now">
          Recipient {recipientBalance.data !== undefined ? `${formatWeiAsEth(recipientBalance.data.toString())} ${receipt.symbol}` : '…'} · shared account{' '}
          {accountBalance.data !== undefined ? `${formatWeiAsEth(accountBalance.data.toString())} ${receipt.symbol}` : '…'} (live from the chain)
        </Row>
      </dl>
      <p className="mt-2 text-xs text-subtle">{receiptDisclaimer(network, explorer?.name.includes('etherscan') ? 'Etherscan' : (explorer?.name ?? 'a block explorer'))}</p>
      <div className="mt-2 flex flex-wrap gap-2 print:hidden">
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-white">
            View on Etherscan
          </a>
        )}
        <CopyButton value={f.txHash} label="Copy transaction hash" toastText="Transaction hash copied" className="border border-line" />
        <Button size="sm" variant="secondary" onClick={download}>Download PDF receipt</Button>
        <Button size="sm" variant="secondary" onClick={print}>Print receipt</Button>
      </div>
    </section>
  );
}
