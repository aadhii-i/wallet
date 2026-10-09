'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { EyeOff, Lock, ShieldAlert } from 'lucide-react';
import { checkPasswordStrength } from '@qd/wallet-core';
import { useVaultGate } from '@/lib/gate';
import { useMeta, useSession, toast } from '@/lib/store';
import { reportEvent } from '@/lib/sync';
import { vault } from '@/lib/vault-client';
import { Button } from '@/components/ui/button';
import { OnboardingFrame, PasswordInput, StrengthMeter } from '@/features/onboarding/shared';
import { stepVariants, t } from '@/components/ui/motion';

const POINTS = [
  { icon: Lock, title: 'Your recovery phrase is your wallet', body: '12 secret words that can restore your wallet on any device. Anyone who has them can take your funds.' },
  { icon: EyeOff, title: 'Keep it offline and private', body: 'Write it down on paper. Never type it into a website, share it, or store it in screenshots or cloud notes.' },
  { icon: ShieldAlert, title: 'We can’t recover it for you', body: 'QD Wallet never has your phrase. If you lose it and this device, your funds cannot be recovered.' },
];

export default function CreateWallet() {
  const { ready } = useVaultGate('no-vault-or-unlocked');
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [understood, setUnderstood] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const strength = checkPasswordStrength(pw);
  const mismatch = pw2.length > 0 && pw !== pw2;

  if (!ready) return null;

  const create = async () => {
    setBusy(true);
    try {
      const { address } = await vault.call('create', { password: pw, words: 12 });
      useMeta.getState().reset();
      useMeta.getState().setAccounts([{ index: 0, name: 'Account 1', address }]);
      useSession.getState().set({ status: 'unlocked', backedUp: false });
      void reportEvent('wallet_created');
      router.replace('/onboarding/backup');
    } catch {
      toast.error('Couldn’t create wallet', 'Please try again.');
      setBusy(false);
    }
  };

  return (
    <OnboardingFrame step={step} total={4}>
      <AnimatePresence mode="wait" custom={1} initial={false}>
        {step === 1 ? (
          <motion.div key="1" custom={1} variants={stepVariants} initial="enter" animate="center" exit="exit" transition={t.base} className="flex flex-1 flex-col">
            <h1 className="text-2xl font-bold">Before you start</h1>
            <p className="mt-1 text-muted">Three things every self-custody wallet owner should know.</p>
            <ul className="mt-6 space-y-3">
              {POINTS.map((p, i) => (
                <motion.li key={p.title} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...t.base, delay: 0.08 * i }} className="flex gap-4 rounded-2xl border border-line bg-surface p-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
                    <p.icon size={20} />
                  </span>
                  <span>
                    <span className="block font-semibold">{p.title}</span>
                    <span className="block text-sm text-muted">{p.body}</span>
                  </span>
                </motion.li>
              ))}
            </ul>
            <label className="mt-6 flex cursor-pointer items-start gap-3 text-sm">
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-0.5 h-5 w-5 accent-[var(--qd-primary)]" />
              I understand that QD Wallet cannot recover my recovery phrase.
            </label>
            <div className="mt-auto pt-8">
              <Button block size="lg" disabled={!understood} onClick={() => setStep(2)}>
                Continue
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.form
            key="2"
            custom={1}
            variants={stepVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={t.base}
            className="flex flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              if (strength.ok && pw === pw2) void create();
            }}
          >
            <h1 className="text-2xl font-bold">Create a password</h1>
            <p className="mb-6 mt-1 text-muted">This unlocks QD Wallet on this device only. It can’t be used to recover your wallet.</p>
            <PasswordInput id="pw" label="New password" value={pw} onChange={setPw} autoFocus />
            <StrengthMeter password={pw} />
            <PasswordInput id="pw2" label="Confirm password" value={pw2} onChange={setPw2} error={mismatch ? 'Passwords don’t match' : null} />
            <div className="mt-auto pt-8">
              <Button type="submit" block size="lg" disabled={!strength.ok || pw !== pw2} loading={busy} loadingText="Creating your wallet…">
                Create wallet
              </Button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </OnboardingFrame>
  );
}
