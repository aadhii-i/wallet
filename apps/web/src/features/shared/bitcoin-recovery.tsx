'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BitcoinSharedPolicy } from '@qd/bitcoin';
import type { PolicyBackup } from '@qd/wallet-core';
import { formatUnits } from '@qd/blockchain';
import { vault } from '@/lib/vault-client';
import { createBitcoinDataSource } from '@/lib/bitcoin-api';
import { checkSharedBitcoinNetwork, discoverSharedBitcoin, recheckSharedBitcoinProposal } from '@/lib/bitcoin-shared';
import { Button } from '@/components/ui/button';
import type { VaultOps } from '@/lib/vault-protocol';

const field = 'mt-1 block w-full rounded-xl border border-line bg-surface p-2';
const txLink = (txid: string) => `https://mempool.space/testnet4/tx/${encodeURIComponent(txid)}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Bitcoin recovery action failed');
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Recovery contains only this participant's share. Decryption and evidence
 * verification are confined to the key worker, including after a stale import. */
export function BitcoinRecovery({
  walletId,
  policy,
  enabled,
}: {
  walletId: string;
  policy?: BitcoinSharedPolicy;
  enabled: boolean;
}) {
  const [backup, setBackup] = useState<PolicyBackup>(),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [note, setNote] = useState(''),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState<VaultOps['btcSharedSaved']['res']>();
  const qc = useQueryClient(),
    scope = ['bitcoin-shared-recovery', walletId, policy?.context.accountId, policy?.context.keygenId];
  const saved = useQuery({
    queryKey: [...scope, 'saved'],
    enabled: enabled && !!policy,
    queryFn: () => vault.call('btcSharedStatus', { policy: policy! }),
    refetchInterval: 5000,
  });
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await action();
      await qc.invalidateQueries({ queryKey: ['bitcoin-shared'] });
      await qc.invalidateQueries({ queryKey: scope });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="my-4 space-y-3" aria-label="Bitcoin backup and saved payments">
      {enabled && policy && (
        <>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const value = await vault.call('btcSharedExport', { policy });
                download(`qd-bitcoin-share-${value.policyId.slice(0, 12)}.json`, value);
                setNote(
                  'Encrypted share backup exported. Keep its export-time password and your recovery phrase separately.',
                );
              })
            }
          >
            Export encrypted Bitcoin share backup
          </Button>
          <p className="text-sm text-muted">
            Each participant needs their own encrypted share backup and matching recovery phrase. This does not replace
            participant-device authorization.
          </p>
          <details className="text-sm">
            <summary>Saved Bitcoin payments</summary>
            <p className="my-2 text-muted">
              Expiry does not invalidate released Bitcoin signatures. Missing transactions keep their input
              reservations. Resubmission always uses the exact saved bytes.
            </p>
            {saved.isError && <p role="alert">Saved Bitcoin payments are unavailable.</p>}
            {Object.values(saved.data?.records ?? {}).map((record) => (
              <div key={record.proposal.id} className="my-2 rounded-xl border border-line p-3">
                <p>
                  {formatUnits(BigInt(record.proposal.amount), 8)} BTC · {record.status}
                </p>
                <p className="break-all">Recipient: {record.proposal.recipient}</p>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const value = await vault.call('btcSharedSaved', { policy, id: record.proposal.id });
                      setReview(value);
                      if (!value.final) {
                        setNote(
                          'No complete transaction was saved on this device. Keep the reservation and obtain the original quorum’s signatures.',
                        );
                        return;
                      }
                      await checkSharedBitcoinNetwork();
                      const tx = await createBitcoinDataSource('testnet4').getTransaction(value.final.txid);
                      if (!tx) {
                        setNote('Transaction not found. Its outcome remains uncertain; signed inputs stay reserved.');
                        return;
                      }
                      await vault.call('btcSharedReconcile', {
                        policy,
                        id: value.proposal.id,
                        txid: value.final.txid,
                        status: tx.status === 'confirmed' ? 'confirmed' : 'pending',
                      });
                      setNote(
                        tx.status === 'confirmed'
                          ? 'Saved Bitcoin payment confirmed by the configured network provider.'
                          : 'Saved Bitcoin payment is pending.',
                      );
                    })
                  }
                >
                  Review saved Bitcoin payment
                </Button>
              </div>
            ))}
            {review?.final && (
              <div
                className="my-3 space-y-2 rounded-xl border border-primary p-3"
                aria-label="Saved Bitcoin payment review"
              >
                <p className="break-all">Recipient: {review.proposal.recipient}</p>
                <p>
                  Amount: {formatUnits(BigInt(review.proposal.amount), 8)} BTC. Fee:{' '}
                  {formatUnits(BigInt(review.proposal.maxFee), 8)} BTC.
                </p>
                <a className="break-all underline" href={txLink(review.final.txid)} target="_blank" rel="noreferrer">
                  View saved Bitcoin transaction
                </a>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const current = await vault.call('btcSharedSaved', { policy, id: review.proposal.id });
                      if (!current.final || current.final.txid !== review.final!.txid)
                        throw new Error('Saved payment changed; review it again');
                      await checkSharedBitcoinNetwork();
                      const source = createBitcoinDataSource('testnet4'),
                        found = await source.getTransaction(current.final.txid);
                      if (found) {
                        setNote('This transaction is already known to the network. No second payment was submitted.');
                        return;
                      }
                      await recheckSharedBitcoinProposal(policy, current.proposal, true);
                      if ((await source.broadcast(current.final.raw)) !== current.final.txid)
                        throw new Error('Broadcast transaction ID mismatch');
                      await vault.call('btcSharedReconcile', {
                        policy,
                        id: current.proposal.id,
                        txid: current.final.txid,
                        status: 'pending',
                      });
                      setNote('Exact saved Bitcoin transaction submitted. Confirmation remains pending.');
                    })
                  }
                >
                  Resubmit exact saved Bitcoin transaction
                </Button>
              </div>
            )}
          </details>
          <BitcoinSharedHistory policy={policy} />
        </>
      )}
      <details className="text-sm">
        <summary>Restore encrypted Bitcoin share backup</summary>
        <p className="my-2 text-muted">
          Unlock the wallet and share storage first. Use the matching recovery phrase and export-time backup password.
          An import preserves local input reservations and never resumes an old Raccoon session.
        </p>
        <label className="block">
          Encrypted Bitcoin backup
          <input
            type="file"
            accept="application/json,.json"
            className={field}
            onChange={async (e) => {
              try {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 24000000) throw new Error('Recovery file is too large');
                setBackup(JSON.parse(await file.text()) as PolicyBackup);
              } catch (error) {
                setBackup(undefined);
                setError(errorText(error));
              }
            }}
          />
        </label>
        <label className="my-2 block">
          Bitcoin backup password
          <input
            type="password"
            autoComplete="off"
            className={field}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <Button
          size="sm"
          disabled={busy || !backup || !password}
          onClick={() =>
            void run(async () => {
              const pw = password;
              setPassword('');
              const result = await vault.call('btcSharedImport', { backup: backup!, password: pw });
              if (result.policy.context.walletId !== walletId) {
                setNote('Backup restored for another shared wallet. Open that wallet to continue.');
                return;
              }
              setNote(
                'Bitcoin share restored. Confirm the matching policy and reconcile saved payments before new spending.',
              );
            })
          }
        >
          Restore Bitcoin share
        </Button>
      </details>
      {note && (
        <p role="status" className="text-sm">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function BitcoinSharedHistory({ policy }: { policy: BitcoinSharedPolicy }) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]),
    cursor = cursors[cursors.length - 1];
  const history = useQuery({
    queryKey: [
      'bitcoin-shared-history',
      policy.context.walletId,
      policy.context.accountId,
      policy.context.keygenId,
      cursor,
    ],
    queryFn: async () => {
      const discovery = await discoverSharedBitcoin(policy),
        source = createBitcoinDataSource('testnet4');
      return source.getWalletHistory!(discovery.addresses, cursor);
    },
    refetchInterval: 30000,
  });
  return (
    <details className="text-sm">
      <summary>Shared Bitcoin activity</summary>
      {history.isError && <p role="alert">Bitcoin history is unavailable.</p>}
      {history.data?.items.map((item) => (
        <p key={item.hash} className="my-2">
          <a className="break-all underline" href={txLink(item.hash)} target="_blank" rel="noreferrer">
            {item.direction} · {formatUnits(BigInt(item.amount), 8)} BTC · {item.status}
          </a>
        </p>
      ))}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={cursors.length < 2 || history.isFetching}
          onClick={() => setCursors((previous) => previous.slice(0, -1))}
        >
          Previous Bitcoin activity
        </Button>
        <Button
          size="sm"
          disabled={!history.data?.nextCursor || history.isFetching}
          onClick={() => setCursors((previous) => [...previous, history.data!.nextCursor])}
        >
          Next Bitcoin activity
        </Button>
      </div>
    </details>
  );
}
