'use client';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { useVaultGate } from '@/lib/gate';
import { Button } from '@/components/ui/button';
import { OnboardingFrame } from '@/features/onboarding/shared';
import { t } from '@/components/ui/motion';

export default function Done() {
  const { ready } = useVaultGate('unlocked');
  const router = useRouter();
  if (!ready) return null;
  return (
    <OnboardingFrame>
      <div className="flex flex-1 flex-col items-center pt-10 text-center">
        <motion.div initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={t.emphasis} className="relative mb-8 flex h-28 w-28 items-center justify-center rounded-full bg-success text-white">
          {[0, 1, 2].map((i) => (
            <motion.span key={i} className="absolute inset-0 rounded-full border-2 border-success" initial={{ scale: 1, opacity: 0.6 }} animate={{ scale: 1.8, opacity: 0 }} transition={{ duration: 1.4, delay: 0.3 + i * 0.25, ease: 'easeOut' }} />
          ))}
          <svg viewBox="0 0 24 24" width="52" height="52">
            <motion.path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.4, delay: 0.2 }} />
          </svg>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...t.base, delay: 0.2 }}>
          <h1 className="text-3xl font-bold">Your wallet is ready</h1>
          <p className="mx-auto mt-3 max-w-xs text-muted">Keep your recovery phrase safe. QD Wallet will never ask for it.</p>
        </motion.div>
        <div className="mt-auto w-full pt-10">
          <Button block size="lg" onClick={() => router.replace('/home')}>
            Open wallet
          </Button>
        </div>
      </div>
    </OnboardingFrame>
  );
}
