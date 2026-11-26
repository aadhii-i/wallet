'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as B from '@qd/bitcoin';
import * as H from '@qd/hedera';
import {
  fromB64url,
  type SharedWallet,
  type NativeMigrationView,
  type NativeMigrationIntent,
  type NativeMigrationAttempt,
  type NativeAccountMapping,
  type NativeMigrationReview,
  type NativePolicy,
} from '@qd/rpc';
import { formatUnits } from '@qd/blockchain';
import { getApi } from '@/lib/api';
import { vault } from '@/lib/vault-client';
import { createBitcoinDataSource } from '@/lib/bitcoin-api';
import { discoverSharedBitcoin, hydrateSharedBitcoinCoins } from '@/lib/bitcoin-shared';
import {
  bitcoinPolicy,
  hederaPolicy,
  verifyMigration,
  migrationMessages,
  verifiedNativeMigrations,
} from '@/lib/native-migration-client';
import { submitSharedHedera } from '@/lib/hedera-shared-client';
import { Button } from '@/components/ui/button';
import { BitcoinProposal } from './bitcoin-shared';
import { HederaProposal } from './hedera-shared';

const field = 'block w-full rounded-xl border border-line bg-surface p-2';
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Migration action failed');
const content = <T,>(m: { payload: string }): T => JSON.parse(new TextDecoder().decode(fromB64url(m.payload))) as T;

