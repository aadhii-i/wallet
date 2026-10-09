'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { AlertTriangle, KeyRound, Laptop, Lock, ShieldCheck, Smartphone } from 'lucide-react';
import { checkPasswordStrength } from '@qd/wallet-core';
import { getApi } from '@/lib/api';
import { toast, useSession } from '@/lib/store';
import { reportEvent } from '@/lib/sync';
import { vault, VaultClientError } from '@/lib/vault-client';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/spinner';
import { PasswordInput, PhraseGrid, StrengthMeter } from '@/features/onboarding/shared';
import { t } from '@/components/ui/motion';

export default function SecurityPage() {
  const [reveal, setReveal] = useState(false);
  const [changePw, setChangePw] = useState(false);
  const backedUp = useSession((s) => s.backedUp);

  return (
    <>
      <h1 className="mb-1 mt-2 text-2xl font-bold">Security & privacy</h1>
      <p className="mb-6 text-muted">Manage your recovery phrase, password and signed-in devices.</p>

      <Card>
        <div className="flex items-start gap-3">
          <IconBubble tone={backedUp ? 'primary' : 'warning'}>{backedUp ? <ShieldCheck size={20} /> : <AlertTriangle size={20} />}</IconBubble>
          <div className="flex-1">
            <h2 className="font-semibold">Recovery phrase</h2>
            <p className="text-sm text-muted">{backedUp ? 'Backed up. Keep it offline and private.' : 'Not backed up yet. Back it up to avoid losing access.'}</p>
          </div>
        </div>
        <Button variant="secondary" block className="mt-4" onClick={() => setReveal(true)}>
          <KeyRound size={18} /> Reveal recovery phrase
        </Button>
      </Card>

      <Card>
        <div className="flex items-start gap-3">
          <IconBubble tone="primary">
            <Lock size={20} />
          </IconBubble>
          <div className="flex-1">
            <h2 className="font-semibold">Password</h2>
            <p className="text-sm text-muted">Unlocks QD Wallet on this device.</p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setChangePw(true)}>
            Change
          </Button>
        </div>
      </Card>

      <Devices />
      <Events />

      <RevealSheet open={reveal} onOpenChange={setReveal} />
      <ChangePasswordSheet open={changePw} onOpenChange={setChangePw} />
    </>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="mb-4 rounded-2xl border border-line bg-surface p-4">{children}</section>;
}

