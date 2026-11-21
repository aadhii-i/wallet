'use client';
import { useEffect, useId, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Info, KeyRound, Users } from 'lucide-react';
import {
  ApiError,
  KeygenRefusedError,
  VoteRefusedError,
  checkKeygenAgainstWallet,
  fromB64url,
  keygenSafetyNumber,
  type CreateProposalInput,
  type KeyInitStatus,
  type KeygenFailReason,
  type Proposal,
  type SharedWallet,
  type VoteDecision,
} from '@qd/rpc';
import { getApi } from '@/lib/api';
import { VaultClientError, vault } from '@/lib/vault-client';
import { formatWeiAsEth, parseEthToWei } from '@/lib/eth-amount';
import { toast } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { CopyButton, shortAddress } from '@/components/ui/identity';
import { Skeleton } from '@/components/ui/spinner';
import { WalletHistory } from './wallet-history';
import { AccountOnChain, LIFECYCLE_LABEL, LIFECYCLE_TONE, SigningPanel, useAccountChainState } from './shared-signing';

// ---------- shared helpers ----------

const POLL_MS = 3_000;

/** Networks a proposal can target (execution needs the API's RPC and relayer for that chain). */
// Test networks only (the API rejects any other chain). Sepolia first: it is the default.
// Local Anvil is listed only when local networks are enabled (never in production builds).
export const PROPOSAL_NETWORKS: readonly { chainId: number; name: string }[] = [
  { chainId: 11155111, name: 'Sepolia' },
  { chainId: 84532, name: 'Base Sepolia' },
  { chainId: 421614, name: 'Arbitrum Sepolia' },
  { chainId: 80002, name: 'Polygon Amoy' },
  ...(process.env.NEXT_PUBLIC_ENABLE_LOCAL_NETWORKS === 'true' ? [{ chainId: 31337, name: 'Localhost (Anvil)' }] : []),
];

const networkName = (chainId: number) => PROPOSAL_NETWORKS.find((n) => n.chainId === chainId)?.name ?? `Chain ${chainId}`;

const CODE_MESSAGES: Record<string, string> = {
  DUPLICATE_VOTE: 'You have already voted on this proposal.',
  PROPOSAL_CLOSED: 'This proposal is no longer open for voting.',
  NOT_ELIGIBLE: 'You are not in this proposal’s participant snapshot.',
  DIGEST_MISMATCH: 'The proposal changed while you were reviewing it.',
  VOTE_NONCE_INVALID: 'The vote nonce expired or was already used. Try again.',
  VOTE_SIGNATURE_INVALID: 'The server rejected this device’s signature.',
  WRONG_DEVICE: 'This action must be signed by the device that joined the wallet.',
  MEMBERSHIP_CHANGED: 'Wallet membership changed. Reload and try again.',
  INVITATION_INVALID: 'This invitation code is invalid, expired or already used.',
  ALREADY_PARTICIPANT: 'You are already a participant of this wallet.',
  LIMIT_REACHED: 'The wallet has reached its participant limit.',
  FORBIDDEN: 'Not permitted for your role in this wallet.',
  NOT_FOUND: 'Not found, or you are not a participant.',
  KEYGEN_IN_PROGRESS: 'A key generation is already in progress.',
  KEY_ALREADY_INITIALIZED: 'This wallet already has an initialized key for its current participants.',
  KEYGEN_NOT_OPEN: 'This key generation step is no longer open (it may have failed or expired).',
  KEYGEN_INCOMPLETE: 'Not every participant has completed the previous step yet.',
  FINGERPRINT_MISMATCH: 'The key fingerprint does not match this key generation.',
  ALREADY_PROVISIONED: 'This device already received and acknowledged its share.',
  ALREADY_REGISTERED: 'This device already registered its encryption key.',
  SIGNATURE_INVALID: 'The server rejected this device’s signature.',
  NOT_IN_KEY_GENERATION: 'You are not a participant of this key generation.',
  NOT_SELECTED_SIGNER: 'You are not one of the selected signers for this proposal.',
  SIGNING_NOT_READY: 'Signing cannot start yet: the wallet key or the account address is not ready.',
  SIGNING_SESSION_CLOSED: 'The signing session moved on, failed or expired.',
  ALREADY_SIGNED: 'This proposal already has a verified signature.',
  SIGNING_SESSION_OPEN: 'A signing session is already in progress.',
  ACCOUNT_KEY_MISMATCH: 'This device derived a different account key than the one registered. Do not fund the registered address.',
  TRANSCRIPT_MISMATCH: 'The signing transcript changed. Retrying.',
  ROUND_MESSAGE_INVALID: 'The coordinator rejected a malformed round message.',
  DUPLICATE_ROUND_MESSAGE: 'This device already sent its message for this round.',
  SIGNING_ATTEMPTS_EXHAUSTED: 'Too many failed signing attempts. Create a new proposal.',
  PROPOSAL_EXPIRES_TOO_SOON: 'The proposal expires too soon to sign and execute it.',
};

/** Key-worker error codes (fixed strings, never key material). */
const WORKER_MESSAGES: Record<string, string> = {
  SHARE_STORE_LOCKED: 'Enter your wallet password to unlock key-share storage on this device.',
  WRONG_PASSWORD: 'Incorrect password.',
  DECRYPTION_FAILED: 'Your share could not be decrypted. The key generation was marked failed; the owner can retry.',
  SHARE_MISMATCH: 'The received share did not match this key generation. It was marked failed; the owner can retry.',
  SELF_CHECK_FAILED: 'The generated key failed its self-check. Nothing was sent; try again.',
  NOT_FOUND: 'This device has no receiving key for this key generation (was it prepared in another browser?).',
  BAD_KEY: 'A participant’s encryption key is invalid.',
  BAD_CONTEXT: 'The key generation parameters are invalid.',
  NO_SHARE: 'This device holds no share of the current wallet key.',
  SIGNING_REFUSED: 'This device refused the signing request.',
  SIGNER_STATE_LOST: 'This device lost its signing state (page reloaded). The session was ended; retry signing.',
  PROTOCOL_ABORT: 'This device detected an invalid protocol message and stopped signing.',
};

