'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatUnits, parseUnits } from '@qd/blockchain';
import {
  bitcoinPolicyId,
  createBitcoinPolicy,
  combineBitcoinApproval,
  makeSharedBitcoinProposal,
  sharedBitcoinMessage,
  sharedBitcoinOutput,
  type BitcoinEnrollment,
  type BitcoinRound,
  type BitcoinConsent,
  type SharedBitcoinProposal,
  type BitcoinSharedPolicy,
} from '@qd/bitcoin';
import { bytesToHex } from '@qd/wallet-core';
import { fromB64url, type SharedWallet } from '@qd/rpc';
import { getApi } from '@/lib/api';
import { vault } from '@/lib/vault-client';
import { createBitcoinDataSource } from '@/lib/bitcoin-api';
import { discoverSharedBitcoin, hydrateSharedBitcoinCoins, recheckSharedBitcoinProposal } from '@/lib/bitcoin-shared';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/identity';
import { BitcoinRecovery } from './bitcoin-recovery';

type RelayMessage = {
  id: string;
  from: string;
  kind: string;
  session: string;
  payload: string;
};
function content<T>(message: RelayMessage): T {
  return JSON.parse(new TextDecoder().decode(fromB64url(message.payload))) as T;
}
/** Validate untrusted public relay payloads before React renders their fields.
 * Cryptographic verification remains inside the signing worker. */
async function readMessages(walletId: string, accountId: string, session = 'enrollment'): Promise<RelayMessage[]> {
  const messages = (await (await getApi()).bitcoinSharedMessages(walletId, accountId, session)).messages;
  for (const message of messages) {
    const value = content<Record<string, unknown>>(message);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Bitcoin relay message');
    const strings: Record<string, string[]> = {
      enrollment: ['participantId', 'xpub', 'proof', 'raccoonPublicKey'],
      policy: ['policyId'],
      proposal: ['id', 'policyId', 'recipient', 'amount', 'psbt'],
      approve: ['message', 'nonce'],
      r1: ['payload'],
      r2: ['payload'],
      r3: ['payload'],
      partial: ['partial'],
      final: ['txid'],
    };
    const fields = strings[message.kind];
    if (!fields || fields.some((field) => typeof value[field] !== 'string'))
      throw new Error('Malformed Bitcoin relay message');
    if (/^r[123]$/.test(message.kind) && !Number.isSafeInteger(value.from)) throw new Error('Malformed Raccoon sender');
  }
  return messages;
}
const messageOf = (policy: BitcoinSharedPolicy, proposal: SharedBitcoinProposal) =>
  bytesToHex(sharedBitcoinMessage(policy, proposal));