export function NativeMigrationPanel({ wallet }: { wallet: SharedWallet }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['native-migrations', wallet.id],
    queryFn: () => verifiedNativeMigrations(wallet.id),
    enabled: !!wallet.nativeCustodyLocked,
    refetchInterval: 5000,
  });
  const [create, setCreate] = useState(false);
  if (!wallet.nativeCustodyLocked) return null;
  return (
    <section
      className="mb-4 space-y-3 rounded-2xl border border-line bg-surface p-4"
      aria-label="Native group migration"
    >
      <h2 className="text-lg font-semibold">Change the native signing group</h2>
      <p className="text-sm text-muted">
        Prepare a replacement shared wallet using the existing participant and key setup. Keep the old group and all
        backups. Bitcoin funds must move to its new address; Hedera keeps its account number and changes its signing
        keys. EVM accounts remain in the old group.
      </p>
      {query.isError ? (
        <p role="alert" className="text-sm text-danger">
          Migration status could not be verified. Native signing must wait for a successful refresh.
        </p>
      ) : (
        <>
          {query.data?.map((view) => (
            <MigrationReview
              key={view.migration.manifest.id}
              wallet={wallet}
              view={view}
              refresh={() => qc.invalidateQueries({ queryKey: ['native-migrations'] })}
            />
          ))}
          {!query.isLoading &&
            !query.data?.some(
              (v) =>
                !['cancelled', 'complete'].includes(v.migration.status) ||
                (v.migration.manifest.sourceWalletId === wallet.id && v.migration.status === 'complete'),
            ) && (
              <Button size="sm" variant="secondary" onClick={() => setCreate((v) => !v)}>
                Prepare a group migration
              </Button>
            )}
          {create && (
            <MigrationDraft
              wallet={wallet}
              done={async () => {
                setCreate(false);
                await qc.invalidateQueries({ queryKey: ['native-migrations'] });
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function MigrationDraft({ wallet, done }: { wallet: SharedWallet; done: () => Promise<void> }) {
  const [targetId, setTarget] = useState(''),
    [mappings, setMappings] = useState<Record<string, string>>({}),
    [bitcoinFee, setBitcoinFee] = useState('100000'),
    [hederaFee, setHederaFee] = useState('100000000'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const wallets = useQuery({
    queryKey: ['shared-wallets'],
    queryFn: async () => (await (await getApi()).sharedWallets()).wallets,
  });
  const inventory = useQuery({
    queryKey: ['native-inventory', wallet.id],
    queryFn: async () => (await (await getApi()).nativeInventory(wallet.id)).accounts,
  });
  const target = useQuery({
    queryKey: ['native-target', targetId],
    enabled: !!targetId,
    queryFn: async () => {
      const api = await getApi();
      const [group, inventory] = await Promise.all([api.sharedWallet(targetId), api.nativeInventory(targetId)]);
      return { group, inventory: inventory.accounts };
    },
  });
  const accounts = [...new Set(inventory.data?.map((i) => i.accountId))];
  return (
    <form
      className="space-y-3 rounded-xl border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void (async () => {
          setBusy(true);
          setError('');
          try {
            if (!inventory.data || !target.data) throw new Error('Both groups must finish native policy setup first');
            const inputs: NativeAccountMapping[] = [];
            for (const accountId of accounts) {
              const account = wallet.accounts.find((a) => a.id === accountId)!;
              const targetAccountId =
                mappings[accountId] ??
                target.data.group.accounts.find((a) => a.derivationIndex === account.derivationIndex)?.id;
              if (!targetAccountId) throw new Error('Select a target account for every source account');
              const mapping: NativeAccountMapping = {
                sourceAccountId: accountId,
                targetAccountId,
                bitcoinCoins: [],
                changeCursor: 0,
                bitcoinMaxFee: bitcoinFee,
                hederaMaxFee: hederaFee,
              };
              for (const source of inventory.data.filter((i) => i.accountId === accountId)) {
                if (!target.data.inventory.some((i) => i.accountId === targetAccountId && i.chain === source.chain))
                  throw new Error('Every target policy needs all participant confirmations');
                if (source.chain === 'bitcoin') {
                  const funds = await discoverSharedBitcoin(bitcoinPolicy(source.policy));
                  mapping.changeCursor = funds.next;
                  mapping.bitcoinCoins = funds.allCoins
                    .filter((c) => c.confirmations > 0)
                    .map((c) => ({
                      txid: c.txid,
                      vout: c.vout,
                      value: c.value.toString(),
                      branch: c.branch,
                      index: c.addressIndex,
                    }));
                }
              }
              inputs.push(mapping);
            }
            await (await getApi()).createNativeMigration(wallet.id, targetId, inputs);
            await done();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <label className="block text-sm">
        Replacement group
        <select
          className={field}
          value={targetId}
          onChange={(e) => {
            setTarget(e.target.value);
            setMappings({});
          }}
        >
          <option value="">Select your prepared group</option>
          {wallets.data
            ?.filter((w) => w.id !== wallet.id && w.me.role === 'owner')
            .map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
        </select>
      </label>
      <p className="text-xs text-muted">
        A healthy member of the old group can own the replacement. Create it from All shared wallets, invite the
        intended members, then complete provisioning and native policy confirmations. Do not fund a separate Hedera
        account for the replacement.
      </p>
      {accounts.map((id) => {
        const account = wallet.accounts.find((a) => a.id === id)!;
        return (
          <label key={id} className="block text-sm">
            Destination account for {account.name}
            <select
              className={field}
              value={
                mappings[id] ??
                target.data?.group.accounts.find((a) => a.derivationIndex === account.derivationIndex)?.id ??
                ''
              }
              onChange={(e) => setMappings((v) => ({ ...v, [id]: e.target.value }))}
            >
              <option value="">Choose account</option>
              {target.data?.group.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      <label className="block text-sm">
        Bitcoin fee cap per sweep, in satoshis
        <input
          className={field}
          inputMode="numeric"
          value={bitcoinFee}
          onChange={(e) => setBitcoinFee(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Hedera fee cap per key update, in tinybars
        <input className={field} inputMode="numeric" value={hederaFee} onChange={(e) => setHederaFee(e.target.value)} />
      </label>
      <p className="text-xs text-muted">
        Preparation records the confirmed Bitcoin coins discovered now, including coins reserved by older signed
        payments. It does not sign or submit anything. Review that snapshot before confirming; an older conflicting
        payment may still confirm first.
      </p>
      <Button size="sm" type="submit" disabled={busy || !target.data || !inventory.data}>
        Prepare the migration review
      </Button>
      {(inventory.isError || target.isError) && (
        <p role="alert" className="text-sm text-danger">
          Finish both groups’ provisioning, native enrollment and policy confirmations, then retry. Archived policies
          need recovery review.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

function MigrationReview({
  wallet,
  view,
  refresh,
}: {
  wallet: SharedWallet;
  view: NativeMigrationView;
  refresh: () => Promise<unknown>;
}) {
  const m = view.migration,
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [compared, setCompared] = useState(false),
    [revise, setRevise] = useState(false);
  useEffect(() => {
    setCompared(false);
  }, [m.digest]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await verifyMigration(m);
      await action();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="space-y-3 rounded-xl border border-line p-3">
      <h3 className="font-semibold">
        Migration: {m.status}
        {m.reviewPending ? ' — revised review needs both quorums' : ''}
      </h3>
      <p className="text-sm">
        Old group: {m.manifest.sourceRoster.map((r) => r.name).join(', ')}. New group:{' '}
        {m.manifest.targetRoster.map((r) => r.name).join(', ')}.
      </p>
      <p className="break-all text-xs">Review safety number: {m.digest}</p>
      {m.monitoringWarning && (
        <p role="alert" className="text-sm text-danger">
          {m.monitoringWarning}
        </p>
      )}
      {!!m.reviewHistory?.length && (
        <details className="text-sm">
          <summary>Earlier migration reviews</summary>
          <p>Earlier signatures can still confirm. Keep their saved transaction evidence.</p>
          {m.reviewHistory.map((review) => (
            <div key={review.digest} className="my-2 break-all text-xs">
              <p>
                {new Date(review.at).toLocaleString()} · {review.digest}
              </p>
              {review.manifest.intents.map((i) => (
                <p key={i.id}>
                  {i.chain}: {i.chain === 'bitcoin' ? `${i.bitcoinCoins?.length ?? 0} nominated coins; ` : ''}fee cap {i.maxFee}{' '}
                  {i.chain === 'bitcoin' ? 'satoshis' : 'tinybars'}.
                </p>
              ))}
            </div>
          ))}
        </details>
      )}
      {!!m.attempts.length && (
        <details className="text-sm">
          <summary>Reviewed signing attempts</summary>
          <p>Registration is not proof of submission. Check chain results and saved transactions.</p>
          {m.attempts.map((attempt) => {
            const intent = m.manifest.intents.find((i) => i.id === attempt.intentId);
            if (!intent) return null;
            const link =
              intent.chain === 'bitcoin'
                ? `https://mempool.space/testnet4/tx/${encodeURIComponent(attempt.txid)}`
                : `https://hashscan.io/testnet/transaction/${encodeURIComponent(attempt.txid)}`;
            return (
              <p key={attempt.session} className="my-2 break-all text-xs">
                <a className="underline" href={link} target="_blank" rel="noreferrer">
                  {intent.chain}: {attempt.txid}
                </a>
                {attempt.archived ? ' · Earlier signing window; check saved transactions.' : ''}
              </p>
            );
          })}
        </details>
      )}

      {m.manifest.intents.map((i) => (
        <div key={i.id} className="space-y-1 rounded-lg bg-sunken p-2 text-sm">
          <p className="font-medium">{i.chain === 'bitcoin' ? 'Bitcoin Testnet4' : 'Hedera Testnet'}</p>
          <p className="break-all">New policy: {i.targetPolicyId}</p>
          {i.chain === 'bitcoin' ? (
            <>
              <p className="break-all">Destination: {i.destination}</p>
              <p>
                Nominated: {i.bitcoinCoins?.length ?? 0} coins,{' '}
                {formatUnits(
                  (i.bitcoinCoins ?? []).reduce((sum, c) => sum + BigInt(c.value), 0n),
                  8,
                )}{' '}
                BTC.
              </p>
              <details>
                <summary>Review nominated coins</summary>
                <ul className="break-all text-xs">
                  {i.bitcoinCoins?.map((c) => (
                    <li key={`${c.txid}:${c.vout}`}>
                      {c.txid}:{c.vout} — {c.value} sats — {c.branch === 0 ? 'receive' : 'change'} {c.index}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          ) : (
            <p>Account {i.hederaAccountId} keeps its number and HBAR balance.</p>
          )}
          <p>
            Fee cap per operation: {i.maxFee} {i.chain === 'bitcoin' ? 'satoshis' : 'tinybars'}.
          </p>
          <p>{m.progress.find((p) => p.intentId === i.id)?.detail ?? 'Awaiting signing and chain verification.'}</p>
        </div>
      ))}
      <p className="text-xs text-muted">
        Only the nominated Bitcoin coins are covered. Other coins and later deposits still need the old quorum. Previous
        signatures remain valid after a revised review. Keep both groups and backups; EVM balances stay under their
        existing group.
      </p>
      {m.monitoringWarning && (
        <p role="alert" className="text-sm text-danger">
          {m.monitoringWarning}
        </p>
      )}
      {(m.status === 'draft' || m.reviewPending) && (
        <>
          <label className="flex gap-2 text-sm">
            <input type="checkbox" checked={compared} onChange={(e) => setCompared(e.target.checked)} />I compared this
            safety number, roster, destinations, coins and fees with the participants.
          </label>
          {(['source', 'target'] as const).map((side) => {
            const participant = view.access[`${side}ParticipantId`],
              count = m.approvals.filter((a) => a.side === side).length,
              needed = side === 'source' ? m.manifest.requiredApprovals : m.manifest.requiredTargetApprovals;
            return (
              <div key={side} className="text-sm">
                {side === 'source' ? 'Old' : 'New'} group confirmations: {count} / {needed}.{' '}
                {participant && !m.approvals.some((a) => a.side === side && a.participantId === participant) && (
                  <Button
                    size="sm"
                    disabled={busy || !compared}
                    onClick={() =>
                      void run(async () => {
                        for (const i of m.manifest.intents) {
                          const p = side === 'source' ? i.sourcePolicy : i.targetPolicy;
                          if (i.chain === 'bitcoin') await vault.call('btcSharedStatus', { policy: bitcoinPolicy(p) });
                          else await vault.call('hSharedStatus', { policy: hederaPolicy(p) });
                        }
                        await (await getApi()).approveNativeMigration(view, side);
                      })
                    }
                  >
                    Confirm as an {side === 'source' ? 'old' : 'incoming'} participant
                  </Button>
                )}
              </div>
            );
          })}
        </>
      )}
      {m.status === 'draft' && view.access.sourceParticipantId && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void run(async () => (await getApi()).cancelNativeMigration(m.manifest.id))}
        >
          Cancel unsigned review
        </Button>
      )}
      {!['draft', 'cancelled', 'complete'].includes(m.status) && (
        <>
          <p className="text-sm font-medium">
            Ordinary native proposals are paused until every migration result is verified.
          </p>
          {!m.reviewPending &&
            m.manifest.intents.map((i) => (
              <MigrationSigning key={i.id} wallet={wallet} view={view} intent={i} run={run} busy={busy} />
            ))}
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void run(async () => (await getApi()).checkNativeMigration(m.manifest.id))}
          >
            Check chain results
          </Button>
          {view.access.sourceParticipantId && !m.reviewPending && (
            <Button className="ml-2" size="sm" variant="secondary" onClick={() => setRevise((v) => !v)}>
              Revise coin snapshot or fees
            </Button>
          )}
          {revise && <RevisedReview view={view} run={run} busy={busy} done={() => setRevise(false)} />}
        </>
      )}
      {m.status === 'complete' && (
        <p role="status" className="text-sm">
          The nominated migration is verified. Use the replacement group for native accounts. For Hedera, each new
          participant must link and confirm account{' '}
          {m.manifest.intents
            .filter((i) => i.chain === 'hedera')
            .map((i) => i.hederaAccountId)
            .join(', ')}{' '}
          in its normal setup. Preserve the old Bitcoin policy for remaining and later funds.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </article>
  );
}

function SignerSelection({
  policy,
  value,
  onChange,
  label,
}: {
  policy: NativePolicy;
  value: number[];
  onChange: (value: number[]) => void;
  label: string;
}) {
  return (
    <fieldset className="rounded-lg border border-line p-2">
      <legend className="text-sm">
        {label}: choose {policy.raccoonThreshold} Raccoon participants
      </legend>
      {policy.members.map((member) => (
        <label key={member.partyIndex} className="mr-3 inline-flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.includes(member.partyIndex)}
            onChange={(e) =>
              onChange(
                (e.target.checked ? [...value, member.partyIndex] : value.filter((i) => i !== member.partyIndex)).sort(
                  (a, b) => a - b,
                ),
              )
            }
          />
          Signer {member.partyIndex}
        </label>
      ))}
    </fieldset>
  );
}

function MigrationSigning({
  wallet,
  view,
  intent: i,
  run,
  busy,
}: {
  wallet: SharedWallet;
  view: NativeMigrationView;
  intent: NativeMigrationIntent;
  run: (action: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const m = view.migration,
    [oldSigners, setOld] = useState(
      i.sourcePolicy.members.slice(0, i.sourcePolicy.raccoonThreshold).map((p) => p.partyIndex),
    ),
    [newSigners, setNew] = useState(
      i.targetPolicy.members.slice(0, i.targetPolicy.raccoonThreshold).map((p) => p.partyIndex),
    );
  const attempts = m.attempts.filter((a) => a.intentId === i.id && !a.archived);
  return (
    <div className="space-y-2 rounded-xl border border-line p-3">
      <h4 className="font-semibold">{i.chain === 'bitcoin' ? 'Bitcoin sweep' : 'Hedera key update'}</h4>
      {view.access.sourceParticipantId && (
        <>
          <SignerSelection policy={i.sourcePolicy} value={oldSigners} onChange={setOld} label="Old group" />
          {i.chain === 'hedera' && (
            <SignerSelection policy={i.targetPolicy} value={newSigners} onChange={setNew} label="Incoming group" />
          )}
          <Button
            size="sm"
            disabled={
              busy ||
              oldSigners.length !== i.sourcePolicy.raccoonThreshold ||
              (i.chain === 'hedera' && newSigners.length !== i.targetPolicy.raccoonThreshold)
            }
            onClick={() =>
              void run(async () => {
                const api = await getApi();
                if (i.chain === 'bitcoin') {
                  const source = bitcoinPolicy(i.sourcePolicy),
                    target = bitcoinPolicy(i.targetPolicy),
                    funds = await discoverSharedBitcoin(source),
                    points = new Set(i.bitcoinCoins?.map((c) => `${c.txid}:${c.vout}`));
                  const coins = await hydrateSharedBitcoinCoins(
                    funds.allCoins
                      .filter((c) => points.has(`${c.txid}:${c.vout}`) && c.confirmations > 0)
                      .slice(0, 100),
                  );
                  if (!coins.length)
                    throw new Error(
                      'No nominated confirmed coins remain unspent. Check registered results; revise the review if an older payment changed the coins.',
                    );
                  const fees = await createBitcoinDataSource('testnet4').getFees();
                  const p = B.makeSharedBitcoinMigration(source, target, m.manifest.id, coins, fees.market, oldSigners);
                  if (BigInt(p.maxFee) > BigInt(i.maxFee))
                    throw new Error(
                      'The estimated fee exceeds the approved cap. Revise the review and obtain both quorums again.',
                    );
                  await api.registerNativeMigration(
                    m.manifest.id,
                    i.id,
                    B.validateSharedBitcoinProposal(source, p).id,
                    p,
                  );
                } else {
                  const pair = H.makeHederaKeyUpdate(
                    hederaPolicy(i.sourcePolicy),
                    hederaPolicy(i.targetPolicy),
                    i.hederaAccountId,
                    m.manifest.id,
                    oldSigners,
                    newSigners,
                    BigInt(i.maxFee),
                  );
                  await api.registerNativeMigration(
                    m.manifest.id,
                    i.id,
                    pair.source.transactionId,
                    pair.source,
                    pair.target,
                  );
                }
              })
            }
          >
            Prepare a reviewed signing attempt
          </Button>
          <p className="text-xs text-muted">
            Preparation does not sign or broadcast. Bitcoin sweeps use at most 100 nominated coins per transaction.
            Hedera approvals from both groups must finish within the displayed signing window.
          </p>
        </>
      )}
      {attempts.map((attempt) => (
        <MigrationAttemptReview
          key={attempt.session}
          wallet={wallet}
          view={view}
          intent={i}
          attempt={attempt}
          run={run}
          busy={busy}
        />
      ))}
    </div>
  );
}

function MigrationAttemptReview({
  wallet,
  view,
  intent,
  attempt,
  run,
  busy,
}: {
  wallet: SharedWallet;
  view: NativeMigrationView;
  intent: NativeMigrationIntent;
  attempt: NativeMigrationAttempt;
  run: (action: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const id = view.migration.manifest.id;
  return (
    <div className="space-y-2 border-t border-line pt-2">
      {(['source', 'target'] as const).map((side) => {
        const participant = view.access[`${side}ParticipantId`];
        if (!participant || (side === 'target' && intent.chain === 'bitcoin')) return null;
        const policy = side === 'source' ? intent.sourcePolicy : intent.targetPolicy,
          proposal = side === 'source' ? attempt.sourceProposal : attempt.targetProposal;
        const ownWallet = { ...wallet, id: policy.context.walletId, me: { ...wallet.me, id: participant } };
        const loadMessages = () => migrationMessages(id, intent.id, side, attempt.session, policy);
        const post = async (kind: string, session: string, value: unknown) => {
          const api = await getApi(),
            ctx = policy.context;
          if (intent.chain === 'bitcoin')
            await api.postBitcoinShared(
              ctx.walletId,
              ctx.accountId,
              ctx.keygenId,
              ctx.membershipVersion,
              kind,
              session,
              value,
            );
          else
            await api.postHederaShared(
              ctx.walletId,
              ctx.accountId,
              ctx.keygenId,
              ctx.membershipVersion,
              kind,
              session,
              value,
            );
        };
        return (
          <div key={side}>
            <p className="text-sm font-medium">{side === 'source' ? 'Old' : 'Incoming'} group signing</p>
            {intent.chain === 'bitcoin' ? (
              <BitcoinProposal
                wallet={ownWallet}
                policy={bitcoinPolicy(policy)}
                session={attempt.session}
                registeredProposal={proposal as B.SharedBitcoinProposal}
                loadMessages={loadMessages}
                post={post}
              />
            ) : (
              <HederaProposal
                wallet={ownWallet}
                policy={hederaPolicy(policy)}
                accountId={intent.hederaAccountId}
                session={attempt.session}
                registeredProposal={proposal as H.HederaProposal}
                loadMessages={loadMessages}
                post={post}
              />
            )}
          </div>
        );
      })}
      {intent.chain === 'hedera' && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const source = attempt.sourceProposal as H.HederaProposal,
                target = attempt.targetProposal as H.HederaProposal;
              const evidence = async (side: 'source' | 'target', policy: NativePolicy, p: H.HederaProposal) => {
                const messages = await migrationMessages(id, intent.id, side, attempt.session, policy);
                const rounds = (kind: string) =>
                  messages.filter((m) => m.kind === kind).map((m) => content<H.HederaRound>(m));
                const consents = messages
                  .filter((m) => m.kind === 'approve')
                  .map((m) => content<H.HederaConsent>(m))
                  .filter((c) => p.active.includes(c.from));
                return {
                  approval: H.combineHederaApproval(
                    hederaPolicy(policy),
                    p,
                    consents,
                    rounds('r1'),
                    rounds('r2'),
                    rounds('r3'),
                  ),
                  partials: messages.filter((m) => m.kind === 'partial').map((m) => content<H.HederaPartial>(m)),
                };
              };
              const [a, b] = await Promise.all([
                evidence('source', intent.sourcePolicy, source),
                evidence('target', intent.targetPolicy, target),
              ]);
              const policy = hederaPolicy(view.access.sourceParticipantId ? intent.sourcePolicy : intent.targetPolicy);
              const signed = await vault.call('hSharedFinalizeRotation', {
                policy,
                source,
                sourceApproval: a.approval,
                sourcePartials: a.partials,
                target,
                targetApproval: b.approval,
                targetPartials: b.partials,
              });
              const api = await getApi(),
                receipt = await api.hederaSharedReceipt(signed.transactionId);
              if (receipt.found) {
                if (receipt.result !== 'SUCCESS' || receipt.intentMemo !== signed.intentMemo)
                  throw new Error('Saved transaction is not a verified successful key update');
              } else await submitSharedHedera(signed);
              await vault.call('hSharedReconcile', {
                policy,
                id: source.id,
                account: await api.hederaAccountInfo(intent.hederaAccountId),
                receipt: await api.hederaSharedReceipt(signed.transactionId),
              });
              await api.checkNativeMigration(id);
            })
          }
        >
          Verify both quorums and submit this key update
        </Button>
      )}
    </div>
  );
}

function RevisedReview({
  view,
  run,
  busy,
  done,
}: {
  view: NativeMigrationView;
  run: (action: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
  done: () => void;
}) {
  const [fees, setFees] = useState<Record<string, string>>({}),
    [accepted, setAccepted] = useState(false);
  return (
    <div className="space-y-2 rounded-xl border border-line p-3">
      {view.migration.manifest.intents.map((i) => (
        <label key={i.id} className="block text-sm">
          {i.chain} fee cap
          <input
            className={field}
            value={fees[i.id] ?? i.maxFee}
            onChange={(e) => setFees((v) => ({ ...v, [i.id]: e.target.value }))}
          />
        </label>
      ))}
      <p className="text-sm">
        This replaces the Bitcoin nomination with the currently discovered confirmed coins. Coins omitted from the new
        snapshot stay with the old group. Previous signed attempts can still confirm. Both groups must review and
        confirm again; spending stays paused.
      </p>
      <label className="flex gap-2 text-sm">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />I understand the
        scope change and will compare the revised coin list with both groups.
      </label>
      <Button
        size="sm"
        disabled={busy || !accepted}
        onClick={() =>
          void run(async () => {
            const reviews: NativeMigrationReview[] = [];
            for (const i of view.migration.manifest.intents) {
              const review: NativeMigrationReview = { intentId: i.id, maxFee: fees[i.id] ?? i.maxFee };
              if (i.chain === 'bitcoin') {
                const funds = await discoverSharedBitcoin(bitcoinPolicy(i.sourcePolicy));
                review.bitcoinCoins = funds.allCoins
                  .filter((c) => c.confirmations > 0)
                  .map((c) => ({
                    txid: c.txid,
                    vout: c.vout,
                    value: c.value.toString(),
                    branch: c.branch,
                    index: c.addressIndex,
                  }));
              }
              reviews.push(review);
            }
            await (await getApi()).reviewNativeMigration(view.migration.manifest.id, reviews);
            done();
          })
        }
      >
        Prepare the revised review
      </Button>
    </div>
  );
}