export function errorMessage(e: unknown): string {
  if (e instanceof VoteRefusedError) return `Vote refused on this device: ${e.message}`;
  if (e instanceof KeygenRefusedError) return `Refused on this device: ${e.message}`;
  if (e instanceof VaultClientError) return WORKER_MESSAGES[e.code] ?? `${e.message} (${e.code})`;
  if (e instanceof ApiError) {
    if (e.status === 429) return 'Too many requests. Wait a moment and try again.';
    const known = CODE_MESSAGES[e.code];
    return known ? `${known} (${e.code})` : `${e.message} (${e.code})`;
  }
  return e instanceof Error ? e.message : 'Something went wrong';
}

const notMember = (e: unknown) => e instanceof ApiError && (e.status === 403 || e.status === 404);
const retryUnlessForbidden = (n: number, e: unknown) => !notMember(e) && n < 3;

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString();
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString();

function Card({ children, title, label, anchor, className = '' }: { children: React.ReactNode; title?: string; label?: string; anchor?: string; className?: string }) {
  const id = useId();
  return (
    <section
      id={anchor}
      aria-labelledby={title ? id : undefined}
      aria-label={title ? undefined : label}
      className={`mb-4 scroll-mt-20 rounded-2xl border border-line bg-surface p-4 ${className}`}
    >
      {title && (
        <h2 id={id} className="mb-3 font-semibold">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

const inputClass = (error?: string | null, mono?: boolean) =>
  `h-12 w-full rounded-xl border bg-surface px-4 text-sm outline-none focus:border-primary ${mono ? 'font-mono' : ''} ${error ? 'border-danger' : 'border-line-strong'}`;

function TextField({
  label,
  value,
  onChange,
  placeholder,
  mono,
  error,
  maxLength,
  inputMode,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  error?: string | null;
  maxLength?: number;
  inputMode?: 'decimal' | 'numeric' | 'text';
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="mb-3">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass(error, mono)}
      />
      {error ? <p className="mt-1 text-sm text-danger">{error}</p> : hint ? <p className="mt-1 text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}

function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-2 rounded-xl bg-danger-soft px-3 py-2 text-sm">
      {message}
    </p>
  );
}

function Disclosure() {
  return (
    <div className="mb-4 flex gap-3 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px]" role="note" aria-label="Shared wallet security disclosure">
      <Info size={18} className="mt-0.5 shrink-0 text-warning" />
      <p>
        Research / testnet only. Approvals are authenticated with each participant’s device key (P-256 — classical, not post-quantum). The Threshold Raccoon key is generated by a trusted
        dealer (the owner’s device), which briefly holds the whole master secret and could sign alone. Signing runs between the selected participants’ devices; funds sit in a smart account whose on-chain Raccoon verifier is unaudited.
      </p>
    </div>
  );
}

// ---------- screen ----------

export function SharedWalletsScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const walletParam = params.get('wallet');
  const showList = params.get('view') === 'list';
  const open = (id: string) => router.push(`/shared?wallet=${encodeURIComponent(id)}`);
  const toList = () => router.push('/shared?view=list');

  const list = useQuery({
    queryKey: ['shared-wallets'],
    queryFn: async () => (await (await getApi()).sharedWallets()).wallets,
    refetchInterval: POLL_MS * 2,
  });

  let body: React.ReactNode;
  if (walletParam) {
    body = <Dashboard walletId={walletParam} onBack={toList} />;
  } else if (list.isLoading) {
    body = <Skeleton className="h-32 w-full" />;
  } else if (list.isError) {
    body = (
      <Card label="Error">
        <p className="mb-3 text-sm text-muted">Couldn’t load shared wallets. {errorMessage(list.error)}</p>
        <Button size="sm" variant="secondary" onClick={() => void list.refetch()}>
          Try again
        </Button>
      </Card>
    );
  } else {
    const wallets = list.data ?? [];
    if (wallets.length === 1 && !showList) {
      body = <Dashboard walletId={wallets[0]!.id} onBack={toList} />;
    } else if (wallets.length === 0) {
      body = (
        <>
          <Disclosure />
          <p className="mb-4 text-sm text-muted">You are not a participant of any shared wallet yet.</p>
          <CreateWalletForm onCreated={open} />
          <JoinWalletForm onJoined={open} />
        </>
      );
    } else {
      body = (
        <>
          <Card title="Your shared wallets">
            <ul aria-label="Your shared wallets" className="divide-y divide-line">
              {wallets.map((w) => (
                <li key={w.id}>
                  <button type="button" onClick={() => open(w.id)} className="flex w-full items-center gap-3 py-3 text-left">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
                      <Users size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{w.name}</span>
                      <span className="block text-xs text-subtle">
                        {w.policy.activeParticipants} participants · {w.me.role}
                      </span>
                    </span>
                    <ChevronRight size={18} className="text-subtle" />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <details className="mb-4">
            <summary className="mb-3 cursor-pointer text-sm font-medium text-primary">Create or join another shared wallet</summary>
            <CreateWalletForm onCreated={open} />
            <JoinWalletForm onJoined={open} />
          </details>
        </>
      );
    }
  }

  return (
    <>
      <h1 className="mb-1 mt-2 text-2xl font-bold">Shared wallets</h1>
      <p className="mb-6 text-muted">Transactions that need approval from several participants.</p>
      {body}
    </>
  );
}

// ---------- create / join ----------

function CreateWalletForm({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      aria-label="Create shared wallet"
      className="mb-4 rounded-2xl border border-line bg-surface p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const w = await (await getApi()).createSharedWallet(name.trim(), displayName.trim());
          qc.setQueryData(['shared-wallet', w.id], w);
          await qc.invalidateQueries({ queryKey: ['shared-wallets'] });
          toast.success('Shared wallet created');
          onCreated(w.id);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="mb-3 font-semibold">Create shared wallet</h2>
      <TextField label="Wallet name" value={name} onChange={setName} maxLength={64} placeholder="Family vault" />
      <TextField label="Your display name" value={displayName} onChange={setDisplayName} maxLength={64} hint="Shown to the other participants." />
      <Button type="submit" block disabled={!name.trim()} loading={busy} loadingText="Creating…">
        Create shared wallet
      </Button>
      <InlineError message={error} />
    </form>
  );
}

type Preview = { walletId: string; walletName: string; invitedBy: string; activeParticipants: number; expiresAt: string };

function JoinWalletForm({ onJoined }: { onJoined: (id: string) => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: 'preview' | 'accept' | 'reject', fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      aria-label="Join with invitation code"
      className="mb-4 rounded-2xl border border-line bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void run('preview', async () => setPreview(await (await getApi()).previewInvitation(code.trim())));
      }}
    >
      <h2 className="mb-3 font-semibold">Join with invitation code</h2>
      <TextField
        label="Invitation code"
        value={code}
        mono
        onChange={(v) => {
          setCode(v);
          setPreview(null);
        }}
      />
      <TextField label="Your display name" value={displayName} onChange={setDisplayName} maxLength={64} hint="Shown to the other participants." />
      {!preview ? (
        <Button type="submit" block variant="secondary" disabled={!code.trim()} loading={busy === 'preview'} loadingText="Checking…">
          Preview invitation
        </Button>
      ) : (
        <div aria-label="Invitation preview" role="group" className="rounded-xl bg-sunken p-3">
          <p className="mb-1 text-sm">
            <strong>{preview.walletName}</strong>
          </p>
          <p className="text-xs text-muted">
            Invited by {preview.invitedBy || 'the owner'} · {preview.activeParticipants} active participants · expires {fmtDateTime(preview.expiresAt)}
          </p>
          <p className="mt-2 text-xs text-muted">Joining adds you as a participant: future proposals will need approvals from more people.</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Button
              variant="secondary"
              loading={busy === 'reject'}
              disabled={busy !== null}
              onClick={() =>
                void run('reject', async () => {
                  await (await getApi()).rejectInvitation(code.trim());
                  setPreview(null);
                  setCode('');
                  toast.info('Invitation rejected');
                })
              }
            >
              Reject invitation
            </Button>
            <Button
              loading={busy === 'accept'}
              disabled={busy !== null}
              onClick={() =>
                void run('accept', async () => {
                  const w = await (await getApi()).acceptInvitation(code.trim(), displayName.trim());
                  qc.setQueryData(['shared-wallet', w.id], w);
                  await qc.invalidateQueries({ queryKey: ['shared-wallets'] });
                  toast.success(`Joined ${w.name}`);
                  onJoined(w.id);
                })
              }
            >
              Accept invitation
            </Button>
          </div>
        </div>
      )}
      <InlineError message={error} />
    </form>
  );
}

// ---------- dashboard ----------

const KEY_STATUS: Record<KeyInitStatus, string> = {
  not_initialized: 'Not initialized',
  in_progress: 'Key generation in progress',
  awaiting_provisioning: 'Awaiting participant provisioning',
  initialized: 'Key initialized',
  failed: 'Key generation failed',
  rekey_required: 'Membership changed — new key generation required',
};

function Dashboard({ walletId, onBack }: { walletId: string; onBack: () => void }) {
  const q = useQuery({
    queryKey: ['shared-wallet', walletId],
    queryFn: async () => (await getApi()).sharedWallet(walletId),
    refetchInterval: POLL_MS,
    retry: retryUnlessForbidden,
  });

  const back = (
    <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-primary">
      <ChevronLeft size={16} /> All shared wallets
    </button>
  );

  if (q.isLoading) return <Skeleton className="h-40 w-full" />;
  if (q.isError || !q.data) {
    return (
      <>
        {back}
        <Card label="Error">
          <p className="text-sm text-muted">{notMember(q.error) ? 'This shared wallet doesn’t exist or you are not a participant.' : `Couldn’t load this wallet. ${errorMessage(q.error)}`}</p>
        </Card>
      </>
    );
  }
  const w = q.data;
  const pct = Math.round((w.policy.numerator / w.policy.denominator) * 100);

  return (
    <>
      {back}
      <nav aria-label="Shared wallet sections" className="sticky top-0 z-10 -mx-1 mb-3 flex gap-1 overflow-x-auto bg-canvas/90 px-1 py-1.5 backdrop-blur">
        {[
          ['overview', 'Overview'],
          ['participants', 'Participants'],
          ['accounts', 'Accounts'],
          ['proposals', 'Proposals'],
          ['wallet-history', 'Wallet History'],
        ].map(([anchor, label]) => (
          <a
            key={anchor}
            href={`#sw-${anchor}`}
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(`sw-${anchor}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            className="shrink-0 rounded-full border border-line px-3 py-1 text-xs font-medium hover:bg-surface-hover"
          >
            {label}
          </a>
        ))}
      </nav>
      <Card label="Shared wallet summary" anchor="sw-overview">
        <div className="mb-3 flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
            <Users size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold">{w.name}</h2>
            <p className="text-xs text-subtle">You are {w.me.role === 'owner' ? 'the owner' : 'a member'} · created {fmtDate(w.createdAt)}</p>
          </div>
        </div>
        <ul className="space-y-1 text-sm">
          <li>Participants: {w.policy.activeParticipants}</li>
          <li>Authorization policy: {pct}%</li>
          <li>Required approvals: {w.policy.requiredApprovals}</li>
          <li className="flex items-center gap-1.5">
            <KeyRound size={14} className="text-subtle" /> Key status: {KEY_STATUS[w.key.status] ?? w.key.status}
          </li>
        </ul>
        <p className="mt-2 text-xs text-subtle">
          {pct}% of active participants, rounded up. Values come from the server and change when participants join or leave.
        </p>
      </Card>
      <Disclosure />
      <KeySetup wallet={w} />
      <Participants wallet={w} onLeft={onBack} />
      {w.me.role === 'owner' && <Invitations wallet={w} />}
      <Accounts wallet={w} />
      {w.me.status === 'active' && <NewProposal wallet={w} />}
      <Proposals wallet={w} />
      <Card title="Wallet History" anchor="sw-wallet-history" className="border-primary/30">
        <WalletHistory wallet={w} />
      </Card>
    </>
  );
}

function Participants({ wallet, onLeft }: { wallet: SharedWallet; onLeft: () => void }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isOwner = wallet.me.role === 'owner';

  const revoke = async (participantId: string, self: boolean) => {
    setBusy(participantId);
    setError(null);
    try {
      await (await getApi()).revokeParticipant(wallet.id, participantId);
      setConfirm(null);
      if (self) {
        qc.removeQueries({ queryKey: ['shared-wallet', wallet.id] });
        await qc.invalidateQueries({ queryKey: ['shared-wallets'] });
        toast.info(`You left ${wallet.name}`);
        onLeft();
      } else {
        toast.success('Participant revoked');
        await qc.invalidateQueries({ queryKey: ['shared-wallet', wallet.id] });
        await qc.invalidateQueries({ queryKey: ['shared-proposals', wallet.id] });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Participants" anchor="sw-participants">
      <ul aria-label="Participants" className="divide-y divide-line">
        {wallet.participants.map((p) => {
          const self = p.id === wallet.me.id;
          const canRevoke = p.status === 'active' && p.role !== 'owner' && (self ? !isOwner : isOwner);
          return (
            <li key={p.id} className="flex items-center gap-3 py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {p.displayName || 'Unnamed participant'}
                  {self && <span className="ml-1 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">You</span>}
                </span>
                <span className="block text-xs text-subtle">
                  {p.role === 'owner' ? 'Owner' : 'Member'} · {p.status} · joined {fmtDate(p.joinedAt)}
                  {p.revokedAt ? ` · revoked ${fmtDate(p.revokedAt)}` : ''}
                </span>
              </span>
              {canRevoke &&
                (confirm === p.id ? (
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="danger" loading={busy === p.id} onClick={() => void revoke(p.id, self)}>
                      {self ? 'Confirm leave' : 'Confirm revoke'}
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" className="text-danger" aria-label={self ? 'Leave wallet' : `Revoke ${p.displayName || 'participant'}`} onClick={() => setConfirm(p.id)}>
                    {self ? 'Leave' : 'Revoke'}
                  </Button>
                ))}
            </li>
          );
        })}
      </ul>
      {confirm && <p className="mt-2 text-xs text-muted">Changing membership supersedes every pending proposal.</p>}
      <InlineError message={error} />
    </Card>
  );
}

function Invitations({ wallet }: { wallet: SharedWallet }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<{ code: string; label: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invitations = wallet.invitations ?? [];

  return (
    <Card title="Invitations">
      {created ? (
        <div role="group" aria-label="New invitation" className="mb-3 rounded-xl bg-sunken p-3">
          <p className="mb-1 text-sm font-medium">Invitation code for {created.label || 'participant'}</p>
          <div className="flex items-center gap-2">
            <output aria-label="Invitation code" className="min-w-0 flex-1 break-all font-mono text-sm">
              {created.code}
            </output>
            <CopyButton value={created.code} label="Copy invitation code" toastText="Invitation code copied" />
          </div>
          <p className="mt-2 text-xs text-muted">Shown only once — it can’t be retrieved later. Send it over a trusted channel. Expires {fmtDateTime(created.expiresAt)}.</p>
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => setCreated(null)}>
            Done
          </Button>
        </div>
      ) : (
        <form
          aria-label="Invite participant"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy('create');
            setError(null);
            try {
              const inv = await (await getApi()).createInvitation(wallet.id, label.trim());
              setCreated({ code: inv.code, label: inv.label, expiresAt: inv.expiresAt });
              setLabel('');
              await qc.invalidateQueries({ queryKey: ['shared-wallet', wallet.id] });
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(null);
            }
          }}
        >
          <TextField label="Invitation label" value={label} onChange={setLabel} maxLength={64} placeholder="e.g. Bob’s laptop" hint="Only you see this label." />
          <Button type="submit" block variant="secondary" loading={busy === 'create'} loadingText="Creating…">
            Invite participant
          </Button>
        </form>
      )}
      <InlineError message={error} />
      {invitations.length > 0 && (
        <ul aria-label="Invitations" className="mt-3 divide-y divide-line">
          {invitations.map((i) => (
            <li key={i.id} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{i.label || 'Unlabelled invitation'}</span>
                <span className="block text-xs text-subtle">
                  {i.status} · {i.status === 'invited' ? `expires ${fmtDateTime(i.expiresAt)}` : `created ${fmtDate(i.createdAt)}`}
                </span>
              </span>
              {i.status === 'invited' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  aria-label={`Revoke invitation ${i.label}`}
                  loading={busy === i.id}
                  onClick={async () => {
                    setBusy(i.id);
                    setError(null);
                    try {
                      await (await getApi()).revokeInvitation(wallet.id, i.id);
                      await qc.invalidateQueries({ queryKey: ['shared-wallet', wallet.id] });
                    } catch (err) {
                      setError(errorMessage(err));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Accounts({ wallet }: { wallet: SharedWallet }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title="Accounts" anchor="sw-accounts">
      {wallet.accounts.length === 0 ? (
        <p className="mb-3 text-sm text-muted">No accounts yet. An account is what a proposal spends from.</p>
      ) : (
        <ul aria-label="Shared accounts" className="mb-3 divide-y divide-line">
          {wallet.accounts.map((a) => (
            <li key={a.id} className="py-2.5">
              <span className="block font-medium">{a.name}</span>
              <AccountOnChain wallet={wallet} account={a} />
            </li>
          ))}
        </ul>
      )}
      {wallet.me.status === 'active' && (
        <form
          aria-label="Add account"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await (await getApi()).createSharedAccount(wallet.id, name.trim());
              setName('');
              await qc.invalidateQueries({ queryKey: ['shared-wallet', wallet.id] });
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField label="Account name" value={name} onChange={setName} maxLength={64} hint="Adds a spending account to this wallet. It does not add a participant." />
          <Button type="submit" block variant="secondary" disabled={!name.trim()} loading={busy} loadingText="Adding…">
            Add account
          </Button>
          <InlineError message={error} />
        </form>
      )}
    </Card>
  );
}

// ---------- proposals ----------

const UINT_RE = /^(0|[1-9]\d*)$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DATA_RE = /^0x([0-9a-fA-F]{2})*$/;

interface ProposalDraft {
  accountId: string;
  to: string;
  amount: string;
  chainId: string;
  data: string;
  nonce: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  ttlHours: string;
}

const emptyDraft = (accountId = ''): ProposalDraft => ({
  accountId,
  to: '',
  amount: '',
  chainId: String(PROPOSAL_NETWORKS[0]?.chainId ?? 11155111),
  data: '',
  nonce: '0',
  gasLimit: '21000',
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
  ttlHours: '24',
});

type DraftErrors = Partial<Record<keyof ProposalDraft, string>>;

export function validateDraft(d: ProposalDraft): { input?: CreateProposalInput; errors: DraftErrors } {
  const errors: DraftErrors = {};
  if (!d.accountId) errors.accountId = 'Choose a sender account';
  if (!ADDRESS_RE.test(d.to.trim())) errors.to = 'Enter a 0x address (40 hex characters)';
  const amount = parseEthToWei(d.amount);
  if (!amount.ok) errors.amount = amount.error;
  const data = d.data.trim();
  if (data && !DATA_RE.test(data)) errors.data = 'Data must be 0x-prefixed hex with an even number of digits';
  if (!UINT_RE.test(d.nonce) || !Number.isSafeInteger(Number(d.nonce))) errors.nonce = 'Whole number';
  if (!UINT_RE.test(d.gasLimit) || Number(d.gasLimit) < 1 || Number(d.gasLimit) > 30_000_000) errors.gasLimit = '1 – 30,000,000';
  if (!UINT_RE.test(d.maxFeePerGas)) errors.maxFeePerGas = 'Whole number of wei';
  if (!UINT_RE.test(d.maxPriorityFeePerGas)) errors.maxPriorityFeePerGas = 'Whole number of wei';
  if (!UINT_RE.test(d.ttlHours) || Number(d.ttlHours) < 1 || Number(d.ttlHours) > 168) errors.ttlHours = '1 – 168 hours';
  if (Object.keys(errors).length > 0 || !amount.ok) return { errors };
  return {
    errors,
    input: {
      accountId: d.accountId,
      chainId: Number(d.chainId),
      to: d.to.trim(),
      valueWei: amount.wei,
      data: data || '0x',
      nonce: Number(d.nonce),
      gasLimit: Number(d.gasLimit),
      maxFeePerGas: d.maxFeePerGas,
      maxPriorityFeePerGas: d.maxPriorityFeePerGas,
      ttlSeconds: Number(d.ttlHours) * 3600,
    },
  };
}

function NewProposal({ wallet }: { wallet: SharedWallet }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ProposalDraft>(() => emptyDraft(wallet.accounts[0]?.id));
  const [review, setReview] = useState<CreateProposalInput | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof ProposalDraft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const accountSelectId = useId();
  const networkSelectId = useId();
  const [nonceTouched, setNonceTouched] = useState(false);
  const sender = wallet.accounts.find((a) => a.id === (draft.accountId || wallet.accounts[0]?.id));
  const chainState = useAccountChainState(Number(draft.chainId), sender?.address ?? null);
  const onchainNonce = chainState.data?.nonce;
  useEffect(() => {
    // Default to the smart account's next nonce on the chosen network.
    if (!nonceTouched && onchainNonce !== undefined) setDraft((d) => ({ ...d, nonce: String(onchainNonce) }));
  }, [nonceTouched, onchainNonce]);

  if (wallet.accounts.length === 0) {
    return (
      <Card title="New proposal">
        <p className="text-sm text-muted">Add an account first — proposals spend from a shared account.</p>
      </Card>
    );
  }
  const accountId = draft.accountId || wallet.accounts[0]!.id;
  const account = wallet.accounts.find((a) => a.id === (review?.accountId ?? accountId));

  if (review) {
    return (
      <Card title="Review proposal">
        <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted">From</dt>
          <dd>{account ? `${account.name} (QD account #${account.derivationIndex})` : review.accountId}</dd>
          <dt className="text-muted">To</dt>
          <dd className="break-all font-mono text-xs">{review.to}</dd>
          <dt className="text-muted">Amount</dt>
          <dd>{formatWeiAsEth(review.valueWei)} ETH</dd>
          <dt className="text-muted">Network</dt>
          <dd>
            {networkName(review.chainId)} ({review.chainId})
          </dd>
          <dt className="text-muted">Data</dt>
          <dd className="break-all font-mono text-xs">{review.data}</dd>
          <dt className="text-muted">Gas</dt>
          <dd className="text-xs">
            nonce {review.nonce} · limit {review.gasLimit} · max fee {review.maxFeePerGas} wei · priority {review.maxPriorityFeePerGas} wei
          </dd>
          <dt className="text-muted">Expires in</dt>
          <dd>{(review.ttlSeconds ?? 0) / 3600} h</dd>
        </dl>
        <p className="mb-2 rounded-xl bg-primary-soft px-3 py-2 text-sm font-medium">
          This transaction requires approval from {wallet.policy.requiredApprovals} of {wallet.policy.activeParticipants} participants.
        </p>
        <p className="mb-3 text-xs text-muted">
          Once approved, the selected signers’ devices produce one Threshold Raccoon signature over exactly this call; the account’s smart contract
          verifies it on-chain before executing. The nonce must be the account’s next nonce.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>
            Back
          </Button>
          <Button
            loading={busy}
            loadingText="Submitting…"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await (await getApi()).createProposal(wallet.id, review);
                setReview(null);
                setDraft(emptyDraft(accountId));
                await qc.invalidateQueries({ queryKey: ['shared-proposals', wallet.id] });
                toast.success('Proposal created');
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Submit proposal
          </Button>
        </div>
        <InlineError message={error} />
      </Card>
    );
  }

  return (
    <Card title="New proposal">
      <form
        aria-label="New proposal"
        onSubmit={(e) => {
          e.preventDefault();
          const r = validateDraft({ ...draft, accountId });
          setErrors(r.errors);
          if (r.input) {
            setError(null);
            setReview(r.input);
          }
        }}
      >
        <div className="mb-3">
          <label htmlFor={accountSelectId} className="mb-1.5 block text-sm font-medium">
            Sender account
          </label>
          <select id={accountSelectId} value={accountId} onChange={(e) => set('accountId')(e.target.value)} className={inputClass(errors.accountId)}>
            {wallet.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} (QD account #{a.derivationIndex})
              </option>
            ))}
          </select>
        </div>
        {sender?.address ? (
          <p className="-mt-1 mb-3 text-xs text-subtle">
            Sends from smart account <span className="font-mono">{sender.address}</span>
            {chainState.data ? ` · balance ${formatWeiAsEth(chainState.data.balanceWei)} ETH` : ''}
          </p>
        ) : (
          <p className="-mt-1 mb-3 text-xs text-warning">This account has no smart-account address yet; it can be approved but not executed until one is derived.</p>
        )}
        <TextField label="Recipient address" value={draft.to} onChange={set('to')} mono placeholder="0x…" error={errors.to} />
        <TextField label="Amount (ETH)" value={draft.amount} onChange={set('amount')} inputMode="decimal" placeholder="0.0" error={errors.amount} />
        <div className="mb-3">
          <label htmlFor={networkSelectId} className="mb-1.5 block text-sm font-medium">
            Network
          </label>
          <select id={networkSelectId} value={draft.chainId} onChange={(e) => set('chainId')(e.target.value)} className={inputClass()}>
            {PROPOSAL_NETWORKS.map((n) => (
              <option key={n.chainId} value={String(n.chainId)}>
                {n.name} ({n.chainId})
              </option>
            ))}
          </select>
        </div>
        <TextField label="Data (optional)" value={draft.data} onChange={set('data')} mono placeholder="0x" error={errors.data} />
        <details className="mb-3">
          <summary className="mb-2 cursor-pointer text-sm font-medium text-primary">Advanced</summary>
          <TextField
            label="Nonce"
            value={draft.nonce}
            onChange={(v) => {
              setNonceTouched(true);
              set('nonce')(v);
            }}
            inputMode="numeric"
            error={errors.nonce}
            hint={onchainNonce !== undefined ? `Account nonce on this network: ${onchainNonce}` : undefined}
          />
          <TextField label="Gas limit" value={draft.gasLimit} onChange={set('gasLimit')} inputMode="numeric" error={errors.gasLimit} />
          <TextField label="Max fee per gas (wei)" value={draft.maxFeePerGas} onChange={set('maxFeePerGas')} inputMode="numeric" error={errors.maxFeePerGas} />
          <TextField label="Max priority fee per gas (wei)" value={draft.maxPriorityFeePerGas} onChange={set('maxPriorityFeePerGas')} inputMode="numeric" error={errors.maxPriorityFeePerGas} />
          <TextField label="Expires after (hours)" value={draft.ttlHours} onChange={set('ttlHours')} inputMode="numeric" error={errors.ttlHours} />
        </details>
        <Button type="submit" block>
          Review proposal
        </Button>
      </form>
    </Card>
  );
}

const STATUS_LABEL: Record<Proposal['status'], string> = {
  pending: 'Pending approval',
  approved: 'Threshold reached',
  rejected: 'Rejected — threshold unreachable',
  expired: 'Expired',
  superseded: 'Superseded — membership changed',
};

const STATUS_TONE: Record<Proposal['status'], string> = {
  pending: 'bg-warning-soft text-warning',
  approved: 'bg-primary-soft text-primary',
  rejected: 'bg-danger-soft text-danger',
  expired: 'bg-sunken text-subtle',
  superseded: 'bg-sunken text-subtle',
};

function Proposals({ wallet }: { wallet: SharedWallet }) {
  const q = useQuery({
    queryKey: ['shared-proposals', wallet.id],
    queryFn: async () => (await (await getApi()).proposals(wallet.id)).proposals,
    refetchInterval: POLL_MS,
    retry: retryUnlessForbidden,
  });
  return (
    <Card title="Proposals" anchor="sw-proposals">
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-muted">Couldn’t load proposals. {errorMessage(q.error)}</p>
      ) : (q.data ?? []).length === 0 ? (
        <p className="text-sm text-muted">No proposals yet.</p>
      ) : (
        <div className="space-y-3">
          {q.data!.map((p) => (
            <ProposalCard key={p.id} wallet={wallet} proposal={p} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ProposalCard({ wallet, proposal: p }: { wallet: SharedWallet; proposal: Proposal }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<VoteDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameOf = (id: string) => wallet.participants.find((x) => x.id === id)?.displayName || 'Unknown participant';
  const account = wallet.accounts.find((a) => a.id === p.accountId);
  const eligible = p.eligibleParticipantIds.includes(wallet.me.id);
  const canVote = p.status === 'pending' && p.myVote === undefined && eligible && wallet.me.status === 'active';
  const amount = formatWeiAsEth(p.valueWei);

  const vote = async (decision: VoteDecision) => {
    setBusy(decision);
    setError(null);
    try {
      const updated = await (await getApi()).voteOnProposal(p.id, decision);
      qc.setQueryData<Proposal[]>(['shared-proposals', wallet.id], (old) => old?.map((x) => (x.id === updated.id ? updated : x)));
      void qc.invalidateQueries({ queryKey: ['shared-proposals', wallet.id] });
    } catch (err) {
      setError(errorMessage(err));
      void qc.invalidateQueries({ queryKey: ['shared-proposals', wallet.id] });
    } finally {
      setBusy(null);
    }
  };

  return (
    <article aria-label={`Proposal: ${amount} ETH to ${p.to}`} className="rounded-xl border border-line p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="font-semibold">
          {amount} ETH → <span className="font-mono text-sm">{shortAddress(p.to)}</span>
        </h3>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${LIFECYCLE_TONE[p.lifecycle] ?? STATUS_TONE[p.status]}`} aria-label="Proposal status">
          {LIFECYCLE_LABEL[p.lifecycle] ?? STATUS_LABEL[p.status]}
        </span>
      </div>
      <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">From</dt>
        <dd>
          {account ? `${account.name} (QD account #${p.derivationIndex})` : `QD account #${p.derivationIndex}`}
          {p.senderAddress && <span className="block break-all font-mono">{p.senderAddress}</span>}
        </dd>
        <dt className="text-muted">To</dt>
        <dd className="break-all font-mono">{p.to}</dd>
        <dt className="text-muted">Nonce · gas</dt>
        <dd>
          {p.nonce} · {p.gasLimit}
        </dd>
        <dt className="text-muted">Network</dt>
        <dd>
          {networkName(p.chainId)} ({p.chainId})
        </dd>
        <dt className="text-muted">Proposed by</dt>
        <dd>{nameOf(p.initiatorParticipantId)}</dd>
        <dt className="text-muted">Expires</dt>
        <dd>{fmtDateTime(p.expiresAt)}</dd>
      </dl>
      <p className="text-sm" aria-label="Approval progress">
        <strong>
          {p.approvals}/{p.requiredApprovals} approvals
        </strong>
        <span className="text-muted">
          {' '}
          · {p.rejections} {p.rejections === 1 ? 'rejection' : 'rejections'} · {p.remainingApprovals} more needed
        </span>
      </p>
      <p className="text-xs text-subtle">
        Snapshot: {p.participantCount} participants (membership v{p.membershipVersion}); a rejection counts as a vote, not a veto.
      </p>

      {p.votes.length > 0 && (
        <ul aria-label="Votes" className="mt-2 space-y-0.5 text-xs">
          {p.votes.map((v) => (
            <li key={v.participantId}>
              {nameOf(v.participantId)}
              {v.participantId === wallet.me.id ? ' (you)' : ''}: {v.decision === 'approve' ? 'approved' : 'rejected'}
            </li>
          ))}
        </ul>
      )}

      {p.signing && (p.status === 'approved' || p.execution.status !== 'not_started') && <SigningPanel wallet={wallet} proposal={p} />}
      {p.status === 'rejected' && <p className="mt-2 text-[13px] text-muted">Enough participants rejected that the approval threshold can no longer be reached.</p>}

      {p.myVote && <p className="mt-2 text-sm font-medium">Your vote: {p.myVote === 'approve' ? 'Approved' : 'Rejected'}</p>}
      {!eligible && <p className="mt-2 text-xs text-muted">You were not a participant when this was proposed, so you can’t vote on it.</p>}

      {canVote && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Button size="sm" variant="secondary" loading={busy === 'reject'} disabled={busy !== null} onClick={() => void vote('reject')}>
            Reject
          </Button>
          <Button size="sm" loading={busy === 'approve'} disabled={busy !== null} onClick={() => void vote('approve')}>
            Approve
          </Button>
        </div>
      )}
      {canVote && <p className="mt-1.5 text-[11px] text-subtle">Your vote is signed with this device’s key after re-checking the proposal digest locally.</p>}
      <InlineError message={error} />
    </article>
  );
}

// ---------- Threshold Raccoon key generation (trusted dealer) ----------

const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-8)}`;

function KeySetup({ wallet }: { wallet: SharedWallet }) {
  const qc = useQueryClient();
  const status = wallet.key.status;
  const open = status === 'in_progress' || status === 'awaiting_provisioning';
  const kgQ = useQuery({
    queryKey: ['shared-keygen', wallet.id],
    queryFn: async () => (await getApi()).currentKeyGeneration(wallet.id),
    enabled: wallet.key.generation !== undefined,
    refetchInterval: open ? POLL_MS : false,
    retry: retryUnlessForbidden,
  });
  const local = useQuery({
    queryKey: ['qd-share', wallet.id],
    queryFn: () => vault.call('qdShareStatus', { walletId: wallet.id }),
    refetchInterval: open ? POLL_MS : false,
  });
  const kg = wallet.key.generation && kgQ.data?.id === wallet.key.generation.id ? kgQ.data : undefined;
  const allKeys = !!kg && kg.keysRegistered === kg.parties;
  const safety = useQuery({
    queryKey: ['shared-keygen-safety', wallet.id, kg?.id, kg?.keysRegistered],
    queryFn: () => keygenSafetyNumber(wallet.id, kg!),
    enabled: allKeys,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');

  const isOwner = wallet.me.role === 'owner';
  const iAmDealer = !!kg && kg.dealerParticipantId === wallet.me.id;
  const mine = kg?.participants.find((p) => p.participantId === wallet.me.id);
  const nameOf = (id: string) => wallet.participants.find((p) => p.id === id)?.displayName || 'Participant';
  const storeLocked = local.data ? !local.data.storeUnlocked : false;

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      await Promise.all(
        [['shared-wallet', wallet.id], ['shared-keygen', wallet.id], ['qd-share', wallet.id], ['shared-proposals', wallet.id]].map((queryKey) =>
          qc.invalidateQueries({ queryKey }),
        ),
      );
    }
  };

  /** Re-fetch the ceremony and wallet, and refuse if they disagree (participants, version, T). */
  const freshChecked = async () => {
    const api = await getApi();
    const [w, current] = await Promise.all([api.sharedWallet(wallet.id), api.currentKeyGeneration(wallet.id)]);
    checkKeygenAgainstWallet(w, current);
    return { api, current };
  };

  const start = () => run('start', async () => (await getApi()).startKeyGeneration(wallet.id));
  const cancel = () => run('cancel', async () => kg && (await getApi()).failKeyGeneration(wallet.id, kg.id, 'cancelled'));
  const unlockStore = () =>
    run('unlock', async () => {
      await vault.call('qdShareUnlock', { password });
      setPassword('');
    });
  const prepare = () =>
    run('prepare', async () => {
      const { api, current } = await freshChecked();
      if (!current.me) throw new KeygenRefusedError('You are not part of this key generation');
      const { publicKey } = await vault.call('qdPrepareKeygen', { walletId: wallet.id, keygenId: current.id, participantId: current.me.participantId });
      await api.registerEncryptionKey(wallet.id, current, fromB64url(publicKey));
    });
  const deal = () =>
    run('deal', async () => {
      const { api, current } = await freshChecked();
      const res = await vault.call('qdDeal', {
        walletId: wallet.id, keygenId: current.id, threshold: current.threshold, parties: current.parties, membershipVersion: current.membershipVersion,
        recipients: current.participants.map((p) => {
          if (!p.encryptionKey) throw new KeygenRefusedError('A participant has not registered an encryption key');
          return { participantId: p.participantId, partyIndex: p.partyIndex, publicKey: p.encryptionKey };
        }),
      });
      await api.uploadDeal(
        wallet.id, current, res.fingerprint,
        res.envelopes.map((e) => ({ participantId: e.participantId, partyIndex: e.partyIndex, enc: fromB64url(e.enc), ct: fromB64url(e.ct) })),
      );
    });
  const receive = () =>
    run('receive', async () => {
      const api = await getApi();
      const current = await api.currentKeyGeneration(wallet.id);
      const env = await api.myKeygenEnvelope(wallet.id, current.id);
      const held = (await vault.call('qdShareStatus', { walletId: wallet.id })).share;
      // Already stored on an earlier attempt whose acknowledgement did not reach the server.
      const alreadyStored = held?.keygenId === env.keygenId && held.fingerprint === env.fingerprint && held.partyIndex === env.partyIndex;
      if (!alreadyStored) {
        try {
          await vault.call('qdAcceptShare', {
            walletId: env.walletId, keygenId: env.keygenId, participantId: env.participantId, partyIndex: env.partyIndex,
            threshold: env.threshold, parties: env.parties, membershipVersion: env.membershipVersion, fingerprint: env.fingerprint, enc: env.enc, ct: env.ct,
          });
        } catch (e) {
          const reason: KeygenFailReason | null =
            e instanceof VaultClientError && e.code === 'DECRYPTION_FAILED' ? 'decryption_failed' : e instanceof VaultClientError && e.code === 'SHARE_MISMATCH' ? 'share_verification_failed' : null;
          if (reason) await api.failKeyGeneration(wallet.id, current.id, reason).catch(() => undefined);
          throw e;
        }
      }
      await api.acknowledgeShare(wallet.id, env);
    });

  const passwordGate = storeLocked && (
    <div className="mt-3">
      <label htmlFor={`pw-${wallet.id}`} className="mb-1.5 block text-sm font-medium">
        Wallet password
      </label>
      <input
        id={`pw-${wallet.id}`}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className={inputClass()}
      />
      <p className="mt-1 text-xs text-subtle">Your share is stored on this device only, encrypted with a key derived from your wallet password.</p>
      <Button className="mt-2" size="sm" variant="secondary" loading={busy === 'unlock'} disabled={!password || busy !== null} onClick={() => void unlockStore()}>
        Unlock key-share storage
      </Button>
    </div>
  );

  const heldShare = local.data?.share;
  const holdsCurrent = !!heldShare && heldShare.keygenId === wallet.key.keyGenerationId;

  return (
    <Card title="Threshold key">
      <p className="text-sm">
        Status: <strong>{KEY_STATUS[status] ?? status}</strong>
      </p>

      {status === 'initialized' && (
        <div className="mt-2 space-y-1 text-sm">
          <p>
            {wallet.key.generation?.threshold}-of-{wallet.key.generation?.parties} Threshold Raccoon key, provisioned to every participant.
          </p>
          {wallet.key.fingerprint && (
            <p className="text-xs text-subtle">
              Key fingerprint: <span className="font-mono">{short(wallet.key.fingerprint)}</span> — compare with other participants out of band.
            </p>
          )}
          <p className="text-xs">
            {holdsCurrent ? `This device holds share #${heldShare!.partyIndex}.` : local.data?.storeUnlocked === false && local.data.storeExists ? 'Unlock to check this device’s share.' : 'This device does not hold a share of the current key.'}
          </p>
        </div>
      )}

      {(status === 'not_initialized' || status === 'failed' || status === 'rekey_required') && (
        <div className="mt-2 text-sm">
          {status === 'failed' && wallet.key.generation && (
            <p className="mb-2 text-[13px] text-muted">Last attempt failed: {wallet.key.generation.failureReason.replaceAll('_', ' ')}. No key was activated.</p>
          )}
          {status === 'rekey_required' && <p className="mb-2 text-[13px] text-muted">Participants changed after the key was generated, so it no longer matches the wallet.</p>}
          {isOwner ? (
            <>
              <p className="text-[13px] text-muted">
                Generates a {wallet.policy.requiredApprovals}-of-{wallet.policy.activeParticipants} key. Your device acts as the trusted dealer: it briefly holds the master secret, sends each
                participant only their own encrypted share, then discards it. Every participant must be online to finish.
              </p>
              <Button className="mt-3" size="sm" loading={busy === 'start'} disabled={busy !== null} onClick={() => void start()}>
                Start key generation
              </Button>
            </>
          ) : (
            <p className="text-[13px] text-muted">Waiting for the owner to start key generation.</p>
          )}
        </div>
      )}

      {open && kg && (
        <div className="mt-2 text-sm">
          <p className="text-[13px] text-muted">
            {kg.threshold}-of-{kg.parties} · membership v{kg.membershipVersion} · dealer: {nameOf(kg.dealerParticipantId)} · expires {fmtDateTime(kg.expiresAt)}
          </p>
          <ul aria-label="Key generation progress" className="mt-2 space-y-0.5 text-xs">
            {kg.participants.map((p) => (
              <li key={p.participantId}>
                #{p.partyIndex} {nameOf(p.participantId)}
                {p.participantId === wallet.me.id ? ' (you)' : ''}:{' '}
                {p.provisioned ? 'share received' : kg.status === 'awaiting_provisioning' ? 'awaiting share' : p.keyRegistered ? 'device ready' : 'waiting for device'}
              </li>
            ))}
          </ul>
          {safety.data && (
            <p className="mt-2 text-xs">
              Safety number: <span className="font-mono">{safety.data}</span> — all participants should see the same number.
            </p>
          )}

          {kg.status === 'collecting_keys' && mine && !mine.keyRegistered && (
            <>
              {passwordGate}
              {!storeLocked && (
                <Button className="mt-3" size="sm" loading={busy === 'prepare'} disabled={busy !== null} onClick={() => void prepare()}>
                  Prepare this device
                </Button>
              )}
            </>
          )}
          {kg.status === 'collecting_keys' && mine?.keyRegistered && <p className="mt-2 text-[13px] text-muted">Waiting for {kg.parties - kg.keysRegistered} more participant(s) to prepare their device.</p>}

          {kg.status === 'dealing' &&
            (iAmDealer ? (
              <Button className="mt-3" size="sm" loading={busy === 'deal'} disabled={busy !== null} onClick={() => void deal()}>
                Generate and distribute shares
              </Button>
            ) : (
              <p className="mt-2 text-[13px] text-muted">Waiting for the dealer to generate and distribute shares.</p>
            ))}

          {kg.status === 'awaiting_provisioning' && mine && !mine.provisioned && (
            <>
              {passwordGate}
              {!storeLocked && (
                <Button className="mt-3" size="sm" loading={busy === 'receive'} disabled={busy !== null} onClick={() => void receive()}>
                  Receive my share
                </Button>
              )}
            </>
          )}
          {kg.status === 'awaiting_provisioning' && mine?.provisioned && (
            <p className="mt-2 text-[13px] text-muted">
              Your share is stored. {kg.parties - kg.provisioned} participant(s) still need to receive theirs; the key is not initialized until all do.
            </p>
          )}

          {iAmDealer && (
            <Button className="mt-3" size="sm" variant="secondary" loading={busy === 'cancel'} disabled={busy !== null} onClick={() => void cancel()}>
              Cancel key generation
            </Button>
          )}
        </div>
      )}
      <InlineError message={error} />
    </Card>
  );
}
