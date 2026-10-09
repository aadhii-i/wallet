'use client';
import { useState } from 'react';
import { motion } from 'motion/react';
import { Eye, EyeOff } from 'lucide-react';
import { checkPasswordStrength } from '@qd/wallet-core';
import { Logo } from '@/components/wallet/logo';
import { t } from '@/components/ui/motion';

export function OnboardingFrame({ children, step, total }: { children: React.ReactNode; step?: number; total?: number }) {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-6">
      <div className="flex w-full max-w-[440px] items-center justify-between">
        <Logo />
        {step !== undefined && total !== undefined && (
          <div className="flex gap-1.5" aria-label={`Step ${step} of ${total}`}>
            {Array.from({ length: total }, (_, i) => (
              <motion.span key={i} className="h-1.5 rounded-full bg-primary" animate={{ width: i + 1 === step ? 20 : 6, opacity: i + 1 <= step ? 1 : 0.25 }} transition={t.base} />
            ))}
          </div>
        )}
      </div>
      <main className="flex w-full max-w-[440px] flex-1 flex-col pt-8">{children}</main>
    </div>
  );
}

export function PasswordInput({
  id,
  label,
  value,
  onChange,
  autoFocus,
  error,
  autoComplete = 'new-password',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  error?: string | null;
  autoComplete?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="mb-3">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <div className={`flex items-center rounded-xl border bg-surface pr-1 transition-colors focus-within:border-primary ${error ? 'border-danger' : 'border-line-strong'}`}>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
          className="h-12 min-w-0 flex-1 bg-transparent px-4 outline-none"
        />
        <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-subtle hover:text-ink">
          {show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {error && (
        <p id={`${id}-err`} className="mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function StrengthMeter({ password }: { password: string }) {
  const s = checkPasswordStrength(password);
  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
  const colors = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-primary', 'bg-success'];
  if (!password) return <div className="mb-3 h-5" />;
  return (
    <div className="mb-3" aria-live="polite">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <motion.span key={i} className={`h-1 flex-1 rounded-full ${i <= s.score ? colors[s.score] : 'bg-line'}`} layout transition={t.fast} />
        ))}
      </div>
      <p className="mt-1 text-xs text-muted">
        {labels[s.score]}
        {s.hint ? ` · ${s.hint}` : ''}
      </p>
    </div>
  );
}

/** Numbered recovery phrase grid; blurred until the user deliberately reveals it. */
export function PhraseGrid({ words, revealed }: { words: string[]; revealed: boolean }) {
  return (
    <ol className={`grid grid-cols-3 gap-2 transition-[filter] duration-300 ${revealed ? '' : 'phrase-blur'}`} aria-hidden={!revealed}>
      {words.map((w, i) => (
        <li key={i} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-sm">
          <span className="tabular w-5 text-right text-xs text-subtle">{i + 1}.</span>
          <span className="font-mono font-medium">{w}</span>
        </li>
      ))}
    </ol>
  );
}
