'use client';
/**
 * Networked Threshold Raccoon signing and on-chain execution for shared
 * wallets (UI thread). Key shares stay in the key worker: this file only
 * moves public values — account public-key hashes, round messages produced
 * by the worker, transcript hashes, signatures and transaction status.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import {
  ApiError,
  SigningRefusedError,
  checkSession,
  fromB64url,
  proposalDigest,
  proxyRequest,
  sha256Hex,
  transcriptHash,
  type Proposal,
  type ProposalLifecycle,
  type SharedAccount,
  type SharedWallet,
  type SigningAbortReason,
  type ExecutionInfo,
  type SigningSession,
} from '@qd/rpc';
import { QdAccount, accountAddress, executionMessage, proposalCall } from '@qd/qd-account';
import { getApi } from '@/lib/api';
import { VaultClientError, vault } from '@/lib/vault-client';
import { formatWeiAsEth } from '@/lib/eth-amount';
import { nativeSymbol } from '@/lib/shared-network';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/identity';
import { PROPOSAL_NETWORKS, errorMessage } from './shared-wallets';
import { TransactionReceiptCard, networkLabel, txExplorerUrl } from './transaction-receipt';
import { balanceView, type BalanceView } from '@/lib/gas-service';
import { preferredChain, useGasServiceChain, useGasServiceStatus } from '../gas-service/hooks';
import { ExecutionSummary } from '../gas-service/execution-summary';

const SIGN_POLL_MS = 1_500;

// ---------- chain reads (through the authenticated RPC proxy) ----------

async function rpc<T>(chainId: number, method: string, params: unknown[]): Promise<T> {
  return (await proxyRequest(await getApi(), chainId)({ method, params })) as T;
}

/** Balance, nonce and deployment state of a QdAccount on one chain. */
export function useAccountChainState(chainId: number, address: string | null) {
  return useQuery({
    queryKey: ['qd-account-chain', chainId, address],
    enabled: !!address,
    refetchInterval: 5_000,
    retry: 1,
    queryFn: async () => {
      const addr = address as Address;
      const [balanceHex, code] = await Promise.all([
        rpc<string>(chainId, 'eth_getBalance', [addr, 'latest']),
        rpc<string>(chainId, 'eth_getCode', [addr, 'latest']),
      ]);
      const deployed = !!code && code !== '0x';
      let nonce = 0n;
      if (deployed) {
        const out = await rpc<Hex>(chainId, 'eth_call', [
          { to: addr, data: encodeFunctionData({ abi: QdAccount.abi, functionName: 'nonce' }) }, 'latest',
        ]);
        nonce = decodeFunctionResult({ abi: QdAccount.abi, functionName: 'nonce', data: out }) as bigint;
      }
      return { balanceWei: BigInt(balanceHex).toString(), nonce: Number(nonce), deployed };
    },
  });
}

/** This device's own pk_j for an account (derived in the worker from its share). */
function useLocalAccountKey(wallet: SharedWallet, account: { derivationIndex: number }) {
  const share = useQuery({ queryKey: ['qd-share', wallet.id], queryFn: () => vault.call('qdShareStatus', { walletId: wallet.id }) });
  const held = share.data?.share;
  const usable = wallet.key.status === 'initialized' && !!share.data?.storeUnlocked && held?.keygenId === wallet.key.keyGenerationId;
  const key = useQuery({
    queryKey: ['qd-account-key', wallet.id, account.derivationIndex, held?.keygenId],
    enabled: usable,
    staleTime: Infinity,
    queryFn: async () => {
      const k = await vault.call('qdAccountKey', { walletId: wallet.id, derivationIndex: account.derivationIndex });
      return { ...k, address: accountAddress(k.publicKeyHash as Hex).toLowerCase() };
    },
  });
  return { share, key, usable, storeLocked: !!share.data && !share.data.storeUnlocked };
}

// ---------- accounts ----------