function IconBubble({ children, tone }: { children: React.ReactNode; tone: 'primary' | 'warning' }) {
  return <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${tone === 'primary' ? 'bg-primary-soft text-primary' : 'bg-warning-soft text-warning'}`}>{children}</span>;
}

function RevealSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [pw, setPw] = useState('');
  const [words, setWords] = useState<string[] | null>(null);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setPw('');
      setWords(null);
      setShown(false);
      setError(null);
    }
  }, [open]);

  // Auto-hide after 60 s.
  useEffect(() => {
    if (!words) return;
    const id = setTimeout(() => onOpenChange(false), 60_000);
    return () => clearTimeout(id);
  }, [words, onOpenChange]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Reveal recovery phrase">
      {!words ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const phrase = await vault.call('revealPhrase', { password: pw });
              setPw('');
              setWords(phrase.split(' '));
              void reportEvent('phrase_revealed');
            } catch (err) {
              setError(err instanceof VaultClientError && err.code === 'TOO_MANY_ATTEMPTS' ? err.message : 'Incorrect password');
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="mb-4 rounded-xl bg-danger-soft p-3 text-sm">
            <strong>Never share your recovery phrase.</strong> Anyone with it can steal your funds. QD Wallet support will never ask for it.
          </div>
          <PasswordInput id="reveal-pw" label="Enter your password to continue" value={pw} onChange={setPw} autoFocus autoComplete="current-password" error={error} />
          <Button type="submit" block size="lg" disabled={!pw} loading={busy} loadingText="Checking…">
            Continue
          </Button>
        </form>
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={t.base}>
          <div className="relative mb-4">
            <PhraseGrid words={words} revealed={shown} />
            {!shown && (
              <button type="button" onClick={() => setShown(true)} className="absolute inset-0 flex items-center justify-center font-semibold">
                Tap to reveal
              </button>
            )}
          </div>
          <p className="text-center text-xs text-muted">This will hide automatically in 60 seconds.</p>
        </motion.div>
      )}
    </Sheet>
  );
}

function ChangePasswordSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [oldPw, setOld] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) {
      setOld('');
      setPw('');
      setPw2('');
      setError(null);
    }
  }, [open]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Change password">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await vault.call('changePassword', { oldPassword: oldPw, newPassword: pw });
            toast.success('Password changed');
            onOpenChange(false);
          } catch {
            setError('Current password is incorrect');
          } finally {
            setBusy(false);
          }
        }}
      >
        <PasswordInput id="old-pw" label="Current password" value={oldPw} onChange={setOld} autoComplete="current-password" error={error} autoFocus />
        <PasswordInput id="new-pw" label="New password" value={pw} onChange={setPw} />
        <StrengthMeter password={pw} />
        <PasswordInput id="new-pw2" label="Confirm new password" value={pw2} onChange={setPw2} error={pw2 && pw !== pw2 ? 'Passwords don’t match' : null} />
        <Button type="submit" block size="lg" disabled={!oldPw || !checkPasswordStrength(pw).ok || pw !== pw2} loading={busy} loadingText="Re-encrypting…">
          Change password
        </Button>
      </form>
    </Sheet>
  );
}

function Devices() {
  const online = useSession((s) => s.apiOnline);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['devices'], enabled: online, queryFn: async () => (await (await getApi()).devices()).devices, retry: 1 });
  return (
    <Card>
      <h2 className="mb-3 font-semibold">Signed-in devices</h2>
      {!online ? (
        <p className="text-sm text-muted">Unavailable while QD services are unreachable.</p>
      ) : q.isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-muted">Couldn’t load devices.</p>
      ) : (
        <ul className="divide-y divide-line">
          {q.data?.filter((d) => !d.revokedAt).map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-3">
              <span className="text-muted">{d.platform === 'web' ? <Laptop size={20} /> : <Smartphone size={20} />}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {d.label} {d.current && <span className="ml-1 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">This device</span>}
                </span>
                <span className="block text-xs text-subtle">Last active {new Date(d.lastSeenAt).toLocaleString()}</span>
              </span>
              {!d.current && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onClick={async () => {
                    try {
                      await (await getApi()).revokeDevice(d.id);
                      toast.success('Device signed out');
                      void qc.invalidateQueries({ queryKey: ['devices'] });
                    } catch {
                      toast.error('Couldn’t sign out device');
                    }
                  }}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const EVENT_LABELS: Record<string, string> = {
  new_device_registered: 'New device registered',
  login: 'Signed in',
  device_revoked: 'Device signed out',
  refresh_token_reuse: 'Suspicious session reuse blocked',
  phrase_revealed: 'Recovery phrase revealed',
  unlock_failed_burst: 'Multiple failed unlock attempts',
  wallet_created: 'Wallet created',
  wallet_imported: 'Wallet imported',
  backup_verified: 'Backup verified',
  wallet_wiped: 'Wallet removed from device',
};

function Events() {
  const online = useSession((s) => s.apiOnline);
  const q = useQuery({ queryKey: ['security-events'], enabled: online, queryFn: async () => (await (await getApi()).securityEvents()).events, retry: 1 });
  if (!online) return null;
  return (
    <Card>
      <h2 className="mb-3 font-semibold">Recent security activity</h2>
      {q.isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : (q.data ?? []).length === 0 ? (
        <p className="text-sm text-muted">No events yet.</p>
      ) : (
        <ul className="space-y-2.5">
          {q.data!.slice(0, 10).map((e) => (
            <li key={e.id} className="flex items-center gap-3 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${e.severity === 'critical' ? 'bg-danger' : e.severity === 'warning' ? 'bg-warning' : 'bg-primary'}`} />
              <span className="flex-1">{EVENT_LABELS[e.type] ?? e.type}</span>
              <span className="text-xs text-subtle">{new Date(e.createdAt).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
