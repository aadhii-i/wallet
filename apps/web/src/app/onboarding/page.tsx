'use client';
import Link from 'next/link';
import { motion } from 'motion/react';
import { KeyRound, ShieldCheck, Sparkles } from 'lucide-react';
import { useVaultGate } from '@/lib/gate';
import { OnboardingFrame } from '@/features/onboarding/shared';
import { t } from '@/components/ui/motion';

export default function Welcome() {
  const { ready } = useVaultGate('no-vault');
  if (!ready) return null;
  return (
    <OnboardingFrame>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={t.base} className="flex flex-1 flex-col">
        <div className="relative mx-auto mb-10 mt-6 flex h-40 w-40 items-center justify-center">
          <motion.div className="absolute inset-0 rounded-[40px] bg-gradient-to-br from-[#2DDBC8] to-[#7C5CFF] opacity-90" animate={{ rotate: [0, 4, -4, 0] }} transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }} />
          <div className="absolute inset-3 rounded-[32px] bg-canvas/85 backdrop-blur" />
          <ShieldCheck size={64} className="relative text-primary" strokeWidth={1.6} />
        </div>
        <h1 className="text-center text-3xl font-bold tracking-tight">Welcome to QD Wallet</h1>
        <p className="mx-auto mt-3 max-w-xs text-center text-muted">A self-custody wallet for Ethereum and EVM networks. Only you control your keys.</p>
        <ul className="mx-auto mt-8 space-y-3 text-sm">
          <li className="flex items-center gap-3">
            <KeyRound size={18} className="text-primary" /> Keys are created and stay on this device
          </li>
          <li className="flex items-center gap-3">
            <Sparkles size={18} className="text-primary" /> Clear, verified transaction reviews
          </li>
        </ul>
        <div className="mt-auto space-y-3 pt-10">
          <Link href="/onboarding/create" className="flex h-13 w-full items-center justify-center rounded-full bg-primary font-semibold text-on-primary hover:bg-primary-hover">
            Create a new wallet
          </Link>
          <Link href="/onboarding/import" className="flex h-13 w-full items-center justify-center rounded-full border border-line-strong bg-surface font-semibold hover:bg-surface-hover">
            I have a recovery phrase
          </Link>
          <p className="pt-2 text-center text-xs text-subtle">QD Wallet never sees your recovery phrase or keys.</p>
        </div>
      </motion.div>
    </OnboardingFrame>
  );
}
