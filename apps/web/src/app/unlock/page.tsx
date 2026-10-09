'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'motion/react';
import { useVaultGate, refreshVaultStatus } from '@/lib/gate';
import { useMeta, useSession } from '@/lib/store';
import { reportEvent } from '@/lib/sync';
import { vault, VaultClientError } from '@/lib/vault-client';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Logo } from '@/components/wallet/logo';
import { PasswordInput } from '@/features/onboarding/shared';
import { t } from '@/components/ui/motion';
import { forgetDevice } from '@/lib/api';

function Unlock() {
  const { ready } = useVaultGate('locked');
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [resetOpen, setResetOpen] = useState(false);
  const [fails, setFails] = useState(0);

  useEffect(() => {
    void vault.call('status').then((s) => setLockedUntil(s.lockedUntil));
  }, []);
  useEffect(() => {
    if (lockedUntil <= now) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [lockedUntil, now]);

  if (!ready) return null;
  const waiting = lockedUntil > now;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw || waiting) return;
    setBusy(true);
    setError(null);
    try {
      await vault.call('unlock', { password: pw });
      setPw('');
      useSession.getState().set({ status: 'unlocked' });
      await refreshVaultStatus();
      await vault.call('setAutoLock', { minutes: useMeta.getState().autoLockMinutes });
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/home');
    } catch (err) {
      const code = err instanceof VaultClientError ? err.code : 'INTERNAL';
      setError(code === 'WRONG_PASSWORD' ? 'Incorrect password' : code === 'TOO_MANY_ATTEMPTS' ? 'Too many attempts. Please wait.' : 'Couldn’t unlock. Try again.');
      setShake((s) => s + 1);
      setFails((f) => {
        if (f + 1 === 5) void reportEvent('unlock_failed_burst');
        return f + 1;
      });
      const s = await vault.call('status');
      setLockedUntil(s.lockedUntil);
      setNow(Date.now());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <motion.form onSubmit={submit} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={t.base} className="flex w-full max-w-[400px] flex-1 flex-col">
        <div className="mb-10 mt-8 flex flex-col items-center text-center">
          <Logo size={56} withText={false} />
          <h1 className="mt-6 text-3xl font-bold">Welcome back</h1>
          <p className="mt-2 text-muted">Unlock to continue</p>
        </div>
        <motion.div key={shake} animate={shake ? { x: [0, -6, 6, -4, 4, 0] } : {}} transition={{ duration: 0.35 }}>
          <PasswordInput id="unlock-pw" label="Password" value={pw} onChange={setPw} autoFocus autoComplete="current-password" error={error} />
        </motion.div>
        {waiting && <p className="text-sm text-muted">Try again in {Math.ceil((lockedUntil - now) / 1000)}s</p>}
        <div className="mt-6">
          <Button type="submit" block size="lg" disabled={!pw || waiting} loading={busy} loadingText="Unlocking…">
            Unlock
          </Button>
        </div>
        <button type="button" onClick={() => setResetOpen(true)} className="mx-auto mt-auto pt-10 text-sm font-medium text-primary hover:underline">
          Forgot password? Restore with recovery phrase
        </button>
        {fails >= 3 && <p className="mt-2 text-center text-xs text-subtle">QD Wallet can’t reset your password. You can restore with your recovery phrase.</p>}
      </motion.form>
      <ResetSheet open={resetOpen} onOpenChange={setResetOpen} />
    </div>
  );
}

function ResetSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Restore wallet" description="This removes the wallet from this device. You’ll need your recovery phrase to restore it. Without it, your funds are lost.">
      <label htmlFor="wipe-confirm" className="mb-2 block text-sm">
        Type <strong>RESTORE</strong> to continue
      </label>
      <input id="wipe-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="mb-4 h-12 w-full rounded-xl border border-line-strong bg-surface px-4 outline-none focus:border-primary" autoComplete="off" />
      <Button
        variant="danger"
        block
        size="lg"
        disabled={confirm !== 'RESTORE'}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await forgetDevice();
          await vault.call('wipe');
          useMeta.getState().reset();
          useSession.getState().set({ status: 'no-vault' });
          router.replace('/onboarding/import');
        }}
      >
        Remove wallet and restore
      </Button>
    </Sheet>
  );
}

export default function UnlockPage() {
  return (
    <Suspense>
      <Unlock />
    </Suspense>
  );
}
