'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { checkPasswordStrength, isBip39Word, suggestWords, validateMnemonic } from '@qd/wallet-core';
import { discoverAccounts } from '@qd/evm';
import { useVaultGate } from '@/lib/gate';
import { getAdapter } from '@/lib/chains';
import { useMeta, useSession, toast } from '@/lib/store';
import { reportEvent } from '@/lib/sync';
import { vault } from '@/lib/vault-client';
import { Button } from '@/components/ui/button';
import { OnboardingFrame, PasswordInput, StrengthMeter } from '@/features/onboarding/shared';
import { stepVariants, t } from '@/components/ui/motion';

/**
 * Import flow (spec §3.2). The phrase is validated locally, handed to the
 * KeyWorker, and cleared from component state immediately after.
 */
export default function ImportWallet() {
  const { ready } = useVaultGate('no-vault-or-unlocked');
  const router = useRouter();
  const [count, setCount] = useState<12 | 24>(12);
  const [words, setWords] = useState<string[]>(Array(12).fill(''));
  const [focus, setFocus] = useState<number | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  if (!ready) return null;

  const phrase = words.map((w) => w.trim().toLowerCase()).join(' ');
  const validation = words.every((w) => w.trim()) ? validateMnemonic(phrase) : null;

  const setWord = (i: number, v: string) => {
    const parts = v.trim().split(/\s+/);
    if (parts.length > 1) {
      // Pasting the whole phrase into any cell distributes it.
      const n = parts.length > 12 ? 24 : 12;
      setCount(n as 12 | 24);
      setWords(Array.from({ length: n }, (_, k) => (parts[k] ?? '').toLowerCase()));
      return;
    }
    setWords((ws) => ws.map((w, k) => (k === i ? v.replace(/\s/g, '').toLowerCase() : w)));
  };

  const doImport = async () => {
    setBusy('Encrypting your wallet…');
    try {
      const { address } = await vault.call('import', { mnemonic: phrase, password: pw });
      setWords(Array(count).fill(''));
      useMeta.getState().reset();
      useMeta.getState().setAccounts([{ index: 0, name: 'Account 1', address }]);
      setBusy('Looking for your accounts…');
      try {
        const adapter = getAdapter(useMeta.getState().networkId, useMeta.getState().customRpc[useMeta.getState().networkId]);
        const addresses = await vault.call('addresses', { indexes: Array.from({ length: 20 }, (_, i) => i) });
        const used = await Promise.race([
          discoverAccounts([adapter], (i) => addresses[i]!, { max: 20 }),
          new Promise<number[]>((resolve) => setTimeout(() => resolve([0]), 8000)),
        ]);
        useMeta.getState().setAccounts(used.map((i) => ({ index: i, name: `Account ${i + 1}`, address: addresses[i]! })));
      } catch {
        /* discovery is best-effort */
      }
      useSession.getState().set({ status: 'unlocked', backedUp: true });
      void reportEvent('wallet_imported');
      router.replace('/onboarding/done');
    } catch {
      toast.error('Couldn’t import wallet', 'Check your recovery phrase and try again.');
      setBusy(null);
    }
  };

  const errorText =
    validation && !validation.ok
      ? validation.reason === 'checksum'
        ? 'This isn’t a valid recovery phrase. Check the word order and spelling.'
        : validation.reason === 'unknown_words'
          ? 'Some words aren’t in the recovery phrase word list.'
          : 'Enter all the words.'
      : null;

  return (
    <OnboardingFrame step={step} total={2}>
      <AnimatePresence mode="wait" custom={1} initial={false}>
        {step === 1 ? (
          <motion.div key="1" custom={1} variants={stepVariants} initial="enter" animate="center" exit="exit" transition={t.base} className="flex flex-1 flex-col">
            <h1 className="text-2xl font-bold">Import with recovery phrase</h1>
            <p className="mb-4 mt-1 text-muted">Enter your phrase. It is checked on this device and never sent anywhere.</p>
            <div className="mb-4 inline-flex self-start rounded-full bg-sunken p-1 text-sm" role="radiogroup" aria-label="Phrase length">
              {([12, 24] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={count === n}
                  onClick={() => {
                    setCount(n);
                    setWords((ws) => Array.from({ length: n }, (_, i) => ws[i] ?? ''));
                  }}
                  className={`relative rounded-full px-4 py-1.5 font-medium ${count === n ? 'text-ink' : 'text-muted'}`}
                >
                  {count === n && <motion.span layoutId="len" className="absolute inset-0 rounded-full bg-elevated shadow" transition={t.snappy} />}
                  <span className="relative">{n} words</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {words.map((w, i) => {
                const bad = w.length > 0 && focus !== i && !isBip39Word(w);
                const suggestions = focus === i ? suggestWords(w, 3).filter((s) => s !== w) : [];
                return (
                  <div key={i} className="relative">
                    <label className={`flex items-center gap-1.5 rounded-xl border bg-surface px-2 py-2 focus-within:border-primary ${bad ? 'border-danger' : 'border-line'}`}>
                      <span className="tabular w-5 text-right text-xs text-subtle">{i + 1}.</span>
                      <input
                        ref={(el) => {
                          inputs.current[i] = el;
                        }}
                        type="password"
                        value={w}
                        onFocus={() => setFocus(i)}
                        onBlur={() => setTimeout(() => setFocus((f) => (f === i ? null : f)), 120)}
                        onChange={(e) => setWord(i, e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.key === ' ' || e.key === 'Enter') && w) {
                            e.preventDefault();
                            inputs.current[i + 1]?.focus();
                          }
                        }}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        aria-label={`Word ${i + 1}`}
                        aria-invalid={bad}
                        className="w-full min-w-0 bg-transparent font-mono text-sm outline-none"
                      />
                    </label>
                    {suggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-line bg-elevated shadow-lg">
                        {suggestions.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setWord(i, s);
                              inputs.current[i + 1]?.focus();
                            }}
                            className="block w-full px-3 py-1.5 text-left font-mono text-sm hover:bg-surface-hover"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-3 min-h-5 text-sm text-danger" aria-live="polite">
              {errorText}
            </p>
            <div className="mt-auto pt-6">
              <Button block size="lg" disabled={!validation?.ok} onClick={() => setStep(2)}>
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
              if (checkPasswordStrength(pw).ok && pw === pw2) void doImport();
            }}
          >
            <h1 className="text-2xl font-bold">Create a password</h1>
            <p className="mb-6 mt-1 text-muted">Used to unlock QD Wallet on this device.</p>
            <PasswordInput id="pw" label="New password" value={pw} onChange={setPw} autoFocus />
            <StrengthMeter password={pw} />
            <PasswordInput id="pw2" label="Confirm password" value={pw2} onChange={setPw2} error={pw2 && pw !== pw2 ? 'Passwords don’t match' : null} />
            <div className="mt-auto pt-8">
              <Button type="submit" block size="lg" disabled={!checkPasswordStrength(pw).ok || pw !== pw2} loading={!!busy} loadingText={busy ?? undefined}>
                Import wallet
              </Button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </OnboardingFrame>
  );
}
