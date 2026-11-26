'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as H from '@qd/hedera';
import { bytesToHex, type PolicyBackup } from '@qd/wallet-core';
import { formatUnits, parseUnits } from '@qd/blockchain';
import type { SharedWallet } from '@qd/rpc';
import { vault } from '@/lib/vault-client';
import { getApi } from '@/lib/api';
import { useMeta } from '@/lib/store';
import { hederaContent as content, readHederaMessages, submitSharedHedera } from '@/lib/hedera-shared-client';
import type { HederaRecord, HederaState } from '@/lib/hedera-worker';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/identity';

const field = 'mt-1 block w-full rounded-xl border border-line bg-surface p-2';
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Hedera action failed');
type Post = (kind: string, session: string, value: unknown) => Promise<void>;
type Props = { wallet: SharedWallet; policy: H.HederaSharedPolicy; post: Post };
const accountLink = (id: string) => `https://hashscan.io/testnet/account/${encodeURIComponent(id)}`;
const transactionLink = (id: string) => `https://hashscan.io/testnet/transaction/${encodeURIComponent(id)}`;

export function HederaShared({
  wallet,
  spendingPaused = false,
  view = 'all',
}: {
  wallet: SharedWallet;
  spendingPaused?: boolean;
  view?: 'all' | 'wallet' | 'payments' | 'activity';
}) {
  const [accountId, setAccountId] = useState(wallet.accounts[0]?.id ?? ''),
    [password, setPassword] = useState(''),
    [compared, setCompared] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<PolicyBackup>(),
    [backupPassword, setBackupPassword] = useState('');
  const qc = useQueryClient(),
    account = wallet.accounts.find((a) => a.id === accountId),
    keygen = wallet.key.keyGenerationId;
  useEffect(() => {
    if (!wallet.accounts.some((a) => a.id === accountId)) setAccountId(wallet.accounts[0]?.id ?? '');
  }, [accountId, wallet.accounts]);
  const scope = ['hedera-shared', wallet.id, accountId, keygen, wallet.policy.membershipVersion];
  const ready = !!account && !!keygen && wallet.key.status === 'initialized' && wallet.me.status === 'active';
  const messages = useQuery({
    queryKey: [...scope, 'setup'],
    enabled: ready,
    refetchInterval: 3000,
    queryFn: () => readHederaMessages(wallet.id, accountId),
  });
  const policy = useMemo(() => {
    try {
      const entries = messages.data?.filter((m) => m.kind === 'enrollment');
      if (!entries || entries.length !== wallet.participants.filter((p) => p.status === 'active').length) return;
      return H.createHederaPolicy(
        entries.map((m) => {
          const e = content<H.HederaEnrollment>(m);
          if (
            e.participantId !== m.from ||
            e.walletId !== wallet.id ||
            e.accountId !== accountId ||
            e.keygenId !== keygen ||
            e.membershipVersion !== wallet.policy.membershipVersion ||
            !wallet.participants.some((p) => p.id === m.from && p.status === 'active')
          )
            throw new Error('Unrecognized Hedera participant');
          return e;
        }),
      );
    } catch {
      return;
    }
  }, [messages.data, wallet.id, accountId, keygen, wallet.policy.membershipVersion, wallet.participants]);
  const id = policy ? H.hederaPolicyId(policy) : '';
  const confirmations = new Set(
    messages.data
      ?.filter((m) => m.kind === 'policy' && content<{ policyId: string }>(m).policyId === id)
      .map((m) => m.from),
  );
  const pinned = confirmations.has(wallet.me.id),
    allPinned = !!policy && confirmations.size === policy.members.length;
  const post: Post = async (kind, session, value) => {
    await (
      await getApi()
    ).postHederaShared(wallet.id, accountId, keygen!, wallet.policy.membershipVersion, kind, session, value);
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await qc.invalidateQueries({ queryKey: scope });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      id="sw-hedera"
      className="mb-4 rounded-2xl border border-primary/30 bg-surface p-4"
      aria-label="Shared Hedera"
    >
      <h2 className="mb-2 text-lg font-semibold">Shared Hedera</h2>
      {spendingPaused && (
        <p role="status" className="mb-2 text-sm">
          Payments are paused while your group changes.{' '}
          <a href="#sw-setup" className="font-medium text-primary underline">
            Open wallet migration
          </a>{' '}
          to continue.
        </p>
      )}
      <p className="mb-3 text-sm text-muted">Hedera Testnet · Use test HBAR on this network.</p>
      {!ready ? (
        <p className="text-sm text-muted">
          Finish shared wallet setup first, with at least two approvals required.{' '}
          <a href="#sw-setup" className="font-medium text-primary underline">
            Open wallet setup
          </a>
        </p>
      ) : (
        <>
          <label
            hidden={wallet.accounts.length < 2}
            className={wallet.accounts.length < 2 ? 'hidden' : 'my-2 block text-sm'}
          >
            Hedera shared account
            <select
              className={field}
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                setCompared(false);
              }}
            >
              {wallet.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <details open={!allPinned} className="my-3 rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-sm font-medium">Unlock & Hedera setup</summary>
            <p className="my-2 text-xs text-muted">
              Each signer checks Raccoon approval and provides a native Hedera signature. Native signatures remain
              conventional.
            </p>
            <label className="my-2 block text-sm">
              Unlock Hedera key shares
              <input
                className={field}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !password}
              onClick={() =>
                void run(async () => {
                  const value = password;
                  setPassword('');
                  await vault.call('qdShareUnlock', { password: value });
                })
              }
            >
              Unlock Hedera shares
            </Button>
            {!messages.data?.some((m) => m.kind === 'enrollment' && m.from === wallet.me.id) && (
              <Button
                className="ml-2"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const enrollment = await vault.call('hSharedEnroll', {
                      context: {
                        walletId: wallet.id,
                        accountId,
                        keygenId: keygen!,
                        membershipVersion: wallet.policy.membershipVersion,
                        network: 'testnet',
                      },
                      participantId: wallet.me.id,
                      derivationIndex: account!.derivationIndex,
                    });
                    await post('enrollment', 'enrollment', enrollment);
                  })
                }
              >
                Register my Hedera key
              </Button>
            )}
            <p className="mt-2 text-sm text-muted">
              Hedera keys registered: {messages.data?.filter((m) => m.kind === 'enrollment').length ?? 0} /{' '}
              {wallet.policy.activeParticipants}
            </p>
            {policy && (
              <>
                <p className="mt-3 text-sm">
                  Native quorum: {policy.nativeThreshold} of {policy.members.length}. Raccoon quorum:{' '}
                  {policy.raccoonThreshold} of {policy.members.length}.
                </p>
                <p className="mt-2 text-xs font-semibold">Hedera policy safety number</p>
                <p className="break-all font-mono text-xs" aria-label="Hedera policy safety number">
                  {id}
                </p>
                <CopyButton value={id} />
                {!pinned && (
                  <>
                    <label className="my-2 flex gap-2 text-sm">
                      <input type="checkbox" checked={compared} onChange={(e) => setCompared(e.target.checked)} />I
                      compared the Hedera safety number with every participant.
                    </label>
                    <Button
                      size="sm"
                      disabled={!compared || busy || messages.isError}
                      onClick={() =>
                        void run(async () => {
                          const confirmation = await vault.call('issueConfirmation', {
                            payload: {
                              kind: 'hedera-shared',
                              policyId: id,
                              message: id,
                            },
                          });
                          await vault.call('hSharedPin', {
                            policy,
                            confirmation,
                          });
                          await post('policy', 'enrollment', { policyId: id });
                          await qc.invalidateQueries({
                            queryKey: ['shared-wallet', wallet.id],
                          });
                        })
                      }
                    >
                      Confirm Hedera policy
                    </Button>
                  </>
                )}
                <p className="mt-2 text-sm text-muted">
                  Hedera policy confirmations: {confirmations.size} / {policy.members.length}
                </p>
              </>
            )}
          </details>
          {policy && allPinned && (
            <HederaAccount
              key={id}
              wallet={wallet}
              policy={policy}
              post={post}
              spendingPaused={spendingPaused}
              view={view}
            />
          )}
          <details className="mt-4 text-sm">
            <summary>Restore an encrypted Hedera share backup</summary>
            <p className="my-2 text-muted">
              Use the matching recovery phrase and an authorized participant device. Enter the password used when this
              backup was exported. Import preserves pending native transactions and starts future Raccoon sessions with
              fresh randomness.
            </p>
            <label className="block">
              Encrypted Hedera backup
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
                    setError(errorText(error));
                  }
                }}
              />
            </label>
            <label className="my-2 block">
              Hedera backup password
              <input
                className={field}
                type="password"
                autoComplete="off"
                value={backupPassword}
                onChange={(e) => setBackupPassword(e.target.value)}
              />
            </label>
            <Button
              size="sm"
              disabled={busy || !backup || !backupPassword}
              onClick={() =>
                void run(async () => {
                  const pw = backupPassword;
                  setBackupPassword('');
                  const restored = await vault.call('hSharedImport', {
                    backup: backup!,
                    password: pw,
                  });
                  if (restored.policy.context.walletId !== wallet.id || restored.policy.context.accountId !== accountId)
                    throw new Error(
                      'Backup restored locally for a different shared account. Select that account to continue.',
                    );
                  setBackup(undefined);
                })
              }
            >
              Restore Hedera share backup
            </Button>
          </details>
        </>
      )}
      {(messages.isError || error) && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error || 'Hedera setup messages are unavailable or invalid.'}
        </p>
      )}
    </section>
  );
}

