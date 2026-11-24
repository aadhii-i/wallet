'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BitcoinAddressType, BitcoinNetwork } from '@qd/blockchain';
import { createBitcoinDataSource } from '@/lib/bitcoin-api';
import { vault } from '@/lib/vault-client';
import { toast } from '@/lib/store';
import { Button } from '@/components/ui/button';

/** Explicit retry of already approved, persisted bytes. Never creates a new signature. */
export function BitcoinSavedPayments({
  account,
  from,
  network,
  addressType,
}: {
  account: number;
  from: string;
  network: BitcoinNetwork;
  addressType: BitcoinAddressType;
}) {
  const [busy, setBusy] = useState<string>();
  const [page, setPage] = useState(0);
  const saved = useQuery({
    queryKey: ['bitcoin-saved-payments', from, account, network.id, addressType, page],
    refetchInterval: 15_000,
    queryFn: async () => {
      const plan = await vault.call('btcChangePlan', { account, network: network.bitcoin.chain, addressType });
      const source = createBitcoinDataSource(network.bitcoin.chain);
      const pending = [];
      for (const payment of plan.pending.sort((a, b) => b.createdAt - a.createdAt).slice(page * 20, (page + 1) * 20)) {
        const status = await source.getTransaction(payment.txid);
        if (status?.status !== 'confirmed') pending.push(payment);
      }
      return { pending, count: plan.pending.length };
    },
  });
  if (saved.isError)
    return (
      <p role="status" className="mb-4 text-sm text-muted">
        Saved Bitcoin payments could not be checked. Refresh before retrying an earlier send.
      </p>
    );
  if (!saved.data?.count) return null;
  return (
    <section aria-label="Saved Bitcoin payments" className="mb-4 rounded-2xl border border-line-strong p-4">
      <h2 className="font-semibold">Saved signed payments</h2>
      <p className="mb-3 text-sm text-muted">
        These payments were already approved. Retrying sends the same transaction, without creating another payment.
      </p>
      {saved.data.pending.length === 0 && <p className="text-sm text-muted">Payments on this page are confirmed.</p>}
      {saved.data.pending.map((payment) => (
        <div key={payment.txid} className="mb-2 flex items-center justify-between gap-3">
          <span className="truncate font-mono text-xs">{payment.txid.slice(0, 12)}…</span>
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy}
            loading={busy === payment.txid}
            onClick={async () => {
              setBusy(payment.txid);
              try {
                const source = createBitcoinDataSource(network.bitcoin.chain);
                const status = await source.getTransaction(payment.txid);
                if (status?.status !== 'confirmed') {
                  const returned = await source.broadcast(payment.raw);
                  if (returned.toLowerCase() !== payment.txid)
                    throw new Error('Broadcast response did not match the saved transaction');
                }
                toast.success('Saved payment checked', 'The original transaction was confirmed or resubmitted.');
                void saved.refetch();
              } catch {
                toast.error(
                  'Could not confirm submission',
                  'The saved transaction and its input reservations have been retained.',
                );
              } finally {
                setBusy(undefined);
              }
            }}
          >
            Retry submission
          </Button>
        </div>
      ))}
      <div className="mt-2 flex gap-2">
        {page > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setPage((p) => p - 1)}>
            Newer
          </Button>
        )}
        {(page + 1) * 20 < saved.data.count && (
          <Button size="sm" variant="ghost" onClick={() => setPage((p) => p + 1)}>
            Older
          </Button>
        )}
      </div>
    </section>
  );
}
