'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { Eye, PenLine } from 'lucide-react';
import { bip39EnglishWordlist, pickVerificationIndexes } from '@qd/wallet-core';
import { useVaultGate } from '@/lib/gate';
import { toast, useSession } from '@/lib/store';
import { reportEvent } from '@/lib/sync';
import { vault } from '@/lib/vault-client';
import { Button } from '@/components/ui/button';
import { OnboardingFrame, PhraseGrid } from '@/features/onboarding/shared';
import { stepVariants, t } from '@/components/ui/motion';

type Step = 'reveal' | 'verify';

export default function Backup() {
  const { ready } = useVaultGate('unlocked');
  const router = useRouter();
  const [words, setWords] = useState<string[] | null>(null);
  const [step, setStep] = useState<Step>('reveal');
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!ready) return;
    vault
      .call('getBackupPhrase')
      .then((p) => setWords(p.split(' ')))
      .catch(() => router.replace('/home'));
    // Drop the phrase from React state when leaving the page.
    return () => setWords(null);
  }, [ready, router]);

  if (!ready || !words) return null;

  return (
    <OnboardingFrame step={step === 'reveal' ? 3 : 4} total={4}>
      <AnimatePresence mode="wait" custom={1} initial={false}>
        {step === 'reveal' ? (
          <motion.div key="r" custom={1} variants={stepVariants} initial="enter" animate="center" exit="exit" transition={t.base} className="flex flex-1 flex-col">
            <h1 className="text-2xl font-bold">Write down your recovery phrase</h1>
            <p className="mb-6 mt-1 text-muted">Write these {words.length} words on paper, in order, and keep them somewhere safe. Don’t take a screenshot.</p>
            <div className="relative">
              <PhraseGrid words={words} revealed={revealed} />
              {!revealed && (
                <button
                  type="button"
                  onClick={() => setRevealed(true)}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl text-center"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-elevated shadow-lg">
                    <Eye size={22} />
                  </span>
                  <span className="font-semibold">Tap to reveal</span>
                  <span className="text-xs text-muted">Make sure no one is watching your screen</span>
                </button>
              )}
            </div>
            <div className="mt-auto space-y-2 pt-8">
              <Button block size="lg" disabled={!revealed} onClick={() => setStep('verify')}>
                <PenLine size={18} /> I wrote it down
              </Button>
              <Button block variant="ghost" onClick={() => router.replace('/home')}>
                Remind me later
              </Button>
            </div>
          </motion.div>
        ) : (
          <Verify
            key="v"
            words={words}
            onBack={() => setStep('reveal')}
            onDone={async () => {
              await vault.call('markBackedUp');
              useSession.getState().set({ backedUp: true });
              void reportEvent('backup_verified');
              setWords(null);
              router.replace('/onboarding/done');
            }}
          />
        )}
      </AnimatePresence>
    </OnboardingFrame>
  );
}

function Verify({ words, onBack, onDone }: { words: string[]; onBack: () => void; onDone: () => void }) {
  const indexes = useMemo(() => pickVerificationIndexes(words.length, 3), [words.length]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [shake, setShake] = useState(0);

  const options = useMemo(() => {
    const out: Record<number, string[]> = {};
    for (const i of indexes) {
      const set = new Set([words[i]!]);
      const buf = new Uint32Array(1);
      while (set.size < 4) {
        crypto.getRandomValues(buf);
        set.add(bip39EnglishWordlist[buf[0]! % bip39EnglishWordlist.length]!);
      }
      out[i] = [...set].sort();
    }
    return out;
  }, [indexes, words]);

  const complete = indexes.every((i) => answers[i]);
  const check = () => {
    if (indexes.every((i) => answers[i] === words[i])) onDone();
    else {
      setShake((s) => s + 1);
      toast.error('That’s not quite right', 'Check your written phrase and try again.');
      setAnswers({});
    }
  };

  return (
    <motion.div custom={1} variants={stepVariants} initial="enter" animate="center" exit="exit" transition={t.base} className="flex flex-1 flex-col">
      <h1 className="text-2xl font-bold">Confirm your recovery phrase</h1>
      <p className="mb-6 mt-1 text-muted">Select the missing words to confirm you saved them correctly.</p>
      <motion.div key={shake} animate={shake ? { x: [0, -4, 4, -4, 0] } : {}} transition={{ duration: 0.3 }} className="space-y-5">
        {indexes.map((i) => (
          <fieldset key={i}>
            <legend className="mb-2 text-sm font-semibold">Word #{i + 1}</legend>
            <div className="grid grid-cols-2 gap-2">
              {options[i]!.map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={answers[i] === w}
                  onClick={() => setAnswers((a) => ({ ...a, [i]: w }))}
                  className={`rounded-xl border px-3 py-2.5 font-mono text-sm transition-colors ${answers[i] === w ? 'border-primary bg-primary-soft font-semibold' : 'border-line bg-surface hover:bg-surface-hover'}`}
                >
                  {w}
                </button>
              ))}
            </div>
          </fieldset>
        ))}
      </motion.div>
      <div className="mt-auto space-y-2 pt-8">
        <Button block size="lg" disabled={!complete} onClick={check}>
          Confirm
        </Button>
        <Button block variant="ghost" onClick={onBack}>
          Show phrase again
        </Button>
      </div>
    </motion.div>
  );
}