function HederaAccount({
  wallet,
  policy,
  post,
  spendingPaused = false,
  view = 'all',
}: Props & {
  spendingPaused?: boolean;
  view?: 'all' | 'wallet' | 'payments' | 'activity';
}) {
  const id = H.hederaPolicyId(policy),
    qc = useQueryClient(),
    scope = [
      'hedera-shared',
      wallet.id,
      policy.context.accountId,
      policy.context.keygenId,
      policy.context.membershipVersion,
    ];
  const [candidate, setCandidate] = useState(''),
    [payerIndex, setPayerIndex] = useState(''),
    [creation, setCreation] = useState<H.HederaPlan>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState('');
  const personalIds = useMeta((s) => s.hederaAccountIds),
    personalAccounts = useMeta((s) => s.accounts);
  const setup = useQuery({
    queryKey: [...scope, 'setup'],
    queryFn: () => readHederaMessages(wallet.id, policy.context.accountId),
    refetchInterval: 3000,
  });
  const saved = useQuery({
    queryKey: [...scope, 'local'],
    queryFn: () => vault.call('hSharedStatus', { policy }),
    refetchInterval: 5000,
  });
  const candidates = [
    ...new Set(setup.data?.filter((m) => m.kind === 'link').map((m) => content<{ accountId: string }>(m).accountId)),
  ];
  useEffect(() => {
    const known = Object.values(saved.data?.records ?? {}).find(
      (r) => r.plan.kind === 'create' && r.status === 'confirmed' && r.createdAccountId,
    );
    if (!candidate && known?.createdAccountId) setCandidate(known.createdAccountId);
  }, [saved.data, candidate]);
  const linked = saved.data?.accountId;
  const account = useQuery({
    queryKey: [...scope, 'balance', linked],
    enabled: !!linked,
    queryFn: async () => {
      const value = await (await getApi()).hederaAccountInfo(linked!);
      H.verifyHederaAccount(policy, value, linked);
      return value;
    },
    refetchInterval: 10000,
  });
  const confirmations = linked
    ? new Set(
        setup.data
          ?.filter(
            (m) =>
              m.kind === 'binding' &&
              content<{ policyId: string; accountId: string }>(m).policyId === id &&
              content<{ accountId: string }>(m).accountId === linked,
          )
          .map((m) => m.from),
      ).size
    : 0;
  const allBound = !!linked && confirmations === policy.members.length;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await action();
      await qc.invalidateQueries({ queryKey: scope });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const shareAccount = async (accountId: string) => {
    H.verifyHederaAccount(policy, await (await getApi()).hederaAccountInfo(accountId), accountId);
    await post('link', 'enrollment', { accountId });
    setCandidate(accountId);
  };
  const reconcile = async (record: HederaRecord) => {
    const api = await getApi(),
      receipt = await api.hederaSharedReceipt(record.plan.transactionId);
    const info = await api.hederaAccountInfo(record.plan.from);
    await vault.call('hSharedReconcile', {
      policy,
      id: record.plan.id,
      account: info,
      receipt,
    });
    if (
      record.plan.kind === 'create' &&
      receipt.found &&
      receipt.result === 'SUCCESS' &&
      receipt.intentMemo === H.hederaNativeIntent(record.plan) &&
      receipt.entityId
    )
      await shareAccount(receipt.entityId);
    setNote(
      receipt.found
        ? receipt.intentMemo !== H.hederaNativeIntent(record.plan)
          ? 'Another operation used this transaction ID. This reviewed operation is not confirmed.'
          : `Network result: ${receipt.result}`
        : 'Not yet visible. The saved transaction has not been replaced.',
    );
  };
  const pending = saved.data ? Object.values(saved.data.records).filter((r) => r.status === 'pending') : [];
  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-muted">
        Keep participant membership fixed while membership migration is pending. Back up every participant’s encrypted
        share as well as their recovery phrase. A phrase alone cannot recreate Raccoon shares.
      </p>
      {!allBound && (
        <>
          <label className="block text-sm">
            Existing shared Hedera account ID
            <input
              className={field}
              placeholder="0.0.…"
              value={candidate}
              onChange={(e) => setCandidate(e.target.value)}
            />
          </label>
          <Button
            size="sm"
            disabled={spendingPaused || busy || !candidate}
            onClick={() => void run(() => shareAccount(H.hederaAccountId(candidate.trim())))}
          >
            Verify and share Hedera account
          </Button>
          {candidates.map((accountId) => (
            <div className="rounded-xl border border-line p-3" key={accountId}>
              <p className="text-sm">Proposed Hedera account: {accountId}</p>
              <Button
                size="sm"
                disabled={spendingPaused || busy}
                onClick={() =>
                  void run(async () => {
                    const info = await (await getApi()).hederaAccountInfo(accountId),
                      confirmation = await vault.call('issueConfirmation', {
                        payload: {
                          kind: 'hedera-shared',
                          policyId: id,
                          message: `bind:${accountId}`,
                        },
                      });
                    await vault.call('hSharedBind', {
                      policy,
                      account: info,
                      confirmation,
                    });
                    await post('binding', 'enrollment', {
                      policyId: id,
                      accountId,
                    });
                  })
                }
              >
                Verify and confirm Hedera account
              </Button>
            </div>
          ))}
          {wallet.me.role === 'owner' && (
            <details>
              <summary className="text-sm">Create a new native threshold account</summary>
              <p className="my-2 text-sm text-muted">
                An existing funded personal Hedera account pays the creation fee. Its private key stays in the key
                worker. The new account starts with zero HBAR.
              </p>
              <label className="block text-sm">
                Hedera creation payer
                <select
                  className={field}
                  value={payerIndex}
                  onChange={(e) => {
                    setPayerIndex(e.target.value);
                    setCreation(undefined);
                  }}
                >
                  <option value="">Select a linked personal Hedera account</option>
                  {Object.entries(personalIds).map(([index, accountId]) => (
                    <option key={index} value={index}>
                      {personalAccounts.find((a) => a.index === Number(index))?.name ?? `Personal account ${index}`} ·{' '}
                      {accountId}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                className="mt-2"
                size="sm"
                disabled={spendingPaused || busy || payerIndex === '' || pending.some((r) => r.plan.kind === 'create')}
                onClick={() =>
                  void run(async () => {
                    const from = personalIds[Number(payerIndex)];
                    if (!from) throw new Error('Select a linked personal account');
                    setCreation(H.makeHederaCreation(policy, from));
                  })
                }
              >
                Review Hedera account creation
              </Button>
              {creation && (
                <div aria-label="Hedera creation review" className="my-2 rounded-xl border border-line p-3">
                  <p className="text-sm">Fee payer: {creation.from}</p>
                  <p className="text-sm">
                    New account: {policy.nativeThreshold}-of-
                    {policy.members.length} native threshold. Initial balance: 0 HBAR.
                  </p>
                  <p className="text-sm">Maximum network fee: {formatUnits(BigInt(creation.maxFee), 8)} HBAR.</p>
                  <Button
                    size="sm"
                    disabled={spendingPaused || busy}
                    onClick={() =>
                      void run(async () => {
                        const payer = await (await getApi()).hederaAccountInfo(creation.from),
                          message = H.hederaPlanMessage(policy, creation),
                          confirmation = await vault.call('issueConfirmation', {
                            payload: {
                              kind: 'hedera-shared',
                              policyId: id,
                              message,
                            },
                          });
                        const signed = await vault.call('hSharedCreate', {
                          policy,
                          plan: creation,
                          payerIndex: Number(payerIndex),
                          payer,
                          confirmation,
                        });
                        await qc.invalidateQueries({ queryKey: scope });
                        const receipt = await submitSharedHedera(signed);
                        if (!receipt.accountId) throw new Error('Creation receipt did not include an account ID');
                        setCandidate(receipt.accountId);
                        setNote(
                          `Created ${receipt.accountId}. Verify and share it once the mirror has indexed the key.`,
                        );
                        setCreation(undefined);
                      })
                    }
                  >
                    Sign and submit Hedera account creation
                  </Button>
                </div>
              )}
            </details>
          )}
        </>
      )}
      <p className="text-sm text-muted">
        Hedera account confirmations: {confirmations} / {policy.members.length}
      </p>
      {allBound && (
        <>
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">Recovery notes</summary>
            <p className="my-2 text-muted">
              Changing participants requires the migration in Wallet setup. Keep each participant’s encrypted share
              backup as well as their recovery phrase.
            </p>
          </details>
          <div hidden={view !== 'all' && view !== 'wallet'} className="rounded-xl bg-sunken p-3">
            <p className="text-sm font-semibold">Shared Hedera receive account</p>
            <p aria-label="Shared Hedera receive account" className="font-mono">
              {linked}
            </p>
            <CopyButton value={linked} />
            <a className="ml-2 text-sm underline" href={accountLink(linked)} target="_blank" rel="noreferrer">
              View account on HashScan
            </a>
          </div>
          <p className="text-sm">
            Shared balance: {account.data ? `${formatUnits(BigInt(account.data.tinybars), 8)} HBAR` : 'Checking…'}
          </p>
          {account.isError && (
            <p role="status" className="text-sm text-danger">
              Account verification or balance retrieval failed. Funds are not reported as zero.
            </p>
          )}
          <div hidden={view === 'wallet' || view === 'activity'}>
            {!spendingPaused && (
              <HederaPayments wallet={wallet} policy={policy} post={post} accountId={linked} saved={saved.data} />
            )}
          </div>
          <div hidden={view !== 'all' && view !== 'activity'}>
            <HederaHistory policy={policy} accountId={linked} />
          </div>
        </>
      )}
      <details className="my-3 rounded-xl border border-line p-3">
        <summary className="mb-2 cursor-pointer text-sm font-medium">Back up your share</summary>
        <Button
          size="sm"
          variant="secondary"
          disabled={spendingPaused || busy}
          onClick={() =>
            void run(async () => {
              const data = await vault.call('hSharedExport', { policy }),
                url = URL.createObjectURL(
                  new Blob([JSON.stringify(data)], {
                    type: 'application/json',
                  }),
                ),
                anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = `qd-hedera-share-${id.slice(0, 12)}.json`;
              anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            })
          }
        >
          Export encrypted Hedera share backup
        </Button>
      </details>
      {!!pending.length && (
        <div aria-label="Saved Hedera transactions" className="space-y-2">
          <h3 className="text-sm font-semibold">Saved Hedera transactions</h3>
          {pending.map((record) => (
            <div key={record.plan.id} className="rounded-xl border border-line p-3 text-sm">
              <p>{record.plan.kind === 'create' ? 'Account creation' : 'HBAR payment'}</p>
              <a
                className="break-all underline"
                target="_blank"
                rel="noreferrer"
                href={transactionLink(record.plan.transactionId)}
              >
                {record.plan.transactionId}
              </a>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={spendingPaused || busy}
                  onClick={() => void run(() => reconcile(record))}
                >
                  Check saved Hedera result
                </Button>
                {record.raw && Date.now() < record.plan.expiresAt && (
                  <Button
                    size="sm"
                    disabled={spendingPaused || busy}
                    onClick={() =>
                      void run(async () => {
                        const receipt = await (await getApi()).hederaSharedReceipt(record.plan.transactionId);
                        if (receipt.found) {
                          await reconcile(record);
                          return;
                        }
                        await submitSharedHedera({
                          raw: record.raw!,
                          transactionId: record.plan.transactionId,
                          expiresAt: record.plan.expiresAt,
                          intentMemo: H.hederaNativeIntent(record.plan),
                        });
                        await reconcile(record);
                      })
                    }
                  >
                    Retry identical Hedera transaction
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {note && (
        <p role="status" className="text-sm">
          {note}
        </p>
      )}
      {(error || setup.isError || saved.isError) && (
        <p role="alert" className="text-sm text-danger">
          {error || 'Shared Hedera state is unavailable. Unlock shares and retry.'}
        </p>
      )}
    </div>
  );
}

function HederaPayments({
  wallet,
  policy,
  post,
  accountId,
  saved,
}: Props & { accountId: string; saved?: HederaState }) {
  const [to, setTo] = useState(''),
    [amount, setAmount] = useState(''),
    [fee, setFee] = useState('1'),
    [session, setSession] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<number[]>(
      policy.members.slice(0, policy.raccoonThreshold).map((m) => m.partyIndex),
    );
  const qc = useQueryClient(),
    scope = [
      'hedera-shared',
      wallet.id,
      policy.context.accountId,
      policy.context.keygenId,
      policy.context.membershipVersion,
    ];
  const recent = useQuery({
    queryKey: [...scope, 'recent'],
    queryFn: () => readHederaMessages(wallet.id, policy.context.accountId, 'recent'),
    refetchInterval: 2000,
  });
  const held = Object.values(saved?.records ?? {})
    .filter((r) => r.status === 'pending' && r.plan.kind === 'transfer')
    .reduce((sum, r) => sum + BigInt(r.plan.amount) + BigInt(r.plan.maxFee), 0n);
  return (
    <div className="rounded-xl border border-line p-3" aria-label="Shared Hedera payments">
      <p className="text-sm text-muted">
        Reserved for pending local approvals: {formatUnits(held, 8)} HBAR. Payments expire after about two minutes, so
        selected signers must be online.
      </p>
      <form
        className="my-3 space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const info = await (await getApi()).hederaAccountInfo(accountId);
            H.verifyHederaAccount(policy, info, accountId);
            const value = parseUnits(amount, 8),
              maxFee = parseUnits(fee, 8);
            if (value + maxFee + held > BigInt(info.tinybars))
              throw new Error('Insufficient balance after pending reservations and the maximum fee');
            const recipientInfo = await (await getApi()).hederaAccountInfo(H.hederaAccountId(to.trim()));
            if (recipientInfo.deleted || recipientInfo.receiverSignatureRequired)
              throw new Error('Recipient is deleted or requires an additional receiver signature');
            const proposal = H.makeHederaProposal(
              policy,
              accountId,
              H.hederaAccountId(to.trim()),
              value,
              maxFee,
              [...selected].sort((a, b) => a - b),
            );
            await post('proposal', proposal.id, proposal);
            setSession(proposal.id);
            await qc.invalidateQueries({ queryKey: scope });
          } catch (error) {
            setError(errorText(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block text-sm">
          Hedera recipient
          <input className={field} value={to} onChange={(e) => setTo(e.target.value)} placeholder="0.0.…" />
        </label>
        <label className="block text-sm">
          Amount in HBAR
          <input className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block text-sm">
          Maximum Hedera network fee
          <input className={field} inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
        </label>
        <p className="text-xs text-muted">
          This is a maximum fee cap, not an estimate of the final charge. The network decides the actual fee.
        </p>
        <fieldset>
          <legend className="text-sm">Raccoon signers — select {policy.raccoonThreshold}</legend>
          {policy.members.map((member) => (
            <label className="my-1 flex gap-2 text-sm" key={member.participantId}>
              <input
                type="checkbox"
                checked={selected.includes(member.partyIndex)}
                onChange={(e) =>
                  setSelected((values) =>
                    e.target.checked ? [...values, member.partyIndex] : values.filter((i) => i !== member.partyIndex),
                  )
                }
              />
              {wallet.participants.find((p) => p.id === member.participantId)?.displayName ??
                `Participant ${member.partyIndex}`}
            </label>
          ))}
        </fieldset>
        <Button
          type="submit"
          size="sm"
          disabled={busy || selected.length !== policy.raccoonThreshold || !to || !amount}
        >
          Prepare Hedera payment
        </Button>
      </form>
      <label className="block text-sm">
        Hedera proposal
        <select className={field} value={session} onChange={(e) => setSession(e.target.value)}>
          <option value="">Select a payment</option>
          {recent.data?.map((m) => (
            <option key={m.id} value={m.session}>
              {m.session.slice(0, 8)} · {formatUnits(BigInt(content<H.HederaProposal>(m).amount), 8)} HBAR
            </option>
          ))}
        </select>
      </label>
      {session && (
        <HederaProposal
          key={session}
          wallet={wallet}
          policy={policy}
          post={post}
          session={session}
          accountId={accountId}
        />
      )}
      {(error || recent.isError) && (
        <p role="alert" className="text-sm text-danger">
          {error || 'Hedera proposals are unavailable or invalid.'}
        </p>
      )}
    </div>
  );
}

function HederaHistory({ policy, accountId }: { policy: H.HederaSharedPolicy; accountId: string }) {
  const [cursor, setCursor] = useState<string>(),
    [older, setOlder] = useState<
      Awaited<ReturnType<Awaited<ReturnType<typeof getApi>>['hederaSharedHistory']>>['items']
    >([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ['hedera-history', H.hederaPolicyId(policy), accountId],
    queryFn: async () => {
      const api = await getApi();
      H.verifyHederaAccount(policy, await api.hederaAccountInfo(accountId), accountId);
      return api.hederaSharedHistory(accountId);
    },
    refetchInterval: 15000,
  });
  const items = [
    ...new Map(
      [...(query.data?.items ?? []), ...older].map((item) => [`${item.transactionId}|${item.timestamp}`, item]),
    ).values(),
  ];
  return (
    <div aria-label="Shared Hedera history">
      <h3 className="text-sm font-semibold">Hedera transaction history</h3>
      {query.isError ? (
        <p role="status" className="text-sm text-danger">
          History could not be retrieved.
        </p>
      ) : !items.length ? (
        <p className="text-sm text-muted">{query.isPending ? 'Loading history…' : 'No HBAR transfers found.'}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li
              key={`${item.transactionId}|${item.timestamp}`}
              className="my-2 rounded-xl border border-line p-2 text-sm"
            >
              <a target="_blank" rel="noreferrer" className="underline" href={transactionLink(item.transactionId)}>
                {item.direction === 'in' ? 'Received' : item.direction === 'out' ? 'Sent' : 'Self transfer'}{' '}
                {formatUnits(BigInt(item.amountTinybars), 8)} HBAR
              </a>
              <p>
                {item.status} · fee {formatUnits(BigInt(item.feeTinybars), 8)} HBAR
              </p>
            </li>
          ))}
        </ul>
      )}
      {(cursor ?? query.data?.nextCursor) && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const page = await (
                await getApi()
              ).hederaSharedHistory(accountId, cursor ?? query.data?.nextCursor ?? undefined);
              setOlder((items) => [...items, ...page.items]);
              setCursor(page.nextCursor ?? '');
            } catch (error) {
              setError(errorText(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          Load older Hedera transfers
        </Button>
      )}
      {error && (
        <p role="status" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function HederaProposal({
  wallet,
  policy,
  post,
  session,
  accountId,
  registeredProposal,
  loadMessages,
}: Props & {
  session: string;
  accountId: string;
  registeredProposal?: H.HederaProposal;
  loadMessages?: () => Promise<import('@/lib/hedera-shared-client').HederaRelayMessage[]>;
}) {
  const qc = useQueryClient(),
    working = useRef(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState('');
  const scope = [
    'hedera-shared',
    wallet.id,
    policy.context.accountId,
    policy.context.keygenId,
    policy.context.membershipVersion,
  ];
  const messages = useQuery({
    queryKey: [...scope, session],
    refetchInterval: 1000,
    queryFn: async () => {
      const data = await (loadMessages
        ? loadMessages()
        : readHederaMessages(wallet.id, policy.context.accountId, session));
      for (const message of data.filter((m) => ['approve', 'r1', 'r2', 'r3', 'partial'].includes(m.kind))) {
        const member = policy.members.find((m) => m.participantId === message.from),
          value = content<{ from: number }>(message);
        if (!member || value.from !== member.partyIndex) throw new Error('Hedera signing message author mismatch');
      }
      return data;
    },
  });
  const entry = messages.data?.find((m) => m.kind === 'proposal'),
    proposal = registeredProposal ?? (entry ? content<H.HederaProposal>(entry) : undefined);
  const own = (kind: string) => messages.data?.some((m) => m.kind === kind && m.from === wallet.me.id) ?? false;
  const mine = policy.members.find((m) => m.participantId === wallet.me.id),
    approved = own('approve');
  const rounds = (kind: string) =>
    messages.data?.filter((m) => m.kind === kind).map((m) => content<H.HederaRound>(m)) ?? [];
  const consents = proposal
    ? (messages.data
        ?.filter((m) => m.kind === 'approve')
        .map((m) => content<H.HederaConsent>(m))
        .filter((c) => proposal.active.includes(c.from)) ?? [])
    : [];
  const advance = async () => {
    if (
      working.current ||
      !proposal ||
      !approved ||
      !mine ||
      error ||
      messages.isError ||
      consents.length !== policy.raccoonThreshold
    )
      return;
    working.current = true;
    try {
      if (proposal.active.includes(mine.partyIndex))
        for (const round of [1, 2, 3] as const) {
          if (own(`r${round}`)) continue;
          const inputs = round === 1 ? [] : rounds(`r${round - 1}`);
          if (round > 1 && inputs.length !== policy.raccoonThreshold) return;
          const result = await vault.call('hSharedRound', {
            policy,
            proposal,
            consents,
            round,
            inputs,
          });
          await post(`r${round}`, session, result);
          await qc.invalidateQueries({ queryKey: scope });
          return;
        }
      if (!own('partial') && rounds('r3').length === policy.raccoonThreshold) {
        const approval = H.combineHederaApproval(policy, proposal, consents, rounds('r1'), rounds('r2'), rounds('r3')),
          account = await (await getApi()).hederaAccountInfo(accountId);
        const result = await vault.call('hSharedNative', {
          policy,
          proposal,
          approval,
          account,
        });
        await post('partial', session, result);
        await qc.invalidateQueries({ queryKey: scope });
      }
    } catch (error) {
      setError(errorText(error));
    } finally {
      working.current = false;
    }
  };
  useEffect(() => {
    void advance();
  }, [messages.data, approved]);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (messages.isError)
    return (
      <p role="alert" className="text-sm text-danger">
        Hedera signing messages are invalid or unavailable.
      </p>
    );
  if (!proposal) return <p className="text-sm">Loading Hedera proposal…</p>;
  try {
    H.validateHederaProposal(policy, proposal, clock);
    if (proposal.from !== accountId) throw new Error('Wrong sender');
  } catch {
    return (
      <p role="status" className="my-2 text-sm text-danger">
        This Hedera proposal is invalid or expired. Check saved transaction results before creating another payment.
      </p>
    );
  }
  const signatures = messages.data?.filter((m) => m.kind === 'partial').map((m) => content<H.HederaPartial>(m)) ?? [];
  return (
    <div className="my-3 space-y-2 rounded-xl border border-line p-3" aria-label="Hedera payment review">
      <h3 className="font-semibold">
        {proposal.kind === 'keyUpdate' ? 'Review Hedera membership key update' : 'Review shared HBAR payment'}
      </h3>
      <p className="text-sm">From: {proposal.from}</p>
      {proposal.kind === 'keyUpdate' ? (
        <p className="break-all text-sm">New policy: {H.hederaPolicyId(proposal.targetPolicy!)}</p>
      ) : (
        <p className="text-sm">Recipient: {proposal.to}</p>
      )}
      <p className="text-sm">Payment: {formatUnits(BigInt(proposal.amount), 8)} HBAR</p>
      <p className="text-sm">Maximum fee: {formatUnits(BigInt(proposal.maxFee), 8)} HBAR</p>
      <p className="text-sm text-muted">
        Signing window: {Math.max(0, Math.floor((proposal.expiresAt - clock) / 1000))} seconds remaining.
      </p>
      {!approved && (
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const account = await (await getApi()).hederaAccountInfo(accountId),
                message = bytesToHex(H.hederaSharedMessage(policy, proposal)),
                confirmation = await vault.call('issueConfirmation', {
                  payload: {
                    kind: 'hedera-shared',
                    policyId: H.hederaPolicyId(policy),
                    message,
                  },
                });
              const consent = await vault.call('hSharedApprove', {
                policy,
                proposal,
                account,
                confirmation,
              });
              await post('approve', session, { ...consent, message });
              await qc.invalidateQueries({ queryKey: scope });
            } catch (error) {
              setError(errorText(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {proposal.kind === 'keyUpdate' ? 'Approve and sign this key update' : 'Approve and sign shared HBAR payment'}
        </Button>
      )}
      <p className="text-sm">
        Raccoon responses: {rounds('r3').length} / {policy.raccoonThreshold}. Native Hedera signatures:{' '}
        {signatures.length} / {policy.nativeThreshold}.
      </p>
      {approved && proposal.kind !== 'keyUpdate' && (
        <Button
          size="sm"
          disabled={busy || signatures.length < policy.nativeThreshold}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const approval = H.combineHederaApproval(
                policy,
                proposal,
                consents,
                rounds('r1'),
                rounds('r2'),
                rounds('r3'),
              );
              const api = await getApi(),
                account = await api.hederaAccountInfo(accountId);
              H.verifyHederaAccount(policy, account, accountId);
              const signed = await vault.call('hSharedFinalize', {
                  policy,
                  proposal,
                  approval,
                  partials: signatures,
                }),
                existing = await api.hederaSharedReceipt(signed.transactionId);
              if (existing.found) {
                if (existing.result !== 'SUCCESS' || existing.intentMemo !== H.hederaNativeIntent(proposal))
                  throw new Error(
                    `This reviewed payment is not confirmed. Saved transaction result: ${existing.result}; its operation commitment must also match.`,
                  );
              } else await submitSharedHedera(signed);
              await vault.call('hSharedReconcile', {
                policy,
                id: proposal.id,
                account: await api.hederaAccountInfo(accountId),
                receipt: await api.hederaSharedReceipt(signed.transactionId),
              });
              setResult(signed.transactionId);
              await post('final', session, {
                transactionId: signed.transactionId,
              });
              await qc.invalidateQueries({ queryKey: scope });
            } catch (error) {
              setError(`${errorText(error)} Check the saved transaction before retrying.`);
            } finally {
              setBusy(false);
            }
          }}
        >
          Submit shared Hedera payment
        </Button>
      )}
      {result && (
        <p role="status" className="text-sm">
          Hedera receipt confirmed SUCCESS:{' '}
          <a className="break-all underline" href={transactionLink(result)} target="_blank" rel="noreferrer">
            {result}
          </a>
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
