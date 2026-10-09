'use client';
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Copy } from 'lucide-react';
import { identiconSeed } from '@qd/ui';
import { toast } from '@/lib/store';
import { t } from './motion';

/** Original deterministic identicon: 5×5 mirrored grid on a two-hue gradient. */
export function Identicon({ address, size = 32 }: { address: string; size?: number }) {
  const { hues, rotation, cells } = identiconSeed(address);
  const id = `g${address.slice(2, 10)}`;
  const rects: React.ReactNode[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      if (!cells[row * 3 + col]) continue;
      const xs = col === 2 ? [2] : [col, 4 - col];
      for (const x of xs) rects.push(<rect key={`${row}-${x}`} x={x * 4 + 2} y={row * 4 + 2} width={4} height={4} rx={1} fill="rgba(255,255,255,0.78)" />);
    }
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0 rounded-full" aria-hidden>
      <defs>
        <linearGradient id={id} gradientTransform={`rotate(${rotation} 0.5 0.5)`}>
          <stop offset="0%" stopColor={`hsl(${hues[0]} 70% 50%)`} />
          <stop offset="100%" stopColor={`hsl(${hues[1]} 75% 42%)`} />
        </linearGradient>
      </defs>
      <rect width="24" height="24" fill={`url(#${id})`} />
      {rects}
    </svg>
  );
}

export function shortAddress(a: string, head = 6, tail = 4): string {
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/**
 * Full address in 4-char chunks with first/last chunks emphasized, so users
 * compare the whole thing (threats T10/T11).
 */
export function ChunkedAddress({ address, className = '' }: { address: string; className?: string }) {
  const body = address.slice(2);
  const chunks = body.match(/.{1,4}/g) ?? [];
  return (
    <span className={`font-mono text-[13px] leading-6 tracking-tight ${className}`} aria-label={address}>
      <span className="text-subtle">0x</span>
      {chunks.map((c, i) => (
        <span key={i}>
          {/* Each 4-char group stays whole; lines only break between groups. */}
          <span className={`inline-block whitespace-nowrap ${i === 0 || i === chunks.length - 1 ? 'font-semibold text-ink' : 'text-muted'}`}>{c}</span>
          {i < chunks.length - 1 ? ' ' : ''}
        </span>
      ))}
    </span>
  );
}

export function CopyButton({ value, label = 'Copy address', toastText = 'Address copied', className = '' }: { value: string; label?: string; toastText?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      whileTap={{ scale: 0.9 }}
      transition={t.instant}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-ink ${className}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success(toastText);
          navigator.vibrate?.(10);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error('Couldn’t copy', 'Your browser blocked clipboard access.');
        }
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={copied ? 'y' : 'n'} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={t.fast}>
          {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

const TOKEN_HUES: Record<string, number> = { ETH: 230, SepoliaETH: 260, USDC: 212, USDT: 160, DAI: 40, POL: 275 };

export function TokenIcon({ symbol, size = 40 }: { symbol: string; size?: number }) {
  const hue = TOKEN_HUES[symbol] ?? [...symbol].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, fontSize: size * 0.36, background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 70% 40%))` }}
    >
      {symbol.replace(/^Sepolia/, '').slice(0, 1)}
    </span>
  );
}