export function AccountOnChain({ wallet, account }: { wallet: SharedWallet; account: SharedAccount }) {
  const qc = useQueryClient();
  const gas = useGasServiceStatus({ refetchInterval: false });
  const [picked, setPicked] = useState<number | null>(null);
  // Until the user picks one: the first proposal network that works here (not a fixed local chain).
  const chainId = picked ?? preferredChain(PROPOSAL_NETWORKS.map((n) => n.chainId), gas.data);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { key, storeLocked } = useLocalAccountKey(wallet, account);
  const local = key.data;
  const registered = account.address;
  const chain = useAccountChainState(chainId, registered);
  const balance = balanceView(registered, chain);
  const iAttested = account.key?.attestations.some((a) => a.participantId === wallet.me.id) ?? false;
  const mismatch = !!registered && !!local && registered.toLowerCase() !== local.address;

  if (wallet.key.status !== 'initialized') {
    return <span className="block text-xs text-subtle">QD account #{account.derivationIndex} — address available once the wallet key is initialized</span>;
  }

  const register = async () => {
    if (!local) return;
    setBusy(true);
    setError(null);
    try {
      await (await getApi()).registerAccountKey(wallet.id, account, local.keygenId, fromB64url(local.publicKey), local.publicKeyHash, local.address);
      await qc.invalidateQueries({ queryKey: ['shared-wallet', wallet.id] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 space-y-1 text-xs">
      {registered ? (
        <>
          <span className="flex items-center gap-1">
            <span className="text-muted">Smart account</span>
            <span className="break-all font-mono" aria-label="Smart account address">{registered}</span>
            <CopyButton value={registered} label="Copy address" />
          </span>
          <span className="block text-subtle">
            Confirmed by {account.key?.attestations.length ?? 0} of {wallet.policy.activeParticipants} participant devices
            {local && !mismatch ? ' · derived and verified on this device' : ''}
          </span>
          {mismatch && (
            <span role="alert" className="block rounded-lg bg-danger-soft px-2 py-1 text-danger">
              This address does not match the key derived on this device. Do not fund it.
            </span>
          )}
          <span className="flex flex-wrap items-center gap-2">
            <select aria-label="Balance network" value={chainId} onChange={(e) => setPicked(Number(e.target.value))} className="rounded-lg border border-line bg-surface px-1.5 py-0.5">
              {PROPOSAL_NETWORKS.map((n) => (
                <option key={n.chainId} value={n.chainId}>
                  {n.name}
                </option>
              ))}
            </select>
            <AccountBalance view={balance} chainId={chainId} onRetry={() => void chain.refetch()} />
          </span>
        </>
      ) : (
        <span className="block text-subtle">QD account #{account.derivationIndex} — no address registered yet</span>
      )}
      {storeLocked && <span className="block text-subtle"><a href="#sw-setup" className="font-medium text-primary underline">Open wallet setup</a> to unlock signing and verify this address on this device.</span>}
      {key.isError && <span role="alert" className="block text-danger">Could not derive the account key on this device: {errorMessage(key.error)}</span>}
      {local && !mismatch && (!registered || !iAttested) && wallet.me.status === 'active' && (
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void register()}>
          {registered ? 'Confirm address on this device' : 'Derive smart-account address on this device'}
        </Button>
      )}
      {error && <span role="alert" className="block text-danger">{error}</span>}
    </div>
  );
}

type ChainState = { balanceWei: string; nonce: number; deployed: boolean };

/** Every state of the balance query is rendered; data is only read once it exists. */
function AccountBalance({ view, chainId, onRetry }: { view: BalanceView<ChainState>; chainId: number; onRetry: () => void }) {
  switch (view.kind) {
    case 'no-address':
      return <span className="text-subtle">No smart-account address available</span>;
    case 'loading':
      return <span aria-label="Account balance" className="text-subtle">Loading balance…</span>;
    case 'paused':
      return (
        <span aria-label="Account balance" className="text-subtle">
          Balance not loaded yet — retrying when this window is active and online
        </span>
      );
    case 'error':
      return (
        <span className="text-warning">
          <span aria-label="Account balance">Balance unavailable on {networkLabel(chainId)}</span>
          <span className="block text-xs text-subtle">{view.message}</span>
          <button type="button" onClick={onRetry} className="text-xs text-primary underline">Retry</button>
        </span>
      );
    case 'ready':
      return (
        <>
          <span aria-label="Account balance">{formatWeiAsEth(view.data.balanceWei)} {nativeSymbol(chainId)}</span>
          <span className="text-subtle">{view.data.deployed ? `nonce ${view.data.nonce}` : 'not deployed yet (deployed on first execution)'}</span>
        </>
      );
  }
}

// ---------- signing lifecycle ----------

export const LIFECYCLE_LABEL: Record<ProposalLifecycle, string> = {
  awaiting_approvals: 'Awaiting approvals',
  threshold_reached: 'Threshold reached',
  awaiting_key_generation: 'Threshold reached — awaiting key generation',
  awaiting_account_key: 'Threshold reached — awaiting account address',
  awaiting_signers: 'Awaiting selected signers',
  signing: 'Signing in progress',
  signing_failed: 'Signing failed',
  signature_verified: 'Signature verified',
  checking_relayer: 'Checking relayer',
  relayer_unavailable: 'Relayer not configured',
  insufficient_account_funds: 'Insufficient shared-account funds',
  insufficient_relayer_funds: 'Insufficient relayer funds',
  setting_up_verifier: 'Setting up verifier',
  preparing_account: 'Preparing smart account',
  waiting_nonce: 'Waiting for an earlier proposal',
  submitting: 'Submitting to blockchain',
  submitted: 'Submitted — confirming',
  confirmed: 'Confirmed',
  execution_failed: 'Execution failed',
  rejected: 'Rejected — threshold unreachable',
  expired: 'Expired',
  superseded: 'Superseded — membership changed',
};

export const LIFECYCLE_TONE: Record<ProposalLifecycle, string> = {
  awaiting_approvals: 'bg-warning-soft text-warning',
  threshold_reached: 'bg-primary-soft text-primary',
  awaiting_key_generation: 'bg-warning-soft text-warning',
  awaiting_account_key: 'bg-warning-soft text-warning',
  awaiting_signers: 'bg-primary-soft text-primary',
  signing: 'bg-primary-soft text-primary',
  signing_failed: 'bg-danger-soft text-danger',
  signature_verified: 'bg-primary-soft text-primary',
  checking_relayer: 'bg-primary-soft text-primary',
  relayer_unavailable: 'bg-danger-soft text-danger',
  insufficient_account_funds: 'bg-warning-soft text-warning',
  insufficient_relayer_funds: 'bg-warning-soft text-warning',
  setting_up_verifier: 'bg-primary-soft text-primary',
  preparing_account: 'bg-primary-soft text-primary',
  waiting_nonce: 'bg-warning-soft text-warning',
  submitting: 'bg-primary-soft text-primary',
  submitted: 'bg-primary-soft text-primary',
  confirmed: 'bg-success-soft text-success',
  execution_failed: 'bg-danger-soft text-danger',
  rejected: 'bg-danger-soft text-danger',
  expired: 'bg-sunken text-subtle',
  superseded: 'bg-sunken text-subtle',
};

const FAIL_REASON: Record<string, string> = {
  expired: 'a selected signer did not respond in time (session expired)',
  cancelled: 'cancelled by a signer',
  membership_changed: 'wallet membership changed',
  invalid_commitment: 'a signer’s commitment opening did not match its commitment',
  invalid_signature: 'the combined signature did not verify (an invalid response share)',
  participant_abort: 'a signer’s device refused a protocol message',
  signer_state_lost: 'a signer’s device lost its round state (page reloaded)',
};

const ABORT_FOR_CODE: Record<string, SigningAbortReason> = {
  SIGNER_STATE_LOST: 'signer_state_lost',
  PROTOCOL_ABORT: 'participant_abort',
  SIGNING_REFUSED: 'participant_abort',
};

interface Expectation {
  walletId: string;
  proposalId: string;
  proposalDigest: string;
  chainId: number;
  derivationIndex: number;
  accountAddress: string;
  publicKeyHash: string;
  message: string;
  signerPartyIndexes: number[];
  keyGenerationId: string;
  partyIndex: number;
}

/**
 * Runs this device's part of the three-round protocol for one proposal when
 * it is a selected signer: opens (or joins) the session, then for each round
 * checks the session and transcript against values computed here, asks the
 * key worker for its message, and relays it device-signed.
 */
function useSignerParticipation(wallet: SharedWallet, p: Proposal, active: boolean) {
  const qc = useQueryClient();
  const [session, setSession] = useState<SigningSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expectation = useRef<Expectation | null>(null);
  const ledger = useRef(new Map<string, Map<string, string>>()); // session → "round:party" → sha256(payload)
  const inFlight = useRef(new Set<string>());
  const sessionId = useRef<string | null>(p.signing?.session?.id ?? null);

  const expect = useCallback(async (): Promise<Expectation> => {
    if (expectation.current) return expectation.current;
    // Everything the session must match is recomputed on this device.
    if ((await proposalDigest(p)) !== p.digest) throw new SigningRefusedError('Proposal digest mismatch');
    const k = await vault.call('qdAccountKey', { walletId: wallet.id, derivationIndex: p.derivationIndex });
    const addr = accountAddress(k.publicKeyHash as Hex).toLowerCase();
    if (!p.senderAddress || p.senderAddress.toLowerCase() !== addr) {
      throw new SigningRefusedError('The proposal’s sender account does not match this device’s key');
    }
    const message = executionMessage(BigInt(p.chainId), addr as Address, proposalCall(p));
    expectation.current = {
      walletId: wallet.id, proposalId: p.id, proposalDigest: p.digest, chainId: p.chainId, derivationIndex: p.derivationIndex,
      accountAddress: addr, publicKeyHash: k.publicKeyHash, message, signerPartyIndexes: p.signing?.signerPartyIndexes ?? [],
      keyGenerationId: k.keygenId, partyIndex: k.partyIndex,
    };
    return expectation.current;
  }, [p, wallet.id]);

  const step = useCallback(async () => {
    const api = await getApi();
    // Follow the proposal's newest open session (e.g. after another signer retried).
    const latest = p.signing?.session;
    if (latest && ['round1', 'round2', 'round3', 'combining'].includes(latest.status)) sessionId.current = latest.id;
    let s: SigningSession;
    if (!sessionId.current) {
      if (p.lifecycle !== 'awaiting_signers') return; // never silently restart a failed session
      await expect();
      s = await api.startSigning(p.id);
      sessionId.current = s.id;
    } else {
      s = await api.signingSession(sessionId.current);
    }
    setSession(s);
    if (s.round < 1 || s.round > 3) {
      if (s.status === 'complete' || s.status === 'failed') await qc.invalidateQueries({ queryKey: ['shared-proposals', wallet.id] });
      return;
    }
    const exp = await expect();
    checkSession(s, exp);
    const round = s.round as 1 | 2 | 3;
    if (s.progress[String(round) as '1' | '2' | '3'].includes(exp.partyIndex)) return;
    const flight = `${s.id}:${round}`;
    if (inFlight.current.has(flight)) return;
    inFlight.current.add(flight);
    try {
      let book = ledger.current.get(s.id);
      if (!book) ledger.current.set(s.id, (book = new Map()));
      const inputs: string[] = [];
      if (round > 1) {
        for (const idx of s.signerPartyIndexes) {
          const m = s.messages.find((x) => x.round === round - 1 && x.partyIndex === idx);
          if (!m?.payload) throw new SigningRefusedError('A previous-round message is missing');
          if ((await sha256Hex(fromB64url(m.payload))) !== m.payloadSha256) throw new SigningRefusedError('A relayed message does not match its hash');
          book.set(`${m.round}:${m.partyIndex}`, m.payloadSha256);
          inputs.push(m.payload);
        }
      }
      // Earlier rounds must be exactly what this device saw when it used them.
      for (const m of s.messages.filter((x) => x.round < round)) {
        if (book.get(`${m.round}:${m.partyIndex}`) !== m.payloadSha256) throw new SigningRefusedError('The coordinator changed an earlier round');
      }
      const mine = [...book.entries()].map(([k, h]) => {
        const [r, i] = k.split(':').map(Number);
        return { round: r!, partyIndex: i!, payloadSha256: h };
      });
      const transcript = await transcriptHash(s.header, mine, round);
      if (transcript !== s.transcriptHash) throw new SigningRefusedError('Transcript mismatch');
      const out = await vault.call('qdSignRound', {
        walletId: wallet.id, keygenId: exp.keyGenerationId, sessionId: s.id, sid: s.sid, act: s.signerPartyIndexes,
        derivationIndex: s.derivationIndex, message: s.message, publicKeyHash: s.publicKeyHash, round, inputs,
      });
      const next = await api.submitRound(s, wallet.me.id, exp.partyIndex, round, fromB64url(out.payload), transcript);
      setSession(next);
      if (next.status === 'complete' || next.status === 'failed') await qc.invalidateQueries({ queryKey: ['shared-proposals', wallet.id] });
    } catch (e) {
      const reason: SigningAbortReason | undefined =
        e instanceof VaultClientError ? ABORT_FOR_CODE[e.code] : e instanceof SigningRefusedError ? 'participant_abort' : undefined;
      if (reason) {
        await api.abortSigning(s, wallet.me.id, reason).catch(() => undefined);
        await vault.call('qdForgetSession', { sessionId: s.id }).catch(() => undefined);
        await qc.invalidateQueries({ queryKey: ['shared-proposals', wallet.id] });
      }
      if (e instanceof ApiError && e.code === 'DUPLICATE_ROUND_MESSAGE') return;
      throw e;
    }
  }, [expect, p, qc, wallet.id, wallet.me.id]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await step();
        if (!stopped) setError(null);
      } catch (e) {
        if (!stopped) setError(errorMessage(e));
      } finally {
        if (!stopped) timer = setTimeout(() => void tick(), SIGN_POLL_MS);
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, step]);

  const retry = async () => {
    setError(null);
    try {
      await expect();
      const s = await (await getApi()).startSigning(p.id);
      sessionId.current = s.id;
      setSession(s);
      await qc.invalidateQueries({ queryKey: ['shared-proposals', wallet.id] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return { session, error, retry };
}

/** Only steps that happened, are happening or failed are shown: never a future "Submitted"/"Confirmed". */
function Step({ state, children }: { state: 'done' | 'active' | 'todo' | 'failed'; children: React.ReactNode }) {
  if (state === 'todo') return null;
  const mark = { done: '✓', active: '…', failed: '✗' }[state];
  const tone = { done: 'text-success', active: 'text-primary', failed: 'text-danger' }[state];
  return (
    <li className="flex gap-2">
      <span aria-hidden className={`w-4 shrink-0 font-semibold ${tone}`}>
        {mark}
      </span>
      <span>{children}</span>
    </li>
  );
}


function TxLink({ chainId, hash, label }: { chainId: number; hash: string; label?: string }) {
  const url = txExplorerUrl(chainId, hash);
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" aria-label={label} className="break-all font-mono text-xs text-primary underline">{hash}</a>
  ) : (
    <span aria-label={label} className="break-all font-mono text-xs">{hash}</span>
  );
}

const SETUP_TOTAL = 13; // verifier, factory, 10 matrix pairs, account (fewer when already on chain)

/** Execution progress after the signature is verified: only what happened, is happening or failed. */
function ExecutionSteps({ p, ex }: { p: Proposal; ex: ExecutionInfo }) {
  const stage = ex.stage;
  const chainName = networkLabel(p.chainId);
  const waiting = ex.status === 'pending' || ex.status === 'submitting';
  const relayer = useGasServiceChain(p.chainId, waiting && (stage === 'insufficient_relayer_funds' || stage === 'relayer_unavailable'));
  const setupStarted = ex.setupTxs.length > 0 || !!ex.pendingSetupTx || stage === 'setting_up_verifier' || stage === 'preparing_account';
  const setupDone = !!ex.txHash || (setupStarted && waiting && !['setting_up_verifier', 'preparing_account'].includes(stage));
  const executeFailed = ex.status === 'failed';
  const failedBeforeSubmit = executeFailed && !ex.txHash;
  return (
    <>
      <Step
        state={stage === 'checking_relayer' ? 'active' : stage === 'relayer_unavailable' ? 'failed' : ex.relayer || ex.txHash ? 'done' : waiting ? 'active' : failedBeforeSubmit ? 'failed' : 'todo'}
      >
        {stage === 'relayer_unavailable' ? `Relayer unavailable — ${ex.lastError}` : `Checking relayer${ex.relayer ? ` (${ex.relayer.slice(0, 10)}…)` : ''}`}
        {stage === 'relayer_unavailable' && relayer.chain && !relayer.chain.relayerConfigured && (
          <span className="block text-xs text-subtle">The API has no relayer key for chain {p.chainId}; an operator must configure it and restart the API.</span>
        )}
      </Step>
      {stage === 'insufficient_account_funds' && waiting && <Step state="failed">Insufficient shared-account funds — {ex.lastError}</Step>}
      {stage === 'insufficient_relayer_funds' && waiting && (
        <Step state="failed">
          Insufficient relayer funds — {ex.lastError}
          {relayer.chain?.relayerBalanceWei !== undefined && (
            <span className="block text-xs text-subtle">Gas Service Account balance now: {formatWeiAsEth(relayer.chain.relayerBalanceWei)} {nativeSymbol(p.chainId)}. Nothing has been spent; this continues once funded.</span>
          )}
          <a href="/settings#gas-service" className="block text-xs text-primary underline">Open Gas Service Account (fund / recharge)</a>
        </Step>
      )}
      {stage === 'waiting_nonce' && waiting && <Step state="active">{ex.lastError}</Step>}
      {setupStarted && (
        <Step state={setupDone ? 'done' : executeFailed && !ex.txHash ? 'failed' : 'active'}>
          {stage === 'preparing_account' ? 'Preparing smart account' : 'Setting up verifier'} — {ex.setupTxs.length} one-time setup transaction(s) mined
          {!setupDone && ` (up to ${SETUP_TOTAL} on a fresh chain)`}
          {ex.pendingSetupTx && (
            <span className="block">
              In flight: <TxLink chainId={p.chainId} hash={ex.pendingSetupTx} />
            </span>
          )}
          {waiting && ex.lastError && !ex.pendingSetupTx && ['setting_up_verifier', 'preparing_account'].includes(stage) && (
            <span className="block text-xs text-subtle">{ex.lastError}</span>
          )}
          {ex.setupAttempts > 0 && <span className="block text-xs text-warning">{ex.setupAttempts} setup transaction(s) reverted; retries are 5 minutes apart, at most 3.</span>}
        </Step>
      )}
      <Step state={ex.txHash ? 'done' : stage === 'submitting' && waiting ? 'active' : failedBeforeSubmit ? 'failed' : 'todo'}>
        {failedBeforeSubmit ? `Not submitted — ${ex.lastError}` : `Submitting to ${chainName}`}
      </Step>
      {ex.txHash && (
        <Step state={executeFailed ? 'failed' : 'done'}>
          Submitted: <TxLink chainId={p.chainId} hash={ex.txHash} label="Transaction hash" />
          {txExplorerUrl(p.chainId, ex.txHash) && (
            <a href={txExplorerUrl(p.chainId, ex.txHash)!} target="_blank" rel="noopener noreferrer" className="ml-1 text-xs text-primary underline">
              View on Etherscan
            </a>
          )}
        </Step>
      )}
      {ex.txHash && (
        <Step state={ex.status === 'confirmed' ? 'done' : ex.status === 'submitted' ? 'active' : 'failed'}>
          {ex.status === 'confirmed'
            ? `Confirmed in block ${ex.blockNumber} (gas used ${ex.gasUsed})`
            : ex.status === 'submitted'
              ? `Confirming — waiting for the receipt${ex.lastError ? ` (${ex.lastError})` : ''}`
              : `Execution failed: ${ex.lastError}`}
        </Step>
      )}
    </>
  );
}

export function SigningPanel({ wallet, proposal: p }: { wallet: SharedWallet; proposal: Proposal }) {
  const local = useLocalAccountKey(wallet, { derivationIndex: p.derivationIndex });
  const nameOf = (id: string) => wallet.participants.find((x) => x.id === id)?.displayName || 'Participant';
  const signers = p.signing?.signers ?? [];
  const iAmSigner = signers.includes(wallet.me.id) && wallet.me.status === 'active';
  const lc = p.lifecycle;
  const participating = iAmSigner && local.usable && (lc === 'awaiting_signers' || lc === 'signing' || lc === 'signature_verified');
  const { session: live, error, retry } = useSignerParticipation(wallet, p, participating);
  // The proposal (refreshed every few seconds) is the source of truth; the
  // participation loop's own copy is only used before the proposal shows a session.
  const s = p.signing?.session ?? live ?? undefined;
  // Independent check on this device: the stored signature verifies under this device's own pk_j.
  const verifiedHere = useQuery({
    queryKey: ['qd-local-verify', s?.id, s?.signatureSha256],
    enabled: !!s?.signatureVerified && local.usable,
    staleTime: Infinity,
    queryFn: async () => {
      const full = await (await getApi()).signingSession(s!.id);
      if (!full.signature) return false;
      return vault.call('qdVerifySignature', { walletId: wallet.id, derivationIndex: p.derivationIndex, message: full.message, signature: full.signature });
    },
  });
  const localVerified = verifiedHere.data ?? null;
  const ex = p.execution.status !== 'not_started' ? p.execution : null;
  // After confirmation, re-read balances and the account nonce from the chain (never updated optimistically).
  const qc = useQueryClient();
  const confirmedHash = ex?.status === 'confirmed' ? ex.txHash : null;
  useEffect(() => {
    if (!confirmedHash) return;
    void qc.invalidateQueries({ queryKey: ['qd-account-chain'] });
    void qc.invalidateQueries({ queryKey: ['qd-balance'] });
    // Both histories are read from the chain index; refresh them now.
    void qc.invalidateQueries({ queryKey: ['qd-wallet-history'] });
    void qc.invalidateQueries({ queryKey: ['activity'] });
  }, [confirmedHash, qc]);
  const T = p.requiredApprovals;
  const roundsDone = (r: '1' | '2' | '3') => s?.progress[r].length ?? 0;

  if (!p.signing) return null;
  // Until something is on chain: what execution will cost and whether it can proceed.
  const showSummary =
    !['signing_failed', 'rejected', 'expired', 'superseded', 'execution_failed', 'confirmed'].includes(lc) && !(ex && (ex.txHash || ex.status === 'submitted'));
  const signed = !!s?.signatureVerified;
  const sessionFailed = s?.status === 'failed';
  const roundState = (r: 1 | 2 | 3): 'done' | 'active' | 'todo' | 'failed' =>
    signed || (s && s.round > r) || (s?.status === 'combining') ? 'done' : sessionFailed && (s?.round ?? 0) >= r ? 'failed' : s?.round === r ? 'active' : 'todo';

  return (
    <section aria-label="Signing and execution" className="mt-3 rounded-xl bg-sunken/50 p-2.5 text-[13px]">
      <p className="mb-1 font-medium">
        Selected signers: {signers.map((id, i) => `${nameOf(id)}${id === wallet.me.id ? ' (you)' : ''} (party ${p.signing!.signerPartyIndexes?.[i] ?? '?'})`).join(', ')}
      </p>
      <ol className="space-y-0.5" aria-label="Signing progress">
        <Step state="done">Threshold reached ({p.approvals}/{T} approvals)</Step>
        {lc === 'awaiting_key_generation' && <Step state="active">Awaiting an initialized Threshold Raccoon key for this proposal’s participants</Step>}
        {lc === 'awaiting_account_key' && <Step state="active">Awaiting the smart-account address (a participant derives it in the Accounts card)</Step>}
        <Step state={s ? 'done' : lc === 'awaiting_signers' ? 'active' : 'todo'}>
          {s ? `Signing session opened (attempt ${s.attempt}, expires ${new Date(s.expiresAt).toLocaleTimeString()})` : 'Awaiting selected signers'}
        </Step>
        <Step state={roundState(1)}>Round 1 — commitments ({roundsDone('1')}/{T})</Step>
        <Step state={roundState(2)}>Round 2 — openings and MACs ({roundsDone('2')}/{T})</Step>
        <Step state={roundState(3)}>Round 3 — response shares ({roundsDone('3')}/{T})</Step>
        <Step state={signed ? 'done' : sessionFailed && s?.failureReason === 'invalid_signature' ? 'failed' : 'todo'}>Signature generated (combined from the response shares)</Step>
        <Step state={signed ? 'done' : 'todo'}>
          Signature verified{signed ? ' by the coordinator' : ''}
          {localVerified === true ? ' and on this device' : localVerified === false ? ' — but FAILED verification on this device' : ''}
        </Step>
        {ex && <ExecutionSteps p={p} ex={ex} />}
      </ol>
      {showSummary && <ExecutionSummary proposal={p} />}
      {ex?.status === 'confirmed' && <TransactionReceiptCard wallet={wallet} proposal={p} verifiedOnDevice={localVerified} />}
      {sessionFailed && <p className="mt-1 text-danger">Signing failed: {FAIL_REASON[s!.failureReason] ?? s!.failureReason}. No signature was produced.</p>}
      {iAmSigner && !local.usable && (lc === 'awaiting_signers' || lc === 'signing') && (
        <p className="mt-1 text-warning">You are a selected signer: unlock key-share storage on this device (Threshold key card) to take part.</p>
      )}
      {iAmSigner && participating && (lc === 'awaiting_signers' || lc === 'signing') && <p className="mt-1 text-subtle">This device is taking part automatically; keep this page open.</p>}
      {iAmSigner && lc === 'signing_failed' && local.usable && (
        <Button className="mt-2" size="sm" variant="secondary" onClick={() => void retry()}>
          Retry signing (new session)
        </Button>
      )}
      {error && <p role="alert" className="mt-1 text-danger">{error}</p>}
    </section>
  );
}