export function BitcoinShared({
  wallet,
  spendingPaused = false,
  view = 'all',
}: {
  wallet: SharedWallet;
  spendingPaused?: boolean;
  view?: 'all' | 'wallet' | 'payments' | 'activity';
}) {
  const [accountId, setAccountId] = useState(wallet.accounts[0]?.id ?? '');
  const [session, setSession] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [compared, setCompared] = useState(false);
  const qc = useQueryClient();
  const account = wallet.accounts.find((a) => a.id === accountId),
    keygenId = wallet.key.keyGenerationId;
  useEffect(() => {
    if (!wallet.accounts.some((a) => a.id === accountId)) {
      setAccountId(wallet.accounts[0]?.id ?? '');
      setSession('');
    }
  }, [wallet.accounts, accountId]);
  const scope = ['bitcoin-shared', wallet.id, accountId, keygenId, wallet.policy.membershipVersion];
  const ready = !!account && !!keygenId && wallet.key.status === 'initialized' && wallet.me.status === 'active';
  const enrollment = useQuery({
    queryKey: [...scope, 'enrollment'],
    enabled: ready,
    refetchInterval: 3000,
    queryFn: () => readMessages(wallet.id, accountId),
  });
  const policy = useMemo(() => {
    if (!enrollment.data) return undefined;
    const entries = enrollment.data.filter((m) => m.kind === 'enrollment');
    if (entries.length !== wallet.participants.filter((p) => p.status === 'active').length) return undefined;
    try {
      return createBitcoinPolicy(
        entries.map((m) => {
          const entry = content<BitcoinEnrollment>(m);
          if (
            entry.participantId !== m.from ||
            entry.walletId !== wallet.id ||
            entry.accountId !== accountId ||
            entry.keygenId !== keygenId ||
            entry.membershipVersion !== wallet.policy.membershipVersion ||
            !wallet.participants.some((p) => p.id === m.from && p.status === 'active')
          )
            throw new Error('Unrecognized Bitcoin participant');
          return entry;
        }),
      );
    } catch {
      return undefined;
    }
  }, [enrollment.data, wallet.id, accountId, keygenId, wallet.policy.membershipVersion, wallet.participants]);
  const policyId = policy ? bitcoinPolicyId(policy) : '';
  const ownPinned =
    !!policy &&
    !!enrollment.data?.some(
      (m) => m.kind === 'policy' && m.from === wallet.me.id && content<{ policyId: string }>(m).policyId === policyId,
    );
  const confirmations = policy
    ? new Set(
        enrollment.data
          ?.filter((m) => m.kind === 'policy' && content<{ policyId: string }>(m).policyId === policyId)
          .map((m) => m.from),
      ).size
    : 0;
  const fullyPinned = !!policy && confirmations === policy.members.length;
  const funds = useQuery({
    queryKey: [...scope, 'funds', policyId],
    enabled: ownPinned,
    refetchInterval: 30000,
    queryFn: () => discoverSharedBitcoin(policy!),
  });
  const recent = useQuery({
    queryKey: [...scope, 'recent'],
    enabled: fullyPinned,
    refetchInterval: 3000,
    queryFn: () => readMessages(wallet.id, accountId, 'recent'),
  });
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await qc.invalidateQueries({ queryKey: scope });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bitcoin action failed');
    } finally {
      setBusy(false);
    }
  };
  const post = async (kind: string, room: string, value: unknown) => {
    await (
      await getApi()
    ).postBitcoinShared(wallet.id, accountId, keygenId!, wallet.policy.membershipVersion, kind, room, value);
  };
  const [recipient, setRecipient] = useState(''),
    [amount, setAmount] = useState('');
  const [selected, setSelected] = useState<number[]>();
  useEffect(() => {
    setSelected(undefined);
    setSession('');
  }, [accountId, policyId]);
  useEffect(() => {
    setSelected(undefined);
    setSession('');
  }, [accountId, policyId]);
  return (
    <section
      id="sw-bitcoin"
      className="mb-4 rounded-2xl border border-primary/30 bg-surface p-4"
      aria-label="Shared Bitcoin"
    >
      <h2 className="mb-2 text-lg font-semibold">Shared Bitcoin</h2>
      {spendingPaused && (
        <p role="status" className="mb-2 text-sm">
          Payments are paused while your group changes.{' '}
          <a href="#sw-setup" className="font-medium text-primary underline">
            Open wallet migration
          </a>{' '}
          to continue.
        </p>
      )}
      <p className="mb-3 text-sm text-muted">Bitcoin Testnet4 · Use test BTC on this network.</p>
      {!ready ? (
        <p className="text-sm text-muted">
          Create a shared account and finish key provisioning first. Use at least three participants for the current
          Raccoon setup.{' '}
          <a href="#sw-setup" className="font-medium text-primary underline">
            Open wallet setup
          </a>
        </p>
      ) : (
        <>
          <label
            hidden={wallet.accounts.length < 2}
            className={wallet.accounts.length < 2 ? 'hidden' : 'mb-3 block text-sm'}
          >
            Account
            <select
              className="mt-1 block w-full rounded-xl border border-line bg-surface p-2"
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                setSession('');
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
          <details open={!fullyPinned} className="my-3 rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-sm font-medium">Unlock & Bitcoin setup</summary>
            <p className="my-2 text-xs text-muted">
              Each signer checks Raccoon approval and provides a native Bitcoin signature. Native Bitcoin signatures are
              not quantum-safe.
            </p>
            <label className="mb-2 block text-sm">
              Unlock key shares
              <input
                type="password"
                autoComplete="current-password"
                className="mt-1 block w-full rounded-xl border border-line bg-surface p-2"
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
                  const pw = password;
                  setPassword('');
                  await vault.call('qdShareUnlock', { password: pw });
                })
              }
            >
              Unlock shares
            </Button>
            {!enrollment.data?.some((m) => m.kind === 'enrollment' && m.from === wallet.me.id) && (
              <Button
                className="ml-2"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const entry = await vault.call('btcSharedEnroll', {
                      context: {
                        walletId: wallet.id,
                        accountId,
                        keygenId: keygenId!,
                        membershipVersion: wallet.policy.membershipVersion,
                        network: 'testnet4',
                      },
                      participantId: wallet.me.id,
                      derivationIndex: account!.derivationIndex,
                    });
                    await post('enrollment', 'enrollment', entry);
                  })
                }
              >
                Register my Bitcoin key
              </Button>
            )}
            <p className="mt-2 text-sm text-muted">
              Native keys registered: {enrollment.data?.filter((m) => m.kind === 'enrollment').length ?? 0} /{' '}
              {wallet.policy.activeParticipants}
            </p>
            {policy && (
              <>
                <p className="mt-3 text-sm">
                  Bitcoin quorum: {policy.nativeThreshold} of {policy.members.length}. Raccoon quorum:{' '}
                  {policy.raccoonThreshold} of {policy.members.length}.
                </p>
                <p className="mt-2 text-xs font-semibold">Policy safety number</p>
                <p className="break-all font-mono text-xs">{policyId}</p>
                {!ownPinned && (
                  <>
                    <label className="my-2 flex gap-2 text-sm">
                      <input type="checkbox" checked={compared} onChange={(e) => setCompared(e.target.checked)} />I
                      compared this safety number with every participant.
                    </label>
                    <Button
                      size="sm"
                      disabled={!compared || busy}
                      onClick={() =>
                        void run(async () => {
                          const confirmation = await vault.call('issueConfirmation', {
                            payload: {
                              kind: 'bitcoin-shared',
                              policyId,
                              message: policyId,
                            },
                          });
                          await vault.call('btcSharedPin', {
                            policy,
                            confirmation,
                          });
                          await post('policy', 'enrollment', { policyId });
                          await qc.invalidateQueries({
                            queryKey: ['shared-wallet', wallet.id],
                          });
                        })
                      }
                    >
                      Confirm Bitcoin policy
                    </Button>
                  </>
                )}
                <p className="mt-2 text-sm text-muted">
                  Policy confirmations: {confirmations} / {policy.members.length}
                </p>
              </>
            )}
          </details>
          {policy && fullyPinned && (
            <>
              <div hidden={view !== 'all' && view !== 'wallet'} className="my-3 rounded-xl bg-sunken p-3">
                <p className="text-sm font-semibold">Receive Bitcoin</p>
                <p aria-label="Shared Bitcoin receive address" className="break-all font-mono text-xs">
                  {sharedBitcoinOutput(policy, 0, 0).address}
                </p>
                <CopyButton value={sharedBitcoinOutput(policy, 0, 0).address} />
              </div>
              <p className="text-sm">
                Available confirmed BTC: {funds.data ? formatUnits(funds.data.available, 8) : 'Checking…'}
              </p>
              {funds.isError && (
                <p role="status" className="text-sm text-danger">
                  Bitcoin discovery is unavailable. Funds are not reported as zero.
                </p>
              )}
              <form
                hidden={view === 'wallet' || view === 'activity'}
                className="my-3 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    if (spendingPaused) throw new Error('Finish the pending membership migration first');
                    const discovery = await discoverSharedBitcoin(policy),
                      coins = await hydrateSharedBitcoinCoins(discovery.coins);
                    const rate = (await createBitcoinDataSource('testnet4').getFees()).market;
                    const proposal = makeSharedBitcoinProposal(
                      policy,
                      coins,
                      recipient.trim(),
                      parseUnits(amount, 8),
                      rate,
                      discovery.next,
                      selected ?? policy.members.slice(0, policy.raccoonThreshold).map((m) => m.partyIndex),
                    );
                    await post('proposal', proposal.id, proposal);
                    setSession(proposal.id);
                  });
                }}
              >
                <label className="block text-sm">
                  Bitcoin recipient
                  <input
                    className="mt-1 block w-full rounded-xl border border-line bg-surface p-2"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  Amount in BTC
                  <input
                    inputMode="decimal"
                    className="mt-1 block w-full rounded-xl border border-line bg-surface p-2"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <fieldset className="rounded-xl border border-line p-2">
                  <legend className="text-sm">Choose {policy.raccoonThreshold} Raccoon signers</legend>
                  {policy.members.map((member) => (
                    <label key={member.partyIndex} className="mr-3 inline-flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={(
                          selected ?? policy.members.slice(0, policy.raccoonThreshold).map((m) => m.partyIndex)
                        ).includes(member.partyIndex)}
                        onChange={(e) =>
                          setSelected((previous) => {
                            const current =
                              previous ?? policy.members.slice(0, policy.raccoonThreshold).map((m) => m.partyIndex);
                            return (
                              e.target.checked
                                ? [...current, member.partyIndex]
                                : current.filter((i) => i !== member.partyIndex)
                            ).sort((a, b) => a - b);
                          })
                        }
                      />
                      Signer {member.partyIndex}
                    </label>
                  ))}
                </fieldset>
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    spendingPaused ||
                    busy ||
                    !recipient ||
                    !amount ||
                    !funds.data ||
                    (selected !== undefined && selected.length !== policy.raccoonThreshold)
                  }
                >
                  Prepare Bitcoin proposal
                </Button>
              </form>
              <div hidden={view === 'wallet'}>
                <label className="my-3 block text-sm">
                  Bitcoin proposal
                  <select
                    className="mt-1 block w-full rounded-xl border border-line bg-surface p-2"
                    value={session}
                    onChange={(e) => setSession(e.target.value)}
                  >
                    <option value="">Select a proposal</option>
                    {recent.data
                      ?.filter((m) => m.kind === 'proposal')
                      .map((m) => (
                        <option key={m.id} value={m.session}>
                          {m.session.slice(0, 8)} · {content<SharedBitcoinProposal>(m).amount} sats
                        </option>
                      ))}
                  </select>
                </label>
                {session && !spendingPaused && (
                  <BitcoinProposal
                    key={`${policyId}|${session}`}
                    wallet={wallet}
                    policy={policy}
                    session={session}
                    paused={spendingPaused}
                    post={post}
                  />
                )}
              </div>
            </>
          )}
        </>
      )}
      {ready && (
        <details open={view === 'activity'} className="mt-4 rounded-xl border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium">Recovery & saved payments</summary>
          <p className="my-2 text-xs text-muted">
            Keep each participant’s encrypted share backup. The recovery phrase alone cannot recreate Raccoon shares.
            Changing members requires a wallet migration.
          </p>
          <BitcoinRecovery walletId={wallet.id} policy={policy} enabled={ownPinned} />
        </details>
      )}
      {(enrollment.isError || recent.isError) && (
        <p role="alert" className="text-sm text-danger">
          Shared Bitcoin messages are unavailable or invalid.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

export function BitcoinProposal({
  wallet,
  policy,
  session,
  post,
  registeredProposal,
  loadMessages,
  paused = false,
}: {
  wallet: SharedWallet;
  policy: BitcoinSharedPolicy;
  session: string;
  paused?: boolean;
  registeredProposal?: SharedBitcoinProposal;
  loadMessages?: () => Promise<RelayMessage[]>;
  post: (kind: string, room: string, value: unknown) => Promise<void>;
}) {
  const qc = useQueryClient(),
    working = useRef(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  const scope = [
    'bitcoin-shared',
    wallet.id,
    policy.context.accountId,
    policy.context.keygenId,
    policy.context.membershipVersion,
  ];
  const messages = useQuery({
    queryKey: [...scope, session],
    refetchInterval: 2000,
    queryFn: async () => {
      const data = await (loadMessages ? loadMessages() : readMessages(wallet.id, policy.context.accountId, session));
      for (const message of data.filter(
        (m) => /^r[123]$/.test(m.kind) || m.kind === 'approve' || m.kind === 'partial',
      )) {
        const round = content<BitcoinRound>(message),
          member = policy.members.find((m) => m.participantId === message.from);
        if (!member || round.from !== member.partyIndex) throw new Error('Raccoon message author mismatch');
      }
      return data;
    },
  });
  const proposalMessage = messages.data?.find((m) => m.kind === 'proposal');
  const proposal =
    registeredProposal ?? (proposalMessage ? content<SharedBitcoinProposal>(proposalMessage) : undefined);
  const mine = policy.members.find((m) => m.participantId === wallet.me.id);
  const approved = messages.data?.some((m) => m.kind === 'approve' && m.from === wallet.me.id);
  const consents =
    messages.data
      ?.filter((m) => m.kind === 'approve')
      .map((m) => content<BitcoinConsent & { message: string }>(m))
      .filter((c) => proposal?.active.includes(c.from) && c.message === messageOf(policy, proposal)) ?? [];
  const rounds = (kind: string): BitcoinRound[] =>
    messages.data
      ?.filter((m) => m.kind === kind)
      .map((m) => {
        const round = content<BitcoinRound>(m),
          member = policy.members.find((member) => member.participantId === m.from);
        if (!member || round.from !== member.partyIndex) throw new Error('Raccoon message author mismatch');
        return round;
      }) ?? [];
  const advance = async () => {
    if (paused || working.current || !approved || !proposal || !mine || error || messages.isError) return;
    working.current = true;
    try {
      const data = messages.data ?? [],
        own = (kind: string) => data.some((m) => m.kind === kind && m.from === wallet.me.id);
      if (proposal.active.includes(mine.partyIndex)) {
        if (consents.length !== policy.raccoonThreshold) return;
        for (const round of [1, 2, 3] as const) {
          if (own(`r${round}`)) continue;
          const inputs = round === 1 ? [] : rounds(`r${round - 1}`);
          if (round > 1 && inputs.length !== policy.raccoonThreshold) return;
          const output = await vault.call('btcSharedRound', {
            policy,
            proposal,
            consents,
            round,
            inputs,
          });
          await post(`r${round}`, session, output);
          await qc.invalidateQueries({ queryKey: scope });
          return;
        }
      }
      if (!own('partial') && rounds('r3').length === policy.raccoonThreshold) {
        const approval = combineBitcoinApproval(
          policy,
          proposal,
          rounds('r1'),
          rounds('r2'),
          rounds('r3'),
          Date.now(),
          consents,
        );
        await discoverSharedBitcoin(policy);
        await recheckSharedBitcoinProposal(policy, proposal);
        const signature = await vault.call('btcSharedNativeSign', {
          policy,
          proposal,
          approval,
        });
        await post('partial', session, signature);
        await qc.invalidateQueries({ queryKey: scope });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bitcoin signing stopped');
    } finally {
      working.current = false;
    }
  };
  useEffect(() => {
    void advance();
  }, [messages.data, approved]);
  if (messages.isError)
    return (
      <p role="alert" className="text-sm text-danger">
        Bitcoin signing messages are unavailable or invalid. Signing has stopped.
      </p>
    );
  if (!proposal) return <p className="text-sm text-muted">Loading Bitcoin proposal…</p>;
  let valid = true;
  try {
    sharedBitcoinMessage(policy, proposal);
  } catch {
    valid = false;
  }
  if (!valid)
    return (
      <p role="alert" className="text-sm text-danger">
        This proposal is invalid or expired. Create a fresh proposal; do not reuse its signing session.
      </p>
    );
  return (
    <div className="rounded-xl border border-line p-3" aria-label="Bitcoin proposal review">
      <h3 className="font-semibold">
        {proposal.migration ? 'Review Bitcoin membership migration' : 'Review shared Bitcoin payment'}
      </h3>
      <p className="break-all text-sm">Recipient: {proposal.recipient}</p>
      <p className="text-sm">Payment: {formatUnits(BigInt(proposal.amount), 8)} BTC</p>
      <p className="text-sm">Network fee: {formatUnits(BigInt(proposal.maxFee), 8)} BTC</p>
      <p className="text-xs text-muted">
        Expires: {new Date(proposal.expiresAt).toLocaleString()}. Approval authorizes the exact payment and wallet-owned
        change.
      </p>
      {proposal.migration && (
        <p className="text-sm text-muted">
          This sweep may conflict with an older signed payment. Either transaction could confirm first. Both signed
          records remain recoverable; other and late coins still need the old quorum.
        </p>
      )}
      {!approved && (
        <Button
          className="mt-3"
          size="sm"
          disabled={paused || busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await recheckSharedBitcoinProposal(policy, proposal);
              const message = messageOf(policy, proposal),
                policyId = bitcoinPolicyId(policy);
              const confirmation = await vault.call('issueConfirmation', {
                payload: { kind: 'bitcoin-shared', policyId, message },
              });
              const consent = await vault.call('btcSharedApprove', {
                policy,
                proposal,
                confirmation,
              });
              await post('approve', session, consent);
              await qc.invalidateQueries({ queryKey: scope });
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Approval failed');
            } finally {
              setBusy(false);
            }
          }}
        >
          Approve and participate in signing
        </Button>
      )}
      <p className="mt-2 text-sm">
        Raccoon responses: {rounds('r3').length} / {policy.raccoonThreshold}. Bitcoin signatures:{' '}
        {messages.data?.filter((m) => m.kind === 'partial').length ?? 0} / {policy.nativeThreshold}.
      </p>
      {approved && (
        <Button
          className="mt-3"
          size="sm"
          disabled={
            paused || busy || (messages.data?.filter((m) => m.kind === 'partial').length ?? 0) < policy.nativeThreshold
          }
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const approval = combineBitcoinApproval(
                policy,
                proposal,
                rounds('r1'),
                rounds('r2'),
                rounds('r3'),
                Date.now(),
                consents,
              );
              const partials = (messages.data ?? [])
                .filter((m) => m.kind === 'partial')
                .map((m) => content<{ partial: string }>(m).partial);
              const finalized = await vault.call('btcSharedFinalize', {
                policy,
                proposal,
                approval,
                partials,
              });
              const source = createBitcoinDataSource('testnet4'),
                existing = await source.getTransaction(finalized.txid);
              if (!existing) {
                await recheckSharedBitcoinProposal(policy, proposal);
                if ((await source.broadcast(finalized.raw)) !== finalized.txid)
                  throw new Error('Broadcast transaction ID mismatch');
              }
              setResult(finalized.txid);
              await post('final', session, { txid: finalized.txid });
              await qc.invalidateQueries({ queryKey: scope });
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Submission could not be confirmed');
            } finally {
              setBusy(false);
            }
          }}
        >
          Finalize and submit Bitcoin payment
        </Button>
      )}
      {result && (
        <p role="status" className="mt-2 break-all text-sm">
          Bitcoin payment submitted: {result}. Confirmation must be checked on the network.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
